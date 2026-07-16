-- 041_unified_inbox_foundation.sql
-- Phase 21 (UIF-01): durable, tenant-safe relational foundation for the Unified Inbox.
--
-- Why this exists:
--   Phase 19 (migration 039) already stages every inbound provider item into
--   outreach_provider_events and tracks ingestion progress in
--   outreach_provider_cursors. Phase 21 turns those staged events — plus outbound
--   outreach_emails — into deduplicated, immutable conversation messages with
--   attribution, participants, and per-user read state. It does NOT create a second
--   poller or cursor table; it CONSUMES and EXTENDS the Phase 19 contract.
--
-- Four new tables:
--   outreach_conversations           — org-owned thread summary + attribution
--   outreach_conversation_messages   — immutable normalized message records
--   outreach_conversation_participants — normalized address/role rows per thread
--   outreach_conversation_reads      — per-user last-read state (absence = unread)
--
-- One extension to outreach_provider_events: a materialization lifecycle
--   (materialization_status / lease / attempts / error / materialized_at /
--   conversation_message_id) that is DELIBERATELY INDEPENDENT from Phase 19's
--   processed_at. processed_at records reply/bounce classification side effects;
--   materialization records whether the event has been turned into a conversation
--   message. Reply/bounce classification may complete before OR after inbox
--   materialization, so neither field may ever be reused as the other's claim.
--
-- Tenant safety:
--   Every table carries organization_id even when reachable through another row.
--   Cross-tenant links are blocked in the DATABASE, not only in access.ts, via
--   composite (id, organization_id) foreign keys — the same pattern 039 used to bind
--   an event to an account's organization. A campaign_lead is bound to its campaign
--   via a composite (campaign_lead_id, campaign_id) FK because campaign_leads has no
--   organization_id column; the campaign itself is org-bound, so the chain holds.
--
-- Idempotency: RFC Message-ID is intentionally NOT unique (it is neither globally
--   unique nor trustworthy). The dedupe key is the provider-native identity carried
--   in source_key, unique per (organization_id, email_account_id, source_key).
--
-- Manual production apply (never Drizzle generate/push):
--   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/041_unified_inbox_foundation.sql
--
-- Idempotent where practical: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
--   EXISTS, constraints guarded by name, CHECK constraints replaced by stable name,
--   policies dropped before create.

BEGIN;

-- ============================================================
-- Tenant-binding prerequisites
-- ============================================================
-- Composite FKs below bind a child row to a parent AND that parent's organization in
-- one referenced key, so a row cannot claim a parent owned by another tenant even if
-- application code passes a mismatched pair. That requires a UNIQUE CONSTRAINT (not a
-- bare index) on each referenced pair. `id` is already the primary key of every table
-- here, so these add no new restriction — they only make the pair referenceable.

-- email_accounts (id, organization_id) — already added by 039; ensure it exists so 041
-- is self-sufficient if applied against a database where 039 is present.
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

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.leads'::regclass
          AND conname = 'leads_id_organization_unique'
    ) THEN
        ALTER TABLE public.leads
            ADD CONSTRAINT leads_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.campaigns'::regclass
          AND conname = 'campaigns_id_organization_unique'
    ) THEN
        ALTER TABLE public.campaigns
            ADD CONSTRAINT campaigns_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_emails'::regclass
          AND conname = 'outreach_emails_id_organization_unique'
    ) THEN
        ALTER TABLE public.outreach_emails
            ADD CONSTRAINT outreach_emails_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- campaign_leads has no organization_id, so it is bound to its campaign instead. The
-- campaign is org-bound above, so (campaign_lead -> campaign -> organization) is a
-- closed chain that cannot cross tenants.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.campaign_leads'::regclass
          AND conname = 'campaign_leads_id_campaign_unique'
    ) THEN
        ALTER TABLE public.campaign_leads
            ADD CONSTRAINT campaign_leads_id_campaign_unique UNIQUE (id, campaign_id);
    END IF;
END $$;

