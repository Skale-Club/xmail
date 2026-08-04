-- Phase 27: provider-neutral prospect discovery, bounded enrichment and ICP scoring.
-- Provider secrets never enter these tables; routes enforce tenant scope in JS because
-- the application database role bypasses RLS.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.outreach_agent_credentials'::regclass
          AND conname = 'outreach_agent_credentials_id_organization_unique'
    ) THEN
        ALTER TABLE public.outreach_agent_credentials
            ADD CONSTRAINT outreach_agent_credentials_id_organization_unique UNIQUE (id, organization_id);
    END IF;
END $$;

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_verification_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_verification_provider text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS email_verified_at timestamp;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS icp_score integer;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS icp_tier text;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS icp_score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS enriched_at timestamp;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_email_verification_status_check') THEN
        ALTER TABLE public.leads ADD CONSTRAINT leads_email_verification_status_check
            CHECK (email_verification_status IN ('unknown', 'verified', 'likely', 'unavailable', 'invalid'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_icp_score_check') THEN
        ALTER TABLE public.leads ADD CONSTRAINT leads_icp_score_check
            CHECK (icp_score IS NULL OR (icp_score >= 0 AND icp_score <= 100));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_icp_tier_check') THEN
        ALTER TABLE public.leads ADD CONSTRAINT leads_icp_tier_check
            CHECK (icp_tier IS NULL OR icp_tier IN ('a', 'b', 'c', 'disqualified'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS leads_id_organization_unique ON public.leads (id, organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_org_icp_score ON public.leads (organization_id, icp_score DESC)
    WHERE icp_score IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.outreach_icp_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    is_default boolean NOT NULL DEFAULT false,
    qualification_threshold integer NOT NULL DEFAULT 60,
    criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_icp_profiles_org_name_unique UNIQUE (organization_id, name),
    CONSTRAINT outreach_icp_profiles_id_org_unique UNIQUE (id, organization_id),
    CONSTRAINT outreach_icp_profiles_threshold_check CHECK (qualification_threshold BETWEEN 0 AND 100),
    CONSTRAINT outreach_icp_profiles_criteria_object CHECK (jsonb_typeof(criteria) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS outreach_icp_profiles_one_default_per_org
    ON public.outreach_icp_profiles (organization_id) WHERE is_default = true;

CREATE TABLE IF NOT EXISTS public.prospecting_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    agent_credential_id uuid,
    actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    icp_profile_id uuid,
    provider text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    search_filters jsonb NOT NULL DEFAULT '{}'::jsonb,
    scoring_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
    qualification_threshold integer NOT NULL DEFAULT 60,
    requested_limit integer NOT NULL DEFAULT 25,
    provider_page integer NOT NULL DEFAULT 1,
    discovered_count integer NOT NULL DEFAULT 0,
    enriched_count integer NOT NULL DEFAULT 0,
    imported_count integer NOT NULL DEFAULT 0,
    rejected_count integer NOT NULL DEFAULT 0,
    approved_credit_ceiling integer NOT NULL DEFAULT 0,
    consumed_credit_estimate integer NOT NULL DEFAULT 0,
    last_error text,
    started_at timestamp,
    completed_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT prospecting_runs_org_idempotency_unique UNIQUE (organization_id, provider, idempotency_key),
    CONSTRAINT prospecting_runs_id_org_unique UNIQUE (id, organization_id),
    CONSTRAINT prospecting_runs_agent_org_fk FOREIGN KEY (agent_credential_id, organization_id)
        REFERENCES public.outreach_agent_credentials(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT prospecting_runs_icp_org_fk FOREIGN KEY (icp_profile_id, organization_id)
        REFERENCES public.outreach_icp_profiles(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT prospecting_runs_provider_check CHECK (provider IN ('apollo')),
    CONSTRAINT prospecting_runs_status_check CHECK (status IN ('pending', 'searching', 'discovered', 'enriching', 'ready', 'imported', 'failed')),
    CONSTRAINT prospecting_runs_filters_object CHECK (jsonb_typeof(search_filters) = 'object'),
    CONSTRAINT prospecting_runs_scoring_object CHECK (jsonb_typeof(scoring_criteria) = 'object'),
    CONSTRAINT prospecting_runs_limit_check CHECK (requested_limit BETWEEN 1 AND 100),
    CONSTRAINT prospecting_runs_page_check CHECK (provider_page >= 1),
    CONSTRAINT prospecting_runs_threshold_check CHECK (qualification_threshold BETWEEN 0 AND 100),
    CONSTRAINT prospecting_runs_counts_check CHECK (
        discovered_count >= 0 AND enriched_count >= 0 AND imported_count >= 0 AND rejected_count >= 0
        AND approved_credit_ceiling >= 0 AND consumed_credit_estimate >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_prospecting_runs_org_created
    ON public.prospecting_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prospecting_runs_status
    ON public.prospecting_runs (status, updated_at);

CREATE TABLE IF NOT EXISTS public.prospect_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    run_id uuid NOT NULL,
    provider text NOT NULL,
    external_person_id text NOT NULL,
    first_name text,
    last_name text,
    title text,
    seniority text,
    linkedin_url text,
    location text,
    company_name text,
    company_domain text,
    company_industry text,
    company_employee_count integer,
    email text,
    email_status text NOT NULL DEFAULT 'unknown',
    score integer NOT NULL DEFAULT 0,
    score_tier text NOT NULL DEFAULT 'disqualified',
    score_breakdown jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'discovered',
    raw_payload jsonb NOT NULL DEFAULT '{}',
    lead_id uuid,
    enriched_at timestamp,
    imported_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT prospect_candidates_run_external_unique UNIQUE (run_id, provider, external_person_id),
    CONSTRAINT prospect_candidates_run_org_fk FOREIGN KEY (run_id, organization_id)
        REFERENCES public.prospecting_runs(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT prospect_candidates_lead_org_fk FOREIGN KEY (lead_id, organization_id)
        REFERENCES public.leads(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT prospect_candidates_provider_check CHECK (provider IN ('apollo')),
    CONSTRAINT prospect_candidates_status_check CHECK (status IN ('discovered', 'enriched', 'qualified', 'imported', 'rejected', 'failed')),
    CONSTRAINT prospect_candidates_email_status_check CHECK (email_status IN ('unknown', 'verified', 'likely', 'unavailable', 'invalid')),
    CONSTRAINT prospect_candidates_score_check CHECK (score BETWEEN 0 AND 100),
    CONSTRAINT prospect_candidates_score_tier_check CHECK (score_tier IN ('a', 'b', 'c', 'disqualified')),
    CONSTRAINT prospect_candidates_breakdown_object CHECK (jsonb_typeof(score_breakdown) = 'object'),
    CONSTRAINT prospect_candidates_payload_object CHECK (jsonb_typeof(raw_payload) = 'object'),
    CONSTRAINT prospect_candidates_employee_count_check CHECK (company_employee_count IS NULL OR company_employee_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_prospect_candidates_run_score
    ON public.prospect_candidates (run_id, score DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_prospect_candidates_org_email
    ON public.prospect_candidates (organization_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prospect_candidates_run_status
    ON public.prospect_candidates (run_id, status, score DESC);

ALTER TABLE public.outreach_icp_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outreach_icp_profiles_select ON public.outreach_icp_profiles;
CREATE POLICY outreach_icp_profiles_select ON public.outreach_icp_profiles FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS prospecting_runs_select ON public.prospecting_runs;
CREATE POLICY prospecting_runs_select ON public.prospecting_runs FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP POLICY IF EXISTS prospect_candidates_select ON public.prospect_candidates;
CREATE POLICY prospect_candidates_select ON public.prospect_candidates FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
