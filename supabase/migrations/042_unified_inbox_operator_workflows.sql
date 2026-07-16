-- 042_unified_inbox_operator_workflows.sql
-- Phase 22 (UIX-04 / UIX-05): the durable operator-workflow layer on top of Phase 21's
-- conversation/message model. Everything an operator does to organize and act on a
-- conversation is a tenant-owned, organization-scoped DATABASE row — never browser state:
--
--   inbox_labels                — org-owned labels (case-insensitive unique name)
--   inbox_conversation_labels   — conversation <-> label join
--   inbox_reminders             — per-conversation, per-user due reminders
--   inbox_snippets              — org-owned reusable reply snippets/macros
--   inbox_send_commands         — durable, restart-safe reply/forward send commands
--                                 (lease token/expiry, bounded attempts, stable idempotency
--                                 key, scheduling, policy code, resulting message/email links)
--   inbox_attachments           — attachment METADATA + a private Supabase Storage object
--                                 reference (NO base64 blobs in Postgres)
--
-- Plus two additive archive columns on the Phase 21 outreach_conversations table
-- (archived_at / archived_by_user_id). Archive is ORTHOGONAL to the Phase 21 open/closed
-- status vocabulary — the status CHECK is left untouched so the read API's status filter
-- is unaffected.
--
-- Tenant safety mirrors Phase 21/19: every table carries organization_id even when it is
-- reachable through another row, and cross-tenant links are blocked in the DATABASE (not
-- only in access.ts) via composite (id, organization_id) foreign keys. Background workers
-- carry organization scope from the claimed row and revalidate ownership before side
-- effects; RLS below is defense-in-depth only (the app role bypasses RLS).
--
-- Manual production apply (never Drizzle generate/push):
--   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/042_unified_inbox_operator_workflows.sql
--
-- Idempotent where practical: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- constraints guarded by name, CHECK constraints replaced by stable name, policies dropped
-- before create, and the storage bucket upserted only when a `storage` schema exists.

BEGIN;

-- ============================================================
-- outreach_conversations — additive archive state (orthogonal to open/closed status)
-- ============================================================
ALTER TABLE public.outreach_conversations
    ADD COLUMN IF NOT EXISTS archived_at timestamp;
ALTER TABLE public.outreach_conversations
    ADD COLUMN IF NOT EXISTS archived_by_user_id uuid;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_archived_by_user_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_archived_by_user_fkey
            FOREIGN KEY (archived_by_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
    END IF;
END $$;

-- Archived-scan index, tenant-leading, newest first, only the archived rows.
CREATE INDEX IF NOT EXISTS idx_outreach_conversations_archived
    ON public.outreach_conversations (organization_id, archived_at DESC)
    WHERE archived_at IS NOT NULL;

-- ============================================================
-- inbox_labels — org-owned labels
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_labels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    name text NOT NULL,
    color text,
    created_by_user_id uuid,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_labels'::regclass
          AND conname = 'inbox_labels_organization_fkey'
    ) THEN
        ALTER TABLE public.inbox_labels
            ADD CONSTRAINT inbox_labels_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_labels'::regclass
          AND conname = 'inbox_labels_created_by_user_fkey'
    ) THEN
        ALTER TABLE public.inbox_labels
            ADD CONSTRAINT inbox_labels_created_by_user_fkey
            FOREIGN KEY (created_by_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE public.inbox_labels
    DROP CONSTRAINT IF EXISTS inbox_labels_name_check;
ALTER TABLE public.inbox_labels
    ADD CONSTRAINT inbox_labels_name_check
    CHECK (length(btrim(name)) > 0 AND length(name) <= 80);

-- Composite unique so the conversation-label join can bind (label_id, organization_id) and
-- never cross a tenant boundary.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_labels'::regclass
          AND conname = 'inbox_labels_id_organization_unique'
    ) THEN
        ALTER TABLE public.inbox_labels
            ADD CONSTRAINT inbox_labels_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- Case-insensitive label-name uniqueness within an organization.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_labels_org_name_ci_unique
    ON public.inbox_labels (organization_id, lower(name));

-- ============================================================
-- inbox_conversation_labels — conversation <-> label join
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_conversation_labels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    label_id uuid NOT NULL,
    created_by_user_id uuid,
    created_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_conversation_labels'::regclass
          AND conname = 'inbox_conversation_labels_organization_fkey'
    ) THEN
        ALTER TABLE public.inbox_conversation_labels
            ADD CONSTRAINT inbox_conversation_labels_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