-- ============================================================
-- outreach_conversations — org-owned thread summary + attribution
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    email_account_id uuid NOT NULL,

    -- Optional outreach attribution, all within organization_id.
    lead_id uuid,
    campaign_id uuid,
    campaign_lead_id uuid,

    -- Provider thread/conversation id when the provider exposes a trustworthy one.
    provider_thread_id text,
    -- Tenant-unique thread key from the normalizer (provider thread id, root RFC
    -- Message-ID, or a generated UUID for address-only heuristic threads).
    thread_key text NOT NULL,

    normalized_subject text,
    status text NOT NULL DEFAULT 'open',

    -- Denormalized last-message summary for the list view (set after message commit;
    -- the FK is added at the end of this migration to break the creation cycle with
    -- outreach_conversation_messages).
    last_message_id uuid,
    last_message_at timestamp,
    last_inbound_at timestamp,
    last_outbound_at timestamp,
    latest_message_preview text,

    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_account_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_account_org_fkey
            FOREIGN KEY (email_account_id, organization_id)
            REFERENCES public.email_accounts (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_lead_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_lead_org_fkey
            FOREIGN KEY (lead_id, organization_id)
            REFERENCES public.leads (id, organization_id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_campaign_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_campaign_org_fkey
            FOREIGN KEY (campaign_id, organization_id)
            REFERENCES public.campaigns (id, organization_id) ON DELETE SET NULL;
    END IF;
END $$;

-- A campaign_lead may only attach under its own campaign. Combined with the campaign's
-- own org FK above, this prevents attributing an org A conversation to an org B
-- campaign_lead. ON DELETE SET NULL nulls the pair together.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_campaign_lead_campaign_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_campaign_lead_campaign_fkey
            FOREIGN KEY (campaign_lead_id, campaign_id)
            REFERENCES public.campaign_leads (id, campaign_id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE public.outreach_conversations
    DROP CONSTRAINT IF EXISTS outreach_conversations_status_check;
ALTER TABLE public.outreach_conversations
    ADD CONSTRAINT outreach_conversations_status_check
    CHECK (status IN ('open', 'closed'));

-- A blank thread key would collapse unrelated threads onto one conversation.
ALTER TABLE public.outreach_conversations
    DROP CONSTRAINT IF EXISTS outreach_conversations_thread_key_check;
ALTER TABLE public.outreach_conversations
    ADD CONSTRAINT outreach_conversations_thread_key_check
    CHECK (length(btrim(thread_key)) > 0);

-- MATCH SIMPLE skips the composite campaign_lead FK when either column is NULL, so this
-- CHECK makes the pair mandatory whenever a campaign_lead is present.
ALTER TABLE public.outreach_conversations
    DROP CONSTRAINT IF EXISTS outreach_conversations_campaign_lead_requires_campaign;
ALTER TABLE public.outreach_conversations
    ADD CONSTRAINT outreach_conversations_campaign_lead_requires_campaign
    CHECK (campaign_lead_id IS NULL OR campaign_id IS NOT NULL);

-- Composite unique so child tables (messages, participants, reads) and the last-message
-- self reference can bind (id, organization_id) and never cross a tenant boundary.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_id_organization_unique'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- One conversation per tenant thread key.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversations_thread_key_unique
    ON public.outreach_conversations (organization_id, email_account_id, thread_key);

-- List view: newest activity first, tenant-leading.
CREATE INDEX IF NOT EXISTS idx_outreach_conversations_list
    ON public.outreach_conversations (organization_id, last_message_at DESC, id DESC);

-- Account filter.
CREATE INDEX IF NOT EXISTS idx_outreach_conversations_account
    ON public.outreach_conversations (organization_id, email_account_id, last_message_at DESC);

-- Status filter.
CREATE INDEX IF NOT EXISTS idx_outreach_conversations_status
    ON public.outreach_conversations (organization_id, status, last_message_at DESC);

-- Unread scan: conversations with an inbound message, newest first.
CREATE INDEX IF NOT EXISTS idx_outreach_conversations_unread
    ON public.outreach_conversations (organization_id, last_inbound_at DESC)
    WHERE last_inbound_at IS NOT NULL;

-- Attribution lookups.
CREATE INDEX IF NOT EXISTS idx_outreach_conversations_lead
    ON public.outreach_conversations (organization_id, lead_id)
    WHERE lead_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_conversations_campaign
    ON public.outreach_conversations (organization_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

-- ============================================================
-- outreach_conversation_messages — immutable normalized message records
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_conversation_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    email_account_id uuid NOT NULL,

    -- Optional link to the outbound outreach send this message was materialized from.
    outreach_email_id uuid,

    direction text NOT NULL,
    provider text NOT NULL,
    provider_message_id text,
    provider_thread_id text,

    -- Immutable per-account dedupe identity, e.g. native:<uuid>, imap:<uidvalidity>:<uid>,
    -- outlook:<immutable_id>, outreach-email:<uuid>. NEVER the RFC Message-ID.
    source_key text NOT NULL,

    -- RFC 5322 threading fields. Indexed and normalized, but NOT unique.
    internet_message_id text,
    in_reply_to text,
    message_references text,

    subject text,
    from_address text,
    from_name text,
    -- Normalized address arrays: [{ address, name }]. Metadata only.
    to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
    cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
    bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
    reply_to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,

    plain_body text,
    html_body text,
    -- Safe header subset only — never credentials, tokens, or raw auth headers.
    headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Attachment METADATA only (id, name, mime type, size, inline, content id). Binary
    -- bytes are deferred to Phase 22.
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    has_attachments boolean NOT NULL DEFAULT false,

    -- Reuses the Phase 19 classification vocabulary. Outbound messages carry 'other'.
    classification text NOT NULL DEFAULT 'other',
    -- How this message was threaded onto its conversation (auditability of the matcher).
    match_strategy text,
    match_confidence text,

    sent_at timestamp,
    received_at timestamp,
    created_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_messages'::regclass
          AND conname = 'outreach_conversation_messages_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_messages
            ADD CONSTRAINT outreach_conversation_messages_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_messages'::regclass
          AND conname = 'outreach_conversation_messages_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_messages
            ADD CONSTRAINT outreach_conversation_messages_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_messages'::regclass
          AND conname = 'outreach_conversation_messages_account_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_messages
            ADD CONSTRAINT outreach_conversation_messages_account_org_fkey
            FOREIGN KEY (email_account_id, organization_id)
            REFERENCES public.email_accounts (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_messages'::regclass
          AND conname = 'outreach_conversation_messages_outreach_email_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_messages
            ADD CONSTRAINT outreach_conversation_messages_outreach_email_org_fkey
            FOREIGN KEY (outreach_email_id, organization_id)
            REFERENCES public.outreach_emails (id, organization_id) ON DELETE SET NULL;
    END IF;
END $$;

ALTER TABLE public.outreach_conversation_messages
    DROP CONSTRAINT IF EXISTS outreach_conversation_messages_direction_check;
ALTER TABLE public.outreach_conversation_messages
    ADD CONSTRAINT outreach_conversation_messages_direction_check
    CHECK (direction IN ('inbound', 'outbound'));

ALTER TABLE public.outreach_conversation_messages
    DROP CONSTRAINT IF EXISTS outreach_conversation_messages_provider_check;
ALTER TABLE public.outreach_conversation_messages
    ADD CONSTRAINT outreach_conversation_messages_provider_check
    CHECK (provider IN ('smtp', 'outlook', 'native'));

ALTER TABLE public.outreach_conversation_messages
    DROP CONSTRAINT IF EXISTS outreach_conversation_messages_classification_check;
ALTER TABLE public.outreach_conversation_messages
    ADD CONSTRAINT outreach_conversation_messages_classification_check
    CHECK (classification IN ('reply', 'bounce', 'auto_reply', 'other'));

ALTER TABLE public.outreach_conversation_messages
    DROP CONSTRAINT IF EXISTS outreach_conversation_messages_source_key_check;
ALTER TABLE public.outreach_conversation_messages
    ADD CONSTRAINT outreach_conversation_messages_source_key_check
    CHECK (length(btrim(source_key)) > 0);

ALTER TABLE public.outreach_conversation_messages
    DROP CONSTRAINT IF EXISTS outreach_conversation_messages_match_strategy_check;
ALTER TABLE public.outreach_conversation_messages
    ADD CONSTRAINT outreach_conversation_messages_match_strategy_check
    CHECK (
        match_strategy IS NULL
        OR match_strategy IN ('in_reply_to', 'references', 'provider_thread', 'address_heuristic', 'outbound', 'none')
    );

-- Composite unique so the conversation last-message self reference and the provider-event
-- materialized link can bind (id, organization_id) without crossing a tenant boundary.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_messages'::regclass
          AND conname = 'outreach_conversation_messages_id_organization_unique'
    ) THEN
        ALTER TABLE public.outreach_conversation_messages
            ADD CONSTRAINT outreach_conversation_messages_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- THE dedupe key. Provider replay / duplicate RFC Message-IDs cannot create a second
-- normalized message because they resolve to the same source_key.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversation_messages_source_key_unique
    ON public.outreach_conversation_messages (organization_id, email_account_id, source_key);

-- Thread order: COALESCE(received_at, sent_at, created_at) ASC, id ASC, tenant-leading.
CREATE INDEX IF NOT EXISTS idx_outreach_conversation_messages_thread
    ON public.outreach_conversation_messages
    (organization_id, conversation_id, (COALESCE(received_at, sent_at, created_at)), id);

-- RFC Message-ID threading lookup — indexed, scoped, and deliberately NOT unique.
CREATE INDEX IF NOT EXISTS idx_outreach_conversation_messages_internet_message_id
    ON public.outreach_conversation_messages (organization_id, internet_message_id)
    WHERE internet_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_conversation_messages_in_reply_to
    ON public.outreach_conversation_messages (organization_id, in_reply_to)
    WHERE in_reply_to IS NOT NULL;

-- Backfill anti-join (materialize outbound rows whose source_key is not present yet).
CREATE INDEX IF NOT EXISTS idx_outreach_conversation_messages_outreach_email
    ON public.outreach_conversation_messages (organization_id, outreach_email_id)
    WHERE outreach_email_id IS NOT NULL;

-- Now the conversation last-message self reference can be added (both tables exist).
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversations'::regclass
          AND conname = 'outreach_conversations_last_message_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversations
            ADD CONSTRAINT outreach_conversations_last_message_org_fkey
            FOREIGN KEY (last_message_id, organization_id)
            REFERENCES public.outreach_conversation_messages (id, organization_id) ON DELETE SET NULL;
    END IF;
END $$;

-- ============================================================
-- outreach_conversation_participants — normalized address/role rows
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_conversation_participants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    address text NOT NULL,
    name text,
    role text NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_participants'::regclass
          AND conname = 'outreach_conversation_participants_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_participants
            ADD CONSTRAINT outreach_conversation_participants_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_participants'::regclass
          AND conname = 'outreach_conversation_participants_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_participants
            ADD CONSTRAINT outreach_conversation_participants_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

ALTER TABLE public.outreach_conversation_participants
    DROP CONSTRAINT IF EXISTS outreach_conversation_participants_role_check;
ALTER TABLE public.outreach_conversation_participants
    ADD CONSTRAINT outreach_conversation_participants_role_check
    CHECK (role IN ('from', 'to', 'cc', 'bcc', 'reply_to'));

ALTER TABLE public.outreach_conversation_participants
    DROP CONSTRAINT IF EXISTS outreach_conversation_participants_address_check;
ALTER TABLE public.outreach_conversation_participants
    ADD CONSTRAINT outreach_conversation_participants_address_check
    CHECK (length(btrim(address)) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversation_participants_unique
    ON public.outreach_conversation_participants (organization_id, conversation_id, address, role);

-- Address heuristic lookup (same organization, known lead address).
CREATE INDEX IF NOT EXISTS idx_outreach_conversation_participants_address
    ON public.outreach_conversation_participants (organization_id, address);

-- ============================================================
-- outreach_conversation_reads — per-user last-read state
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_conversation_reads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    last_read_message_id uuid,
    last_read_at timestamp DEFAULT now() NOT NULL,
    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_reads'::regclass
          AND conname = 'outreach_conversation_reads_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_reads
            ADD CONSTRAINT outreach_conversation_reads_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_reads'::regclass
          AND conname = 'outreach_conversation_reads_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_reads
            ADD CONSTRAINT outreach_conversation_reads_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_reads'::regclass
          AND conname = 'outreach_conversation_reads_user_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_reads
            ADD CONSTRAINT outreach_conversation_reads_user_fkey
            FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_conversation_reads'::regclass
          AND conname = 'outreach_conversation_reads_last_read_message_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_conversation_reads
            ADD CONSTRAINT outreach_conversation_reads_last_read_message_org_fkey
            FOREIGN KEY (last_read_message_id, organization_id)
            REFERENCES public.outreach_conversation_messages (id, organization_id) ON DELETE SET NULL;
    END IF;
END $$;

-- One read-state row per (organization, conversation, user).
CREATE UNIQUE INDEX IF NOT EXISTS outreach_conversation_reads_unique
    ON public.outreach_conversation_reads (organization_id, conversation_id, user_id);

-- Per-user unread-count scan.
CREATE INDEX IF NOT EXISTS idx_outreach_conversation_reads_user
    ON public.outreach_conversation_reads (organization_id, user_id);

-- ============================================================
-- outreach_provider_events — materialization lifecycle extension
-- ============================================================
-- INDEPENDENT from Phase 19 processed_at. processed_at records reply/bounce
-- classification side effects; these columns record whether the event has become a
-- conversation message. Safe DEFAULTs so existing 039 inserts keep working unchanged.
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS materialization_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS materialization_lease_token uuid;
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS materialization_lease_expires_at timestamp;
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS materialization_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS materialization_error text;
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS materialized_at timestamp;
ALTER TABLE public.outreach_provider_events
    ADD COLUMN IF NOT EXISTS conversation_message_id uuid;

ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_materialization_status_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_materialization_status_check
    CHECK (materialization_status IN ('pending', 'processing', 'materialized', 'failed'));

-- Lease token and expiry are set and cleared together, like the 038/039 leases.
ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_materialization_lease_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_materialization_lease_check
    CHECK ((materialization_lease_token IS NULL) = (materialization_lease_expires_at IS NULL));

ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_materialization_attempts_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_materialization_attempts_check
    CHECK (materialization_attempts >= 0);

-- A materialized event must point at exactly one committed normalized message and carry
-- its materialized_at timestamp — the lifecycle only completes after message commit.
ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_materialized_requires_message;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_materialized_requires_message
    CHECK (
        materialization_status <> 'materialized'
        OR (materialized_at IS NOT NULL AND conversation_message_id IS NOT NULL)
    );

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_provider_events'::regclass
          AND conname = 'outreach_provider_events_conversation_message_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_provider_events
            ADD CONSTRAINT outreach_provider_events_conversation_message_org_fkey
            FOREIGN KEY (conversation_message_id, organization_id)
            REFERENCES public.outreach_conversation_messages (id, organization_id) ON DELETE SET NULL;
    END IF;
END $$;

-- One provider event materializes at most one normalized message, and vice versa.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_provider_events_materialized_message_unique
    ON public.outreach_provider_events (conversation_message_id)
    WHERE conversation_message_id IS NOT NULL;

-- The claim queue: pending or (stale) processing rows, oldest first. Partial so
-- materialized/failed history does not inflate it. Global worker index, like the
-- Phase 19 classification queue — the worker scopes per handler by organization_id.
-- A partial index cannot reference now(), so the claim query filters expired leases.
CREATE INDEX IF NOT EXISTS idx_outreach_provider_events_materialization_claim
    ON public.outreach_provider_events (materialization_status, received_at)
    WHERE materialization_status IN ('pending', 'processing');

-- ============================================================
-- RLS — defense-in-depth only
-- ============================================================
-- The application connects with the DATABASE_URL role, which BYPASSES RLS. Tenant
-- isolation for these tables is enforced in JS (src/server/lib/access.ts and the
-- Phase 20 outreach access helper) and by the composite FKs above. These SELECT
-- policies exist so a future direct Supabase-client read is not wide open; they are
-- NOT the boundary. See CLAUDE.md ### Authentication Flow. Writes (including read-state
-- upserts) happen through the server role, so no end-user INSERT/UPDATE policy is added.
ALTER TABLE public.outreach_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_conversations_select ON public.outreach_conversations;
CREATE POLICY outreach_conversations_select ON public.outreach_conversations FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_conversation_messages_select ON public.outreach_conversation_messages;
CREATE POLICY outreach_conversation_messages_select ON public.outreach_conversation_messages FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_conversation_participants_select ON public.outreach_conversation_participants;
CREATE POLICY outreach_conversation_participants_select ON public.outreach_conversation_participants FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_conversation_reads_select ON public.outreach_conversation_reads;
CREATE POLICY outreach_conversation_reads_select ON public.outreach_conversation_reads FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
