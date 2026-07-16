-- 039_outreach_provider_events.sql
-- Phase 19 (PROV-04): provider-neutral inbound staging for outreach.
--
-- Why this exists:
--   Reply and bounce processing both scanned the same INBOX and used user-visible
--   read state as their cursor. The reply job could mark a DSN \Seen (or isRead)
--   first, after which the bounce job — which only looks at unread mail — never saw
--   it, so a hard bounce was silently consumed as a reply. Read/unread is a human's
--   state, not a pipeline's; it is also mutable from any mail client.
--
--   Every inbound provider item now normalizes into one durable event row keyed by
--   (organization_id, email_account_id, provider, provider_message_id) and is
--   classified exactly once BEFORE any side effect. Reply and bounce consumers read
--   that shared classification, so they cannot race. Ingestion progress lives in
--   outreach_provider_cursors instead of in flags the user can flip.
--
-- Phase 21 consumes these rows to materialize conversation messages rather than
-- re-polling providers, which is why full bodies and attachment metadata are retained.
--
-- Manual production apply (never Drizzle generate/push):
--   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/039_outreach_provider_events.sql
--
-- Idempotent where practical: CREATE TABLE/INDEX IF NOT EXISTS, constraints replaced
-- by stable name, policies dropped before create.

BEGIN;

-- ============================================================
-- Tenant binding prerequisite
-- ============================================================
-- The composite FKs below bind an event/cursor to an account AND that account's
-- organization in one referenced key, so a row cannot claim an account owned by
-- another tenant even if application code passes a mismatched pair. That requires
-- a unique key on the referenced (id, organization_id) pair. `id` is already the
-- primary key, so this constraint adds no new restriction on email_accounts — it
-- only makes the pair referenceable.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.email_accounts'::regclass
          AND conname = 'email_accounts_id_organization_unique'
    ) THEN
        ALTER TABLE public.email_accounts
            ADD CONSTRAINT email_accounts_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- ============================================================
-- outreach_provider_cursors — bounded, resumable ingestion state
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_provider_cursors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    email_account_id uuid NOT NULL,
    -- Mirrors email_accounts.provider ('smtp' | 'outlook' | 'native'). Held as text
    -- with a CHECK rather than the email_provider enum: the enum's 'native' member
    -- arrived in migration 032, so typing these columns to it would couple this table
    -- to enum evolution for no gain. The CHECK documents the same domain.
    provider text NOT NULL,

    -- Outlook: opaque Graph @odata.deltaLink. Never parsed, only replayed.
    delta_cursor text,

    -- IMAP: UIDVALIDITY guards the high-water mark. If the server changes it, UIDs
    -- are renumbered and last_uid becomes meaningless — the reader must reset rather
    -- than skip mail it never actually saw.
    uid_validity bigint,
    last_uid bigint,

    -- Native: received_at plus a provider-message-id tie breaker, because multiple
    -- rows can share a timestamp and a timestamp alone would either re-read or skip them.
    last_received_at timestamp,
    last_provider_message_id text,

    -- Single-flight lease, same shape as the 038 dispatch lease.
    lease_token uuid,
    lease_expires_at timestamp,

    last_success_at timestamp,
    last_error text,
    last_error_at timestamp,
    retry_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_provider_cursors'::regclass
          AND conname = 'outreach_provider_cursors_account_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_provider_cursors
            ADD CONSTRAINT outreach_provider_cursors_account_org_fkey
            FOREIGN KEY (email_account_id, organization_id)
            REFERENCES public.email_accounts (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_provider_cursors'::regclass
          AND conname = 'outreach_provider_cursors_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_provider_cursors
            ADD CONSTRAINT outreach_provider_cursors_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

ALTER TABLE public.outreach_provider_cursors
    DROP CONSTRAINT IF EXISTS outreach_provider_cursors_provider_check;
ALTER TABLE public.outreach_provider_cursors
    ADD CONSTRAINT outreach_provider_cursors_provider_check
    CHECK (provider IN ('smtp', 'outlook', 'native'));

-- A high-water UID without UIDVALIDITY cannot be interpreted safely.
ALTER TABLE public.outreach_provider_cursors
    DROP CONSTRAINT IF EXISTS outreach_provider_cursors_uid_state_check;
ALTER TABLE public.outreach_provider_cursors
    ADD CONSTRAINT outreach_provider_cursors_uid_state_check
    CHECK (last_uid IS NULL OR uid_validity IS NOT NULL);

ALTER TABLE public.outreach_provider_cursors
    DROP CONSTRAINT IF EXISTS outreach_provider_cursors_lease_check;
ALTER TABLE public.outreach_provider_cursors
    ADD CONSTRAINT outreach_provider_cursors_lease_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));

