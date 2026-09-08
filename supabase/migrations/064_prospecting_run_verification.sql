-- Phase 34 (docs/prospecting-engine-plan.md "Fase 34 — Verificacao como passo de run").
--
-- Evidence measured before this migration: outreach_cost_rates already seeded an
-- email_verification/millionverifier/credit rate since migrations 055/056 (3700 micros
-- per credit), yet outreach_cost_entries had ZERO rows in that category. The
-- MillionVerifier balance dropped 253 -> 215 credits across 98 verifications and nothing
-- recorded it -- Journeys only learned the verified counts from human-dictated Hermes
-- notes. This migration adds the columns POST
-- /api/outreach/prospecting/external-runs/:externalRunId/verification (prospecting.ts)
-- writes to close that gap, plus widens the run-events phase constraint so the new
-- 'verify' phase (journey.ts RUN_EVENT_CODES.verify.COMPLETED = 'verify.completed') can
-- be recorded.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the constraint is DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT, matching migration 054's style for widening a CHECK. No
-- CREATE INDEX CONCURRENTLY (would fail inside this transaction, per CLAUDE.md).

BEGIN;

ALTER TABLE public.prospecting_runs
    -- NULL means "never measured". Do NOT default to 0 -- the same reasoning as
    -- enriched_count's own history (see prospecting.ts's comment on that column and
    -- migration 054's header): a 0 default would be indistinguishable from "verified and
    -- found zero ok", hiding exactly the absence the new outreach-silence.ts
    -- verification_missing rule needs to see.
    ADD COLUMN IF NOT EXISTS verified_ok_count integer,
    ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Widen the phase check constraint so 'verify.completed' can be recorded in
-- prospecting_run_events. Drop/recreate rather than a bare ADD, the same idempotent
-- pattern migration 054 used to widen provider/category/unit constraints.
ALTER TABLE public.prospecting_run_events DROP CONSTRAINT IF EXISTS prospecting_run_events_phase_check;
ALTER TABLE public.prospecting_run_events ADD CONSTRAINT prospecting_run_events_phase_check
    CHECK (phase IN ('search', 'score', 'enrich', 'assess', 'import', 'outcome', 'verify'));

COMMIT;
