-- Phase 31: prospecting run narrative (append-only journey events) and a unified
-- outreach cost ledger (price book + append-only entries).
--
-- The run journey exists so a human (or Hermes) can answer "what actually happened
-- during run X" without re-deriving it from scattered logs: search/score/enrich/assess/
-- import/outcome phases each emit structured, namespaced events onto one ordered stream
-- per run, the same append-only-with-a-sequence pattern as outreach_event_outbox
-- (migration 045).
--
-- The cost ledger prices every metered outreach dependency (Apollo credits, LLM tokens,
-- inbox subscriptions, domains, infrastructure) in USD MICROS, not cents: per-token LLM
-- prices are commonly a small fraction of a cent, so a cents-denominated column would
-- round real spend to zero. outreach_cost_rates is the price book (org-scoped rows
-- override a platform default row where organization_id IS NULL); outreach_cost_entries
-- is an append-only ledger that FREEZES unit_cost_micros and amount_micros at write
-- time, so a later price-book change never rewrites the historical cost of past runs,
-- sends or assessments. dedup_key + a per-organization unique constraint make entry
-- writes idempotent, mirroring outreach_event_outbox's deduplication_key.

BEGIN;

-- ------------------------------------------------------------------
-- A) prospecting_runs: hypothesis + measured outreach outcome rollup
-- ------------------------------------------------------------------

ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS hypothesis jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS outcome_emailed integer NOT NULL DEFAULT 0;
ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS outcome_replied integer NOT NULL DEFAULT 0;
ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS outcome_positive_replied integer NOT NULL DEFAULT 0;
ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS outcome_bounced integer NOT NULL DEFAULT 0;
ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS outcome_unsubscribed integer NOT NULL DEFAULT 0;
ALTER TABLE public.prospecting_runs ADD COLUMN IF NOT EXISTS outcome_last_measured_at timestamp;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospecting_runs_hypothesis_object') THEN
        ALTER TABLE public.prospecting_runs ADD CONSTRAINT prospecting_runs_hypothesis_object
            CHECK (jsonb_typeof(hypothesis) = 'object');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospecting_runs_outcome_counts_check') THEN
        ALTER TABLE public.prospecting_runs ADD CONSTRAINT prospecting_runs_outcome_counts_check
            CHECK (
                outcome_emailed >= 0 AND outcome_replied >= 0 AND outcome_positive_replied >= 0
                AND outcome_bounced >= 0 AND outcome_unsubscribed >= 0
            );
    END IF;
END $$;

-- ------------------------------------------------------------------
-- B) prospect_candidates: how an accepted candidate was imported
-- ------------------------------------------------------------------

ALTER TABLE public.prospect_candidates ADD COLUMN IF NOT EXISTS imported_as text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prospect_candidates_imported_as_check') THEN
        ALTER TABLE public.prospect_candidates ADD CONSTRAINT prospect_candidates_imported_as_check
            CHECK (imported_as IS NULL OR imported_as IN ('created', 'existing'));
    END IF;
END $$;

-- ------------------------------------------------------------------
-- C) prospect_ai_assessments: token accounting for cost attribution
-- ------------------------------------------------------------------

ALTER TABLE public.prospect_ai_assessments ADD COLUMN IF NOT EXISTS prompt_tokens integer;
ALTER TABLE public.prospect_ai_assessments ADD COLUMN IF NOT EXISTS completion_tokens integer;

-- ------------------------------------------------------------------
-- D) prospecting_run_events: append-only run narrative
-- ------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.prospecting_run_events_sequence_number_seq;

CREATE TABLE IF NOT EXISTS public.prospecting_run_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    run_id uuid NOT NULL REFERENCES public.prospecting_runs(id) ON DELETE CASCADE,
    candidate_id uuid REFERENCES public.prospect_candidates(id) ON DELETE CASCADE,
    sequence_number bigint NOT NULL DEFAULT nextval('public.prospecting_run_events_sequence_number_seq'),
    phase text NOT NULL,
    level text NOT NULL DEFAULT 'info',
    code text NOT NULL,
    summary text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamp NOT NULL DEFAULT now(),
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT prospecting_run_events_sequence_unique UNIQUE (sequence_number),
    CONSTRAINT prospecting_run_events_phase_check
        CHECK (phase IN ('search', 'score', 'enrich', 'assess', 'import', 'outcome')),
    CONSTRAINT prospecting_run_events_level_check
        CHECK (level IN ('info', 'warn', 'error')),
    CONSTRAINT prospecting_run_events_code_check
        CHECK (length(btrim(code)) > 0),
    CONSTRAINT prospecting_run_events_detail_object
        CHECK (jsonb_typeof(detail) = 'object')
);