-- Deleting a conversation removes its labels; deleting a label removes only the JOIN row,
-- never the conversation (that is why the join binds to the label by composite key with
-- ON DELETE CASCADE, and the conversation FK cascades independently).
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_conversation_labels'::regclass
          AND conname = 'inbox_conversation_labels_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_conversation_labels
            ADD CONSTRAINT inbox_conversation_labels_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_conversation_labels'::regclass
          AND conname = 'inbox_conversation_labels_label_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_conversation_labels
            ADD CONSTRAINT inbox_conversation_labels_label_org_fkey
            FOREIGN KEY (label_id, organization_id)
            REFERENCES public.inbox_labels (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

-- One label per conversation (idempotent attach).
CREATE UNIQUE INDEX IF NOT EXISTS inbox_conversation_labels_unique
    ON public.inbox_conversation_labels (organization_id, conversation_id, label_id);

-- Reverse lookup: which conversations carry a label (for the label filter).
CREATE INDEX IF NOT EXISTS idx_inbox_conversation_labels_label
    ON public.inbox_conversation_labels (organization_id, label_id);

-- ============================================================
-- inbox_reminders — per-conversation, per-user due reminders
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    remind_at timestamp NOT NULL,
    note text,
    status text NOT NULL DEFAULT 'scheduled',
    notified_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_reminders'::regclass
          AND conname = 'inbox_reminders_organization_fkey'
    ) THEN
        ALTER TABLE public.inbox_reminders
            ADD CONSTRAINT inbox_reminders_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_reminders'::regclass
          AND conname = 'inbox_reminders_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_reminders
            ADD CONSTRAINT inbox_reminders_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_reminders'::regclass
          AND conname = 'inbox_reminders_user_fkey'
    ) THEN
        ALTER TABLE public.inbox_reminders
            ADD CONSTRAINT inbox_reminders_user_fkey
            FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;
    END IF;
END $$;

ALTER TABLE public.inbox_reminders
    DROP CONSTRAINT IF EXISTS inbox_reminders_status_check;
ALTER TABLE public.inbox_reminders
    ADD CONSTRAINT inbox_reminders_status_check
    CHECK (status IN ('scheduled', 'notified', 'cancelled', 'done'));

ALTER TABLE public.inbox_reminders
    DROP CONSTRAINT IF EXISTS inbox_reminders_notified_requires_timestamp;
ALTER TABLE public.inbox_reminders
    ADD CONSTRAINT inbox_reminders_notified_requires_timestamp
    CHECK (status <> 'notified' OR notified_at IS NOT NULL);

