-- Phase 28: durable human approvals for credit-spending enrichment and campaign activation.

BEGIN;

CREATE TABLE IF NOT EXISTS public.outreach_action_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    requester_agent_credential_id uuid,
    requester_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    reviewer_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
    action_kind text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'requested',
    request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    maximum_credit_cost integer NOT NULL DEFAULT 0,
    review_note text,
    requested_at timestamp NOT NULL DEFAULT now(),
    reviewed_at timestamp,
    execution_started_at timestamp,
    executed_at timestamp,
    expires_at timestamp NOT NULL DEFAULT (now() + interval '24 hours'),
    failure_reason text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_action_approvals_org_idempotency_unique
        UNIQUE (organization_id, requester_agent_credential_id, action_kind, idempotency_key),
    CONSTRAINT outreach_action_approvals_requester_org_fk
        FOREIGN KEY (requester_agent_credential_id, organization_id)
        REFERENCES public.outreach_agent_credentials(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT outreach_action_approvals_action_check
        CHECK (action_kind IN ('prospect_enrichment', 'campaign_activation')),
    CONSTRAINT outreach_action_approvals_status_check
        CHECK (status IN ('requested', 'approved', 'rejected', 'executing', 'executed', 'failed', 'expired', 'cancelled')),
    CONSTRAINT outreach_action_approvals_resource_check
        CHECK (length(btrim(resource_type)) > 0 AND length(btrim(resource_id)) > 0),
    CONSTRAINT outreach_action_approvals_payload_object
        CHECK (jsonb_typeof(request_payload) = 'object'),
    CONSTRAINT outreach_action_approvals_credit_nonnegative
        CHECK (maximum_credit_cost >= 0),
    CONSTRAINT outreach_action_approvals_review_pair
        CHECK ((reviewer_user_id IS NULL) = (reviewed_at IS NULL)),
    CONSTRAINT outreach_action_approvals_execution_order
        CHECK (executed_at IS NULL OR execution_started_at IS NOT NULL),
    CONSTRAINT outreach_action_approvals_expiry_order
        CHECK (expires_at > requested_at)
);

CREATE INDEX IF NOT EXISTS idx_outreach_action_approvals_org_status
    ON public.outreach_action_approvals (organization_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_action_approvals_resource
    ON public.outreach_action_approvals (organization_id, action_kind, resource_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_action_approvals_expiry
    ON public.outreach_action_approvals (status, expires_at)
    WHERE status IN ('requested', 'approved');

ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS enrichment_approval_id uuid;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS activation_approval_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospecting_runs_enrichment_approval_fk') THEN
        ALTER TABLE public.prospecting_runs ADD CONSTRAINT prospecting_runs_enrichment_approval_fk
            FOREIGN KEY (enrichment_approval_id) REFERENCES public.outreach_action_approvals(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_activation_approval_fk') THEN
        ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_activation_approval_fk
            FOREIGN KEY (activation_approval_id) REFERENCES public.outreach_action_approvals(id) ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_prospecting_runs_enrichment_approval
    ON public.prospecting_runs (enrichment_approval_id) WHERE enrichment_approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaigns_activation_approval
    ON public.campaigns (activation_approval_id) WHERE activation_approval_id IS NOT NULL;

ALTER TABLE public.outreach_action_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_action_approvals_select ON public.outreach_action_approvals;
CREATE POLICY outreach_action_approvals_select ON public.outreach_action_approvals FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
