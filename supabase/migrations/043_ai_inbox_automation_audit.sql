-- 043_ai_inbox_automation_audit.sql
-- Phase 23 (AI-01 / AI-03 / AI-05): the data / control / audit FOUNDATION for guarded AI
-- inbox automation. Nothing here sends mail or calls a model — later plans (23-02..04) add the
-- suggestion endpoint, the autonomous processor, and the Xphere adapter. This migration only
-- establishes:
--
--   outreach_ai_settings   — PER-ORGANIZATION AI controls. TWO SEPARATE permissions, BOTH default
--                            OFF after migration + backfill:
--                              draft_assistance_enabled — operator may request an editable AI draft
--                              autonomous_enabled        — AI may hand off an autonomous send command
--                            Plus an IMMEDIATE kill switch (autonomy_paused_at/reason) and an
--                            approved model profile + a per-org autonomous follow-up ceiling.
--   campaigns.ai_autonomous_enabled — PER-CAMPAIGN autonomy opt-in (default OFF, backfilled false).
--   outreach_ai_runs       — the AI-run AUDIT table. Every model call / decision / send links back
--                            to its input MESSAGE REFERENCES + a deterministic context hash, the
--                            prompt version + provider/model + allowlisted parameters, the sanitized
--                            output draft, the delivery-policy result, actor/approval, and the durable
--                            send-command / outreach-email ids. It stores REFERENCES, NEVER secrets:
--                            no API keys, no Authorization headers, and no system prompt / hidden
--                            reasoning (locked decision #5).
--
-- EFFECTIVE AUTONOMY (locked decision #1) is the INTERSECTION, evaluated in JS/queries — the DB
-- stores the inputs, never a single "on" bit:
--     org.autonomous_enabled = true
--     AND campaigns.ai_autonomous_enabled = true
--     AND outreach_ai_settings.autonomy_paused_at IS NULL     (org kill switch clear)
--     AND all Phase 18 delivery-policy / campaign / outreach kill switches clear
-- Draft assistance requires ONLY org.draft_assistance_enabled and never authorizes a send.
--
-- LEGACY COMPATIBILITY: campaigns.agentic_followup_enabled (migration 034) is PRESERVED for a
-- compatible rollout of the old direct-send follow-up path; it is NOT the AI autonomy control and
-- does not participate in the effective-autonomy intersection above. Later plans retire the legacy
-- path (outreach-followup.ts / processFollowUps.ts) in favor of durable send commands.
--
-- Tenant safety mirrors Phase 19/21/22: every table carries organization_id even when reachable
-- through another row, and cross-tenant links are blocked in the DATABASE (not only in access.ts)
-- via composite (id, organization_id) foreign keys. campaign_lead_id is a plain FK because
-- campaign_leads has no organization_id column (its org scope comes through its campaign). RLS below
-- is defense-in-depth only — the app role bypasses RLS, so tenant isolation is enforced in JS.
--
-- Manual production apply (never Drizzle generate/push):
--   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/043_ai_inbox_automation_audit.sql
--
-- Idempotent where practical: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- constraints guarded by name, CHECK constraints replaced by stable name, policies dropped before
-- create. Re-runnable — a partially applied production run is safe to repeat.

BEGIN;

-- ============================================================
-- outreach_ai_settings — per-organization AI controls (BOTH default OFF)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_ai_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,

    -- SEPARATE permission #1: an operator may request an editable AI draft. Never sends.
    draft_assistance_enabled boolean NOT NULL DEFAULT false,
    -- SEPARATE permission #2: AI may convert a valid draft proposal into a durable send command.
    -- This org flag ALONE never authorizes an autonomous send — EFFECTIVE autonomy additionally
    -- requires campaigns.ai_autonomous_enabled AND a clear kill switch AND the Phase 18 policy gate.
    autonomous_enabled boolean NOT NULL DEFAULT false,

    -- IMMEDIATE kill switch (locked decision #7). When set, NO autonomous run may claim or dispatch,
    -- regardless of the two enable flags. Evaluated at claim and again immediately before dispatch.
    autonomy_paused_at timestamp,
    autonomy_paused_reason text,

    -- The model/profile the organization has vetted (nullable until configured).
    model_profile text,
    -- Defense-in-depth ceiling on autonomous follow-ups per conversation.
    max_autonomous_follow_ups integer NOT NULL DEFAULT 2,

    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_settings'::regclass
          AND conname = 'outreach_ai_settings_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_settings
            ADD CONSTRAINT outreach_ai_settings_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

-- Exactly one settings row per organization.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_settings'::regclass
          AND conname = 'outreach_ai_settings_organization_unique'
    ) THEN
        ALTER TABLE public.outreach_ai_settings
            ADD CONSTRAINT outreach_ai_settings_organization_unique UNIQUE (organization_id);
    END IF;
END $$;

ALTER TABLE public.outreach_ai_settings
    DROP CONSTRAINT IF EXISTS outreach_ai_settings_max_follow_ups_check;
ALTER TABLE public.outreach_ai_settings
    ADD CONSTRAINT outreach_ai_settings_max_follow_ups_check
    CHECK (max_autonomous_follow_ups >= 0 AND max_autonomous_follow_ups <= 100);

-- A pause reason may only accompany an active pause (no dangling reason without a paused_at).
ALTER TABLE public.outreach_ai_settings
    DROP CONSTRAINT IF EXISTS outreach_ai_settings_pause_reason_requires_pause;
ALTER TABLE public.outreach_ai_settings
    ADD CONSTRAINT outreach_ai_settings_pause_reason_requires_pause
    CHECK (autonomy_paused_reason IS NULL OR autonomy_paused_at IS NOT NULL);

-- ============================================================
-- campaigns — per-campaign autonomy opt-in (default OFF, backfilled false)
-- ============================================================
-- ADD COLUMN ... NOT NULL DEFAULT false backfills every existing campaign to false, so enabling the
-- feature is an explicit, per-campaign action. Legacy agentic_followup_enabled (034) is untouched.
ALTER TABLE public.campaigns
    ADD COLUMN IF NOT EXISTS ai_autonomous_enabled boolean NOT NULL DEFAULT false;

-- ============================================================
-- outreach_ai_runs — AI-run AUDIT (references + hash, never secrets)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outreach_ai_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,

    -- Scope links. conversation/campaign are composite-org FKs; campaign_lead is a plain FK
    -- because campaign_leads carries no organization_id (its org scope comes through its campaign).
    conversation_id uuid,
    campaign_id uuid,
    campaign_lead_id uuid,

    -- The inbound message that triggered the run (the reply the model answers), and the ORDERED
    -- input message ids the context builder selected + the deterministic SHA-256 context hash.
    -- We store REFERENCES + hash, not the full mail, and reconstruct context under authorization.
    trigger_message_id uuid,
    input_message_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    context_hash text,

    -- Run classification + lifecycle.
    run_kind text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    action text,

    -- Prompt / model provenance (references, never the system prompt or hidden reasoning).
    prompt_version text,
    provider text,
    model text,
    -- Allowlisted, sanitized parameter snapshot (temperature / max tokens / etc). NEVER credentials.
    model_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Sanitized generated output the operator/composer consumes. No chain-of-thought / system prompt.
    output_subject text,
    output_body text,
    output_outcome text,

    -- Delivery-policy result (locked #4/#5): the Phase 18 policy code + optional deferral time.
    policy_code text,
    policy_retry_at timestamp,

    -- Actor / approval (human-in-the-loop). Approval is recorded as a pair.
    actor_user_id uuid,
    approved_by_user_id uuid,
    approved_at timestamp,

    -- Durable send links (the SINGLE dispatch path). Both nullable; set when the run hands off.
    send_command_id uuid,
    outreach_email_id uuid,

    -- Lease + bounded attempts + stable idempotency (locked #4: no hidden retry loop).
    lease_token uuid,
    lease_expires_at timestamp,
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 5,
    idempotency_key text NOT NULL,

    -- Latency / token usage metadata IF the provider returns it (nullable).
    latency_ms integer,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,

    -- Bounded error fields (never a raw provider dump; the service truncates before write).
    error_code text,
    error_detail text,

    created_at timestamp DEFAULT now() NOT NULL,
    updated_at timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_organization_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_organization_fkey
            FOREIGN KEY (organization_id) REFERENCES public.organizations (id) ON DELETE CASCADE;
    END IF;
END $$;

-- Cross-tenant links are blocked in the database. Deleting the referenced row nulls ONLY that
-- link column (PG15+ column-list SET NULL), never the NOT NULL organization_id, so the audit row
-- survives with its remaining references intact.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_conversation_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_conversation_org_fkey
            FOREIGN KEY (conversation_id, organization_id)
            REFERENCES public.outreach_conversations (id, organization_id)
            ON DELETE SET NULL (conversation_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_campaign_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_campaign_org_fkey
            FOREIGN KEY (campaign_id, organization_id)
            REFERENCES public.campaigns (id, organization_id)
            ON DELETE SET NULL (campaign_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_campaign_lead_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_campaign_lead_fkey
            FOREIGN KEY (campaign_lead_id) REFERENCES public.campaign_leads (id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_trigger_message_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_trigger_message_org_fkey
            FOREIGN KEY (trigger_message_id, organization_id)
            REFERENCES public.outreach_conversation_messages (id, organization_id)
            ON DELETE SET NULL (trigger_message_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_send_command_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_send_command_org_fkey
            FOREIGN KEY (send_command_id, organization_id)
            REFERENCES public.inbox_send_commands (id, organization_id)
            ON DELETE SET NULL (send_command_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_outreach_email_org_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_outreach_email_org_fkey
            FOREIGN KEY (outreach_email_id, organization_id)
            REFERENCES public.outreach_emails (id, organization_id)
            ON DELETE SET NULL (outreach_email_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_actor_user_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_actor_user_fkey
            FOREIGN KEY (actor_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_approved_by_user_fkey'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_approved_by_user_fkey
            FOREIGN KEY (approved_by_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
    END IF;
END $$;

-- Strict run kind: draft assistance vs autonomous.
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_kind_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_kind_check
    CHECK (run_kind IN ('draft', 'autonomous'));

-- Strict lifecycle statuses.
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_status_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_status_check
    CHECK (status IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'deferred', 'cancelled'));

-- Strict decision action (the model proposal outcome). NULL until the model responds.
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_action_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_action_check
    CHECK (action IS NULL OR action IN ('draft', 'wait', 'complete', 'escalate', 'none'));

-- Lease token + expiry are set and cleared together (like the 038/041/042 leases).
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_lease_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_lease_check
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));

-- Bounded attempts (locked #4: no hidden retry loop).
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_attempts_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_attempts_check
    CHECK (attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts);

-- Stable idempotency key: the durable double-run guard.
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_idempotency_key_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_idempotency_key_check
    CHECK (length(btrim(idempotency_key)) > 0);

-- Approval is an atomic pair: approver id and time set together or both absent.
ALTER TABLE public.outreach_ai_runs
    DROP CONSTRAINT IF EXISTS outreach_ai_runs_approval_check;
ALTER TABLE public.outreach_ai_runs
    ADD CONSTRAINT outreach_ai_runs_approval_check
    CHECK ((approved_by_user_id IS NULL) = (approved_at IS NULL));

-- Composite unique so a future table can bind (id, organization_id) tenant-safely.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_ai_runs'::regclass
          AND conname = 'outreach_ai_runs_id_organization_unique'
    ) THEN
        ALTER TABLE public.outreach_ai_runs
            ADD CONSTRAINT outreach_ai_runs_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

-- One run per (organization, idempotency_key) — the durable double-submit guard.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_ai_runs_org_idempotency_unique
    ON public.outreach_ai_runs (organization_id, idempotency_key);

-- Claim queue: pending / deferred runs, oldest first. Partial so terminal history does not inflate
-- the claimer's scan. A partial index cannot reference now(), so the claim query filters expired
-- leases and due time at runtime; this index bounds the scan to live work.
CREATE INDEX IF NOT EXISTS idx_outreach_ai_runs_claim
    ON public.outreach_ai_runs (created_at)
    WHERE status IN ('pending', 'deferred');

-- Lease-recovery scan: runs holding a lease, by expiry (find and reclaim expired leases).
CREATE INDEX IF NOT EXISTS idx_outreach_ai_runs_lease
    ON public.outreach_ai_runs (lease_expires_at)
    WHERE lease_token IS NOT NULL;

-- History: org-wide run history, newest first.
CREATE INDEX IF NOT EXISTS idx_outreach_ai_runs_org_created
    ON public.outreach_ai_runs (organization_id, created_at DESC);

-- History: per-conversation audit trail.
CREATE INDEX IF NOT EXISTS idx_outreach_ai_runs_conversation
    ON public.outreach_ai_runs (organization_id, conversation_id, created_at DESC);

-- History: per-campaign audit trail.
CREATE INDEX IF NOT EXISTS idx_outreach_ai_runs_campaign
    ON public.outreach_ai_runs (organization_id, campaign_id, created_at DESC);

-- Linkage lookup: find the run that produced a durable send command.
CREATE INDEX IF NOT EXISTS idx_outreach_ai_runs_send_command
    ON public.outreach_ai_runs (organization_id, send_command_id);

-- ============================================================
-- RLS — defense-in-depth only (the app role bypasses RLS; JS is the real boundary)
-- ============================================================
ALTER TABLE public.outreach_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_ai_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_ai_settings_select ON public.outreach_ai_settings;
CREATE POLICY outreach_ai_settings_select ON public.outreach_ai_settings FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_ai_runs_select ON public.outreach_ai_runs;
CREATE POLICY outreach_ai_runs_select ON public.outreach_ai_runs FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