-- One cursor per account per provider: the ingestion progress of an account is a
-- single fact, and a duplicate would let two readers advance independently.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_provider_cursors_account_provider_unique
    ON public.outreach_provider_cursors (organization_id, email_account_id, provider);

CREATE INDEX IF NOT EXISTS idx_outreach_provider_cursors_due
    ON public.outreach_provider_cursors (retry_at)
    WHERE retry_at IS NOT NULL;

-- ============================================================
-- outreach_provider_events — one durable row per inbound provider item
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_provider_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    email_account_id uuid NOT NULL,
    provider text NOT NULL,
    -- Provider-side stable identity: native mail_messages.id, IMAP uidvalidity:uid,
    -- Graph message id. Together with the account this is the dedupe key.
    provider_message_id text NOT NULL,

    -- Internet headers used for outreach matching (not provider-scoped).
    message_id text,
    in_reply_to text,
    message_references text,

    -- Decided exactly once, in DSN → auto-reply → human-reply → other order.
    classification text NOT NULL,

    from_address text,
    to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
    cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
    subject text,

    -- Retained for Phase 21 conversation materialization and for
    -- campaign_leads.last_reply_text, which was previously left NULL.
    text_body text,
    html_body text,
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Provider attachment metadata only: id, name, mime type, size, inline flag,
    -- content id. Binary blobs are deliberately deferred (Phase 22 owns them).
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,

    received_at timestamp NOT NULL,
    processed_at timestamp,
    processing_error text,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_provider_events'::regclass
          AND conname = 'outreach_provider_events_account_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_provider_events
            ADD CONSTRAINT outreach_provider_events_account_org_fkey
            FOREIGN KEY (email_account_id, organization_id)
            REFERENCES public.email_accounts (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_provider_events'::regclass
          AND conname = 'outreach_provider_events_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_provider_events
            ADD CONSTRAINT outreach_provider_events_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_provider_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_provider_check
    CHECK (provider IN ('smtp', 'outlook', 'native'));

-- 'other' is a first-class outcome, not a failure: unmatched human mail is preserved
-- for Phase 21 instead of being dropped.
ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_classification_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_classification_check
    CHECK (classification IN ('reply', 'bounce', 'auto_reply', 'other'));

-- A blank provider key would collapse every message of an account onto one row.
ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_provider_message_id_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_provider_message_id_check
    CHECK (length(btrim(provider_message_id)) > 0);

-- The dedupe key. ON CONFLICT against this is what makes ingestion idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_provider_events_provider_message_unique
    ON public.outreach_provider_events (organization_id, email_account_id, provider, provider_message_id);

-- The query both consumers run every tick: unprocessed rows of one classification,
-- oldest first. Partial, so processed history does not inflate it.
CREATE INDEX IF NOT EXISTS idx_outreach_provider_events_pending
    ON public.outreach_provider_events (classification, received_at)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_provider_events_org_received
    ON public.outreach_provider_events (organization_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_outreach_provider_events_account_received
    ON public.outreach_provider_events (email_account_id, received_at DESC);

-- Phase 21 threads conversations by internet Message-ID.
CREATE INDEX IF NOT EXISTS idx_outreach_provider_events_message_id
    ON public.outreach_provider_events (organization_id, message_id)
    WHERE message_id IS NOT NULL;

-- ============================================================
-- RLS — defense-in-depth only
-- ============================================================
-- The application connects with the DATABASE_URL role, which BYPASSES RLS. Tenant
-- isolation for these tables is enforced in JS (src/server/lib/access.ts) and by the
-- composite FKs above. These policies exist so a future direct Supabase-client read
-- is not wide open; they are not the boundary. See CLAUDE.md ### Authentication Flow.
--
-- SELECT only: these rows are written exclusively by server-side ingestion jobs, so
-- no authenticated end user has any business inserting or mutating them.
ALTER TABLE public.outreach_provider_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_provider_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_provider_cursors_select ON public.outreach_provider_cursors;
CREATE POLICY outreach_provider_cursors_select ON public.outreach_provider_cursors FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_provider_events_select ON public.outreach_provider_events;
CREATE POLICY outreach_provider_events_select ON public.outreach_provider_events FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
