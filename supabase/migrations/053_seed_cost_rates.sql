-- Phase 31 follow-up: seed the first platform-default row in the outreach cost price
-- book (outreach_cost_rates, migration 051) so amortizeSubscriptionCosts has a rate to
-- resolve against instead of writing every inbox_subscription entry as rate_missing.
--
-- Price-change protocol: to change a price, INSERT A NEW ROW with a later valid_from
-- (and optionally set valid_to on the old row to close its window). NEVER UPDATE an
-- existing outreach_cost_rates row in place. outreach_cost_entries freezes
-- unit_cost_micros/amount_micros at write time (see migration 051's header comment and
-- src/server/lib/outreach-costs.ts), so rewriting a rate row would silently desync the
-- price book from the historical entries that were priced against it — resolveRate's
-- validity-window + "greatest valid_from wins" resolution (see pickApplicableRate) only
-- works correctly if past rate rows are left alone.
--
-- apollo_credits is DELIBERATELY left unpriced here: the real Apollo credit plan cost
-- is not yet known. Do not invent a number. Until a genuine apollo_credits rate row is
-- inserted, resolveRate returns null for that category and recordCost writes those
-- entries as zero-priced with detail.rate_missing=true — that is the intended, visible
-- signal that the price book is incomplete, not a bug to silence.
--
-- Idempotent via WHERE NOT EXISTS (there is no unique constraint on
-- (category, unit, provider, model, organization_id) to target with ON CONFLICT —
-- outreach_cost_rates intentionally allows overlapping validity windows, see migration
-- 051 / src/server/lib/outreach-costs.ts resolveRate doc comment).

BEGIN;

INSERT INTO public.outreach_cost_rates (
    organization_id, category, unit, provider, model, unit_cost_micros, currency, valid_from
)
SELECT NULL, 'inbox_subscription', 'month', 'icemail', NULL, 2500000, 'usd', now()
WHERE NOT EXISTS (
    SELECT 1 FROM public.outreach_cost_rates
    WHERE organization_id IS NULL
      AND category = 'inbox_subscription'
      AND unit = 'month'
      AND provider = 'icemail'
      AND model IS NULL
);

COMMIT;
