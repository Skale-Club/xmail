-- Seeds a platform-default rate for the email_verification category (added in migration
-- 054) so MillionVerifier usage is priced instead of landing as rate_missing.
--
-- THE NUMBER HERE IS A ROUNDED LIST-PRICE PLACEHOLDER, NOT A CONFIRMED PURCHASE.
-- 500 micros = USD 0.0005 per credit. MillionVerifier's published tiers span roughly 8x
-- (about USD 0.0037/credit at the 10k package down to USD 0.000449/credit at 1M), and the
-- effective rate actually paid is lower still than the tier sticker because of two
-- stacking discounts: 1M bonus credits for every 5M purchased, and +10% credits on every
-- payment when auto top-up is enabled. 500 micros sits at the high-volume end of that
-- range. Replace it with the real figure as soon as the purchased package is known:
-- effective rate = amount actually paid / credits actually received (bonuses included).
--
-- To correct it, INSERT A NEW ROW with a later valid_from — never UPDATE this one. See
-- migration 053's header for why (entries freeze their price at write time).
--
-- BILLING MECHANIC THAT MATTERS WHEN RECORDING USAGE: MillionVerifier charges only for
-- conclusive results ("good" and "bad"), NOT for risky ones (unknown / catch-all). So
-- credits consumed is NOT the same as emails submitted, and quantity on an
-- email_verification cost entry must be the credits the provider reports as consumed.
-- Billing per email submitted would overstate spend by the whole risky share, which for
-- small local businesses on shared hosting is often large.
--
-- Magnitude, for perspective: verifying 1,000 businesses costs roughly USD 0.45-3.70
-- depending on tier, against USD 12.50/month of fixed inbox subscription. This category
-- is recorded for correctness and per-run attribution, not because it is worth
-- optimising.
--
-- Idempotent via WHERE NOT EXISTS, matching migration 053.

BEGIN;

INSERT INTO public.outreach_cost_rates (
    organization_id, category, unit, provider, model, unit_cost_micros, currency, valid_from
)
SELECT NULL, 'email_verification', 'credit', 'millionverifier', NULL, 500, 'usd', now()
WHERE NOT EXISTS (
    SELECT 1 FROM public.outreach_cost_rates
    WHERE organization_id IS NULL
      AND category = 'email_verification'
      AND unit = 'credit'
      AND provider = 'millionverifier'
      AND model IS NULL
);

COMMIT;
