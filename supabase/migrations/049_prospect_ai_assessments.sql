-- Phase 30: auditable Hermes qualification/personalization proposals and evidence.
-- Assessments are advisory: they cannot enroll, activate or send.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.prospect_candidates'::regclass
          AND conname = 'prospect_candidates_id_organization_unique'
    ) THEN
        ALTER TABLE public.prospect_candidates
            ADD CONSTRAINT prospect_candidates_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.prospect_ai_assessments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    candidate_id uuid NOT NULL,
    agent_credential_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    model_provider text NOT NULL,
    model_name text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    candidate_input_hash text NOT NULL,
    recommendation text NOT NULL,
    confidence integer NOT NULL,
    rationale text NOT NULL,
    personalization jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT prospect_ai_assessments_candidate_org_fk
        FOREIGN KEY (candidate_id, organization_id)
        REFERENCES public.prospect_candidates(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT prospect_ai_assessments_agent_org_fk
        FOREIGN KEY (agent_credential_id, organization_id)
        REFERENCES public.outreach_agent_credentials(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT prospect_ai_assessments_idempotency_unique
        UNIQUE (organization_id, agent_credential_id, candidate_id, idempotency_key),
    CONSTRAINT prospect_ai_assessments_recommendation_check
        CHECK (recommendation IN ('qualified', 'review', 'rejected')),
    CONSTRAINT prospect_ai_assessments_confidence_check CHECK (confidence BETWEEN 0 AND 100),
    CONSTRAINT prospect_ai_assessments_schema_version_check CHECK (schema_version >= 1),
    CONSTRAINT prospect_ai_assessments_hash_check CHECK (candidate_input_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT prospect_ai_assessments_rationale_check CHECK (length(btrim(rationale)) BETWEEN 1 AND 2000),
    CONSTRAINT prospect_ai_assessments_personalization_object CHECK (jsonb_typeof(personalization) = 'object'),
    CONSTRAINT prospect_ai_assessments_evidence_array CHECK (jsonb_typeof(evidence_fields) = 'array'),
    CONSTRAINT prospect_ai_assessments_risk_array CHECK (jsonb_typeof(risk_flags) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_prospect_ai_assessments_candidate_created
    ON public.prospect_ai_assessments (candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospect_ai_assessments_org_recommendation
    ON public.prospect_ai_assessments (organization_id, recommendation, confidence DESC, created_at DESC);

ALTER TABLE public.prospect_ai_assessments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospect_ai_assessments_select ON public.prospect_ai_assessments;
CREATE POLICY prospect_ai_assessments_select ON public.prospect_ai_assessments FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