-- Due-reminder claim: scheduled rows, oldest first. Partial so notified/cancelled/done
-- history does not inflate the claimer's scan.
CREATE INDEX IF NOT EXISTS idx_inbox_reminders_due
    ON public.inbox_reminders (remind_at)
    WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_inbox_reminders_conversation
    ON public.inbox_reminders (organization_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_inbox_reminders_user
    ON public.inbox_reminders (organization_id, user_id, status);

-- ============================================================
-- inbox_snippets — org-owned reusable reply snippets/macros
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_snippets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    created_by_user_id uuid,
    name text NOT NULL,
    body text NOT NULL,
    shortcut text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_snippets'::regclass
          AND conname = 'inbox_snippets_organization_fkey'
    ) THEN
        ALTER TABLE public.inbox_snippets
            ADD CONSTRAINT inbox_snippets_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_snippets'::regclass
          AND conname = 'inbox_snippets_created_by_user_fkey'
    ) THEN
        ALTER TABLE public.inbox_snippets
            ADD CONSTRAINT inbox_snippets_created_by_user_fkey
            FOREIGN KEY (created_by_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE public.inbox_snippets
    DROP CONSTRAINT IF EXISTS inbox_snippets_name_check;
ALTER TABLE public.inbox_snippets
    ADD CONSTRAINT inbox_snippets_name_check
    CHECK (length(btrim(name)) > 0 AND length(name) <= 120);

-- Case-insensitive snippet-name uniqueness within an organization.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_snippets_org_name_ci_unique
    ON public.inbox_snippets (organization_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_inbox_snippets_org
    ON public.inbox_snippets (organization_id, name);

-- ============================================================
-- inbox_send_commands — durable, restart-safe reply/forward commands
-- ============================================================
CREATE TABLE IF NOT EXISTS public.inbox_send_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    email_account_id uuid NOT NULL,
    -- The conversation message being replied to / forwarded (nullable for a brand-new thread).
    source_message_id uuid,

    mode text NOT NULL,
    -- Explicit recipient SNAPSHOTS: [{ address, name? }]. Frozen at creation so a retried
    -- send goes to exactly who the operator chose, independent of later thread mutation.
    to_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    cc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    bcc_recipients jsonb NOT NULL DEFAULT '[]'::jsonb,

    subject text,
    body_text text,
    body_html text,
    -- Threading header snapshots so a retry stays in-thread.
    in_reply_to text,
    message_references text,
    -- Attachment references (inbox_attachments ids). Metadata-only; bytes live in Storage.
    attachment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,

    status text NOT NULL DEFAULT 'scheduled',
    -- When the operator wants it sent (NULL = immediate). due_at is the claim key.
    scheduled_at timestamp,
    due_at timestamp NOT NULL DEFAULT now(),

    -- Lease + bounded attempts, exactly like the Phase 18 dispatcher / Phase 21 materializer.
    lease_token uuid,
    lease_expires_at timestamp,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 8,
    last_error text,
    last_policy_code text,

    -- Stable idempotency key handed straight to the durable dispatcher, so a re-execution
    -- after a crash collapses onto the same outreach_emails row and never resends.
    idempotency_key text NOT NULL,

    -- Result links (both nullable; the unified message is materialized asynchronously).
    resulting_conversation_message_id uuid,
    resulting_outreach_email_id uuid,

    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_organization_fkey'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_account_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_account_org_fkey
            FOREIGN KEY (email_account_id, organization_id)
            REFERENCES public.email_accounts (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_actor_user_fkey'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_actor_user_fkey
            FOREIGN KEY (actor_user_id) REFERENCES public.users (id) ON DELETE CASCADE;
    END IF;
END $$;

-- Source message removal must NOT delete the command (audit survives): null the link.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_source_message_org_fkey'
    ) THEN
        -- Column-list SET NULL (PG15+) nulls ONLY source_message_id, never the NOT NULL
        -- organization_id, so removing a message keeps the command (audit) intact.
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_source_message_org_fkey
            FOREIGN KEY (source_message_id, organization_id)
            REFERENCES public.outreach_conversation_messages (id, organization_id)
            ON DELETE SET NULL (source_message_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_result_email_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_result_email_org_fkey
            FOREIGN KEY (resulting_outreach_email_id, organization_id)
            REFERENCES public.outreach_emails (id, organization_id)
            ON DELETE SET NULL (resulting_outreach_email_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_result_message_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_result_message_org_fkey
            FOREIGN KEY (resulting_conversation_message_id, organization_id)
            REFERENCES public.outreach_conversation_messages (id, organization_id)
            ON DELETE SET NULL (resulting_conversation_message_id);
    END IF;
END $$;

ALTER TABLE public.inbox_send_commands
    DROP CONSTRAINT IF EXISTS inbox_send_commands_mode_check;
ALTER TABLE public.inbox_send_commands
    ADD CONSTRAINT inbox_send_commands_mode_check
    CHECK (mode IN ('reply', 'reply_all', 'forward'));

ALTER TABLE public.inbox_send_commands
    DROP CONSTRAINT IF EXISTS inbox_send_commands_status_check;
ALTER TABLE public.inbox_send_commands
    ADD CONSTRAINT inbox_send_commands_status_check
    CHECK (status IN ('draft', 'scheduled', 'queued', 'sending', 'sent', 'failed', 'cancelled', 'held'));

-- Lease token and expiry are set and cleared together, like the 038/039/041 leases.
ALTER TABLE public.inbox_send_commands
    DROP CONSTRAINT IF EXISTS inbox_send_commands_lease_check;
ALTER TABLE public.inbox_send_commands
    ADD CONSTRAINT inbox_send_commands_lease_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));

ALTER TABLE public.inbox_send_commands
    DROP CONSTRAINT IF EXISTS inbox_send_commands_attempts_check;
ALTER TABLE public.inbox_send_commands
    ADD CONSTRAINT inbox_send_commands_attempts_check
    CHECK (attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts);

ALTER TABLE public.inbox_send_commands
    DROP CONSTRAINT IF EXISTS inbox_send_commands_idempotency_key_check;
ALTER TABLE public.inbox_send_commands
    ADD CONSTRAINT inbox_send_commands_idempotency_key_check
    CHECK (length(btrim(idempotency_key)) > 0);

-- Composite unique so attachments can bind (send_command_id, organization_id) tenant-safely.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_send_commands'::regclass
          AND conname = 'inbox_send_commands_id_organization_unique'
    ) THEN
        ALTER TABLE public.inbox_send_commands
            ADD CONSTRAINT inbox_send_commands_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- One command per (organization, idempotency_key) — the durable double-submit guard.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_send_commands_org_idempotency_unique
    ON public.inbox_send_commands (organization_id, idempotency_key);

-- The claim queue: due, actionable commands, oldest first. Partial so terminal history does
-- not inflate it. A partial index cannot reference now(), so the claim query filters expired
-- leases and due_at at runtime; this index bounds the scan to live work.
CREATE INDEX IF NOT EXISTS idx_inbox_send_commands_due
    ON public.inbox_send_commands (due_at)
    WHERE status IN ('scheduled', 'queued', 'sending');

CREATE INDEX IF NOT EXISTS idx_inbox_send_commands_conversation
    ON public.inbox_send_commands (organization_id, conversation_id, status);

-- ============================================================
-- inbox_attachments — attachment metadata + private Storage object reference
-- ============================================================
-- Binary bytes are NEVER stored here (no bytea column). Each row references one object in a
-- private Supabase Storage bucket via (storage_bucket, storage_path); the object path is
-- organization/command scoped and never public.
CREATE TABLE IF NOT EXISTS public.inbox_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    -- Nullable: an attachment can be uploaded before its send command is finalized.
    send_command_id uuid,
    created_by_user_id uuid,

    storage_bucket text NOT NULL DEFAULT 'inbox-attachments',
    storage_path text NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0,
    checksum text,
    status text NOT NULL DEFAULT 'pending',

    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_attachments'::regclass
          AND conname = 'inbox_attachments_organization_fkey'
    ) THEN
        ALTER TABLE public.inbox_attachments
            ADD CONSTRAINT inbox_attachments_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_attachments'::regclass
          AND conname = 'inbox_attachments_send_command_org_fkey'
    ) THEN
        ALTER TABLE public.inbox_attachments
            ADD CONSTRAINT inbox_attachments_send_command_org_fkey
            FOREIGN KEY (send_command_id, organization_id)
            REFERENCES public.inbox_send_commands (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.inbox_attachments'::regclass
          AND conname = 'inbox_attachments_created_by_user_fkey'
    ) THEN
        ALTER TABLE public.inbox_attachments
            ADD CONSTRAINT inbox_attachments_created_by_user_fkey
            FOREIGN KEY (created_by_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE public.inbox_attachments
    DROP CONSTRAINT IF EXISTS inbox_attachments_status_check;
ALTER TABLE public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_status_check
    CHECK (status IN ('pending', 'ready', 'failed', 'deleted'));

-- Per-file size bound (25 MiB) enforced at the database as a floor of defense; the service
-- also enforces count/aggregate/MIME/extension. size 0 is allowed until finalize sets it.
ALTER TABLE public.inbox_attachments
    DROP CONSTRAINT IF EXISTS inbox_attachments_size_check;
ALTER TABLE public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_size_check
    CHECK (size_bytes >= 0 AND size_bytes <= 26214400);

ALTER TABLE public.inbox_attachments
    DROP CONSTRAINT IF EXISTS inbox_attachments_path_check;
ALTER TABLE public.inbox_attachments
    ADD CONSTRAINT inbox_attachments_path_check
    CHECK (length(btrim(storage_path)) > 0 AND length(btrim(storage_bucket)) > 0);

-- One row per stored object — two rows cannot claim the same bucket/path.
CREATE UNIQUE INDEX IF NOT EXISTS inbox_attachments_object_unique
    ON public.inbox_attachments (storage_bucket, storage_path);

CREATE INDEX IF NOT EXISTS idx_inbox_attachments_command
    ON public.inbox_attachments (organization_id, send_command_id);

-- Orphan-cleanup scan: pending/deleted rows by age.
CREATE INDEX IF NOT EXISTS idx_inbox_attachments_status
    ON public.inbox_attachments (status, created_at);

-- ============================================================
-- Private Supabase Storage bucket (configured only where a storage schema exists)
-- ============================================================
-- Idempotently ensure ONE private bucket. Guarded on schema existence so the migration is a
-- safe no-op on a database (e.g. the disposable test container) that has no `storage` schema.
-- public = false is asserted on every apply so a bucket can never drift to public.
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage')
       AND EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'storage' AND table_name = 'buckets'
       ) THEN
        INSERT INTO storage.buckets (id, name, public)
        VALUES ('inbox-attachments', 'inbox-attachments', false)
        ON CONFLICT (id) DO UPDATE SET public = false;
    END IF;
END $$;

-- ============================================================
-- RLS — defense-in-depth only (the app role bypasses RLS; JS is the real boundary)
-- ============================================================
ALTER TABLE public.inbox_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_conversation_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_snippets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_send_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_labels_select ON public.inbox_labels;
CREATE POLICY inbox_labels_select ON public.inbox_labels FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS inbox_conversation_labels_select ON public.inbox_conversation_labels;
CREATE POLICY inbox_conversation_labels_select ON public.inbox_conversation_labels FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS inbox_reminders_select ON public.inbox_reminders;
CREATE POLICY inbox_reminders_select ON public.inbox_reminders FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS inbox_snippets_select ON public.inbox_snippets;
CREATE POLICY inbox_snippets_select ON public.inbox_snippets FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS inbox_send_commands_select ON public.inbox_send_commands;
CREATE POLICY inbox_send_commands_select ON public.inbox_send_commands FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS inbox_attachments_select ON public.inbox_attachments;
CREATE POLICY inbox_attachments_select ON public.inbox_attachments FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
