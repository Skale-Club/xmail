-- Replaces the MillionVerifier placeholder seeded in migration 055 (500 micros) with a
-- better-reasoned estimate: 3700 micros = USD 0.0037 per credit, MillionVerifier's
-- entry package (10k credits for USD 37, no bonus assumed).
--
-- STILL AN ESTIMATE, NOT A CONFIRMED PURCHASE. The actual package bought is not known.
-- Reasoning for picking this tier over the others:
--   * Published tiers span ~8x (USD 0.0037/credit at 10k down to USD 0.000449/credit at
--     1M). The entry package is the most likely one for a pilot-scale operation.
--   * It errs HIGH, so reported spend can only overstate, never understate.
--   * At current volume the choice is immaterial either way: verifying 1,000 businesses
--     costs about USD 3.70 at this rate versus USD 0.45 at the 1M rate, against USD 12.50
--     per month of fixed inbox subscription. Precision here does not change any decision.
--
-- The real rate is (amount actually paid / credits actually received). Credits received
-- exceeds credits purchased when auto top-up (+10%) or the 5M-buys-1M-free bonus applies,
-- so the effective rate is always BELOW the tier sticker. Example: USD 449 for 1M with
-- auto top-up is 1.1M credits, i.e. USD 0.000408/credit, not 0.000449.
--
-- PROTOCOL: this migration does NOT update migration 055's row. It closes that row's
-- validity window and inserts a new one. outreach_cost_entries freezes unit_cost_micros
-- at write time, so rewriting a rate in place would desync the price book from the
-- entries priced against it. Closing valid_to is not a price change — it just ends the
-- window — and resolveRate then picks the new row by "greatest valid_from wins".
--
-- Nothing has been billed against the 055 rate yet (outreach_cost_entries was empty when
-- this was written), so no historical entry carries the superseded figure.
--
-- Idempotent: re-running neither closes an already-closed window twice nor duplicates
-- the new row.

BEGIN;

-- Close the 055 placeholder's window (window boundary, not a price rewrite).
UPDATE public.outreach_cost_rates
   SET valid_to = now(), updated_at = now()
 WHERE organization_id IS NULL
   AND category = 'email_verification'
   AND unit = 'credit'
   AND provider = 'millionverifier'
   AND unit_cost_micros = 500
   AND valid_to IS NULL;

INSERT INTO public.outreach_cost_rates (
    organization_id, category, unit, provider, model, unit_cost_micros, currency, valid_from
)
SELECT NULL, 'email_verification', 'credit', 'millionverifier', NULL, 3700, 'usd', now()
WHERE NOT EXISTS (
    SELECT 1 FROM public.outreach_cost_rates
    WHERE organization_id IS NULL
      AND category = 'email_verification'
      AND unit = 'credit'
      AND provider = 'millionverifier'
      AND unit_cost_micros = 3700
      AND valid_to IS NULL
);

COMMIT;