ALTER SEQUENCE public.prospecting_run_events_sequence_number_seq
    OWNED BY public.prospecting_run_events.sequence_number;

CREATE INDEX IF NOT EXISTS idx_prospecting_run_events_run_sequence
    ON public.prospecting_run_events (run_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_prospecting_run_events_org_code_occurred
    ON public.prospecting_run_events (organization_id, code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_prospecting_run_events_org_run_phase
    ON public.prospecting_run_events (organization_id, run_id, phase);

ALTER TABLE public.prospecting_run_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospecting_run_events_select ON public.prospecting_run_events;
CREATE POLICY prospecting_run_events_select ON public.prospecting_run_events FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

-- ------------------------------------------------------------------
-- E) outreach_cost_rates: price book (organization_id IS NULL = platform default)
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.outreach_cost_rates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
    category text NOT NULL,
    unit text NOT NULL,
    provider text,
    model text,
    unit_cost_micros bigint NOT NULL,
    currency text NOT NULL DEFAULT 'usd',
    valid_from timestamp NOT NULL DEFAULT now(),
    valid_to timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_cost_rates_category_check
        CHECK (category IN ('apollo_credits', 'llm_tokens', 'inbox_subscription', 'domain', 'infrastructure')),
    CONSTRAINT outreach_cost_rates_unit_check
        CHECK (unit IN ('credit', 'token', 'month', 'year')),
    CONSTRAINT outreach_cost_rates_unit_cost_nonnegative
        CHECK (unit_cost_micros >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outreach_cost_rates_category_provider_model_valid
    ON public.outreach_cost_rates (category, provider, model, valid_from);

ALTER TABLE public.outreach_cost_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_cost_rates_select ON public.outreach_cost_rates;
CREATE POLICY outreach_cost_rates_select ON public.outreach_cost_rates FOR SELECT TO authenticated
    USING (organization_id IS NULL OR public.is_org_member(organization_id) OR public.is_platform_admin());

-- ------------------------------------------------------------------
-- F) outreach_cost_entries: append-only ledger, cost frozen at write time
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.outreach_cost_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    occurred_at timestamp NOT NULL DEFAULT now(),
    category text NOT NULL,
    basis text NOT NULL,
    quantity numeric(20, 4) NOT NULL,
    unit text NOT NULL,
    unit_cost_micros bigint NOT NULL,
    amount_micros bigint NOT NULL,
    currency text NOT NULL DEFAULT 'usd',
    rate_id uuid REFERENCES public.outreach_cost_rates(id) ON DELETE SET NULL,
    provider text,
    model text,
    run_id uuid REFERENCES public.prospecting_runs(id) ON DELETE SET NULL,
    campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
    email_account_id uuid REFERENCES public.email_accounts(id) ON DELETE SET NULL,
    ai_run_id uuid,
    assessment_id uuid,
    dedup_key text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT outreach_cost_entries_org_dedup_unique UNIQUE (organization_id, dedup_key),
    CONSTRAINT outreach_cost_entries_category_check
        CHECK (category IN ('apollo_credits', 'llm_tokens', 'inbox_subscription', 'domain', 'infrastructure')),
    CONSTRAINT outreach_cost_entries_basis_check
        CHECK (basis IN ('actual', 'estimated', 'amortized')),
    CONSTRAINT outreach_cost_entries_unit_check
        CHECK (unit IN ('credit', 'token', 'month', 'year')),
    CONSTRAINT outreach_cost_entries_quantity_nonnegative
        CHECK (quantity >= 0),
    CONSTRAINT outreach_cost_entries_amount_nonnegative
        CHECK (amount_micros >= 0),
    CONSTRAINT outreach_cost_entries_detail_object
        CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_outreach_cost_entries_org_occurred
    ON public.outreach_cost_entries (organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outreach_cost_entries_org_category_occurred
    ON public.outreach_cost_entries (organization_id, category, occurred_at);
CREATE INDEX IF NOT EXISTS idx_outreach_cost_entries_run
    ON public.outreach_cost_entries (run_id) WHERE run_id IS NOT NULL;

ALTER TABLE public.outreach_cost_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_cost_entries_select ON public.outreach_cost_entries;
CREATE POLICY outreach_cost_entries_select ON public.outreach_cost_entries FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id) OR public.is_platform_admin());

COMMIT;
