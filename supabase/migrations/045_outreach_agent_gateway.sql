-- Phase 25/26: capability-scoped agent credentials, append-only audit and durable events.
-- The application role bypasses RLS, so routes still enforce organization scope in JS.

BEGIN;

CREATE TABLE IF NOT EXISTS public.outreach_agent_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    principal_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
    event_cursor bigint NOT NULL DEFAULT 0,
    expires_at timestamp,
    revoked_at timestamp,
    last_used_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_agent_credentials_key_prefix_unique UNIQUE (key_prefix),
    CONSTRAINT outreach_agent_credentials_key_hash_unique UNIQUE (key_hash),
    CONSTRAINT outreach_agent_credentials_scopes_array CHECK (jsonb_typeof(scopes) = 'array'),
    CONSTRAINT outreach_agent_credentials_event_cursor_non_negative CHECK (event_cursor >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outreach_agent_credentials_organization
    ON public.outreach_agent_credentials (organization_id, created_at DESC);

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS agent_credential_id uuid;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS agent_idempotency_key text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_agent_credential_fk') THEN
        ALTER TABLE public.campaigns
            ADD CONSTRAINT campaigns_agent_credential_fk
            FOREIGN KEY (agent_credential_id) REFERENCES public.outreach_agent_credentials(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_agent_draft_idempotency_unique
    ON public.campaigns (organization_id, agent_credential_id, agent_idempotency_key);

CREATE TABLE IF NOT EXISTS public.outreach_agent_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    credential_id uuid REFERENCES public.outreach_agent_credentials(id) ON DELETE SET NULL,
    actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    action text NOT NULL,
    resource_type text,
    resource_id text,
    request_id text,
    outcome text NOT NULL DEFAULT 'success',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_agent_audit_outcome_check CHECK (outcome IN ('success', 'denied', 'failed')),
    CONSTRAINT outreach_agent_audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_outreach_agent_audit_org_created
    ON public.outreach_agent_audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_agent_audit_credential_created
    ON public.outreach_agent_audit_log (credential_id, created_at DESC);

CREATE SEQUENCE IF NOT EXISTS public.outreach_event_outbox_sequence_number_seq;

CREATE TABLE IF NOT EXISTS public.outreach_event_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_number bigint NOT NULL DEFAULT nextval('public.outreach_event_outbox_sequence_number_seq'),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    deduplication_key text NOT NULL,
    event_type text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamp NOT NULL DEFAULT now(),
    xphere_delivery_enabled boolean NOT NULL DEFAULT true,
    xphere_delivered_at timestamp,
    xphere_attempts integer NOT NULL DEFAULT 0,
    xphere_next_attempt_at timestamp NOT NULL DEFAULT now(),
    xphere_last_error text,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_event_outbox_sequence_unique UNIQUE (sequence_number),
    CONSTRAINT outreach_event_outbox_deduplication_unique UNIQUE (organization_id, deduplication_key),
    CONSTRAINT outreach_event_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT outreach_event_outbox_schema_version_positive CHECK (schema_version >= 1),
    CONSTRAINT outreach_event_outbox_attempts_non_negative CHECK (xphere_attempts >= 0)
);

ALTER SEQUENCE public.outreach_event_outbox_sequence_number_seq
    OWNED BY public.outreach_event_outbox.sequence_number;

CREATE INDEX IF NOT EXISTS idx_outreach_event_outbox_org_sequence
    ON public.outreach_event_outbox (organization_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_outreach_event_outbox_xphere_pending
    ON public.outreach_event_outbox (xphere_next_attempt_at, sequence_number)
    WHERE xphere_delivery_enabled = true AND xphere_delivered_at IS NULL AND xphere_attempts < 10;

ALTER TABLE public.outreach_agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_agent_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_event_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_agent_credentials_select ON public.outreach_agent_credentials;
CREATE POLICY outreach_agent_credentials_select ON public.outreach_agent_credentials FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_agent_audit_log_select ON public.outreach_agent_audit_log;
CREATE POLICY outreach_agent_audit_log_select ON public.outreach_agent_audit_log FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS outreach_event_outbox_select ON public.outreach_event_outbox;
CREATE POLICY outreach_event_outbox_select ON public.outreach_event_outbox FOR SELECT
    TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
