-- Phase 32: generalize the prospecting pipeline beyond Apollo.
--
-- Migration 046 built prospecting_runs / prospect_candidates Apollo-first: both tables'
-- `provider` CHECK constraints only ever allowed 'apollo', and the cost ledger (migration
-- 051) priced a category literally named `apollo_credits`. In production, Apollo has
-- NEVER run — `prospecting_runs` and `prospect_candidates` are empty. The real lead
-- pipeline that has actually shipped leads is xcraper (scrapes Google Maps via Apify) ->
-- Xphere (stores the run's metadata, including the ACTUAL Apify run cost) -> xmail
-- (leads arrive over POST /api/outreach/leads/bulk-import, carrying
-- custom_fields.xcraper_run_id). This migration widens the pipeline's constraints so a
-- provider-agnostic run can be registered without pretending Apollo is the only source it
-- was ever designed for.
--
-- Renaming apollo_credits -> lead_source (and adding email_verification) makes the cost
-- category describe WHAT was bought (a lead, an email verification) rather than WHICH
-- vendor sold it — the `provider` column on outreach_cost_rates / outreach_cost_entries
-- already carries that distinction (e.g. 'apollo', 'apify') and always has, so no
-- information is lost by generalizing the category. Adding 'result' as a unit lets a
-- lead_source entry be priced/recorded per scraped result, which is how Apify actually
-- bills a Google Maps scrape run — Apollo bills per credit, Apify bills per result, and
-- both units need to coexist in the same price book and ledger going forward.
--
-- Idempotent: every constraint change is DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, and
-- the category backfill is a no-op UPDATE (no apollo_credits rows exist in production
-- today — verified: prospecting_runs and prospect_candidates are both empty) that only
-- matters for another environment that already holds pre-054 rows.

BEGIN;

-- ------------------------------------------------------------------
-- A) prospecting_runs / prospect_candidates: accept 'xcraper' alongside 'apollo'
-- ------------------------------------------------------------------

ALTER TABLE public.prospecting_runs DROP CONSTRAINT IF EXISTS prospecting_runs_provider_check;
ALTER TABLE public.prospecting_runs ADD CONSTRAINT prospecting_runs_provider_check
    CHECK (provider IN ('apollo', 'xcraper'));

ALTER TABLE public.prospect_candidates DROP CONSTRAINT IF EXISTS prospect_candidates_provider_check;
ALTER TABLE public.prospect_candidates ADD CONSTRAINT prospect_candidates_provider_check
    CHECK (provider IN ('apollo', 'xcraper'));

-- ------------------------------------------------------------------
-- B) outreach_cost_rates / outreach_cost_entries: apollo_credits -> lead_source,
--    add email_verification
-- ------------------------------------------------------------------

-- Safe no-op in production today (0 rows affected, verified: apollo_credits was never
-- priced or spent), but required so this migration is safe to run against any other
-- environment that may already hold apollo_credits rows.
UPDATE public.outreach_cost_rates SET category = 'lead_source' WHERE category = 'apollo_credits';
UPDATE public.outreach_cost_entries SET category = 'lead_source' WHERE category = 'apollo_credits';

ALTER TABLE public.outreach_cost_rates DROP CONSTRAINT IF EXISTS outreach_cost_rates_category_check;
ALTER TABLE public.outreach_cost_rates ADD CONSTRAINT outreach_cost_rates_category_check
    CHECK (category IN ('lead_source', 'email_verification', 'llm_tokens', 'inbox_subscription', 'domain', 'infrastructure'));

ALTER TABLE public.outreach_cost_entries DROP CONSTRAINT IF EXISTS outreach_cost_entries_category_check;
ALTER TABLE public.outreach_cost_entries ADD CONSTRAINT outreach_cost_entries_category_check
    CHECK (category IN ('lead_source', 'email_verification', 'llm_tokens', 'inbox_subscription', 'domain', 'infrastructure'));

-- ------------------------------------------------------------------
-- C) outreach_cost_rates / outreach_cost_entries: add 'result' as a billable unit
--    (Apify bills a scrape run per scraped result, not per credit)
-- ------------------------------------------------------------------

ALTER TABLE public.outreach_cost_rates DROP CONSTRAINT IF EXISTS outreach_cost_rates_unit_check;
ALTER TABLE public.outreach_cost_rates ADD CONSTRAINT outreach_cost_rates_unit_check
    CHECK (unit IN ('credit', 'token', 'month', 'year', 'result'));

ALTER TABLE public.outreach_cost_entries DROP CONSTRAINT IF EXISTS outreach_cost_entries_unit_check;
ALTER TABLE public.outreach_cost_entries ADD CONSTRAINT outreach_cost_entries_unit_check
    CHECK (unit IN ('credit', 'token', 'month', 'year', 'result'));

COMMIT;
