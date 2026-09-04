-- Phase 31 follow-up (2026-09-04): seed the platform-default rate for a native
-- (self-hosted) mailbox in the outreach cost price book (outreach_cost_rates,
-- migration 051), at unit_cost_micros = 0.
--
-- Why zero is the correct recorded value, not an absence:
--
-- A `provider = 'native'` email account is a mailbox on our own MX, on a domain the
-- company already owns. It was never purchased from anyone — there is no vendor
-- invoice, no per-inbox subscription, nothing metered. Its marginal cost to exist is
-- genuinely zero. That is a fact about the world, not a gap in our price book.
--
-- Before this migration, amortizeSubscriptionCosts() (src/server/jobs/) had no rate to
-- resolve for these accounts and wrote every one of them with detail.rate_missing=true —
-- a flag that means "we don't know the price of this," which is a different claim than
-- "this costs nothing." That false "we don't know" is exactly what fed a false ~7x
-- understatement claim in an earlier cost analysis, and it is what trips the
-- unpriced_cost_share alert (src/server/lib/outreach-silence.ts) on entries that were
-- never actually unpriced spend. Recording an explicit 0 here is what stops a true
-- statement ("this costs nothing") from masquerading as a missing one.
--
-- What this migration deliberately does NOT price: the real costs behind these 29
-- inboxes live in other categories — `domain` (the 9 domains they sit on were bought,
-- but per-domain figures aren't in the price book yet) and `infrastructure` (the MX/IMAP
-- server they run on). Both stay unpriced on purpose, pending real figures — do not
-- invent numbers for them here or anywhere else. Only `inbox_subscription` for
-- `provider = 'native'` is zero because that specific thing — an additional inbox on
-- infrastructure and domains already paid for elsewhere — really is free at the margin.
--
-- Expected transient: the 29 email_accounts rows already amortized on 2026-09-01 were
-- written before this migration existed, so they still carry detail.rate_missing=true —
-- outreach_cost_entries is append-only and freezes cost at write time by design (see
-- migration 051 / src/server/lib/outreach-costs.ts), so those historical rows are
-- correct as written and must NOT be rewritten. unpriced_cost_share will keep firing on
-- them until the next monthly amortization (2026-10-01) writes correctly-priced
-- 'native' rows and the pre-migration rows age out of that alert's 35-day window. This
-- is expected and self-resolving — do not lower the alert's threshold and do not add an
-- exclusion to silence it in the meantime; both would blind it to genuine unpriced spend
-- too.
--
-- Idempotent via WHERE NOT EXISTS, same style as migration 053 (there is no unique
-- constraint on (category, unit, provider, model, organization_id) to target with ON
-- CONFLICT — outreach_cost_rates intentionally allows overlapping validity windows, see
-- migration 051 / src/server/lib/outreach-costs.ts resolveRate doc comment).
--
-- Price-change protocol unchanged from migration 053: to change a price, INSERT A NEW
-- ROW with a later valid_from. NEVER UPDATE an existing outreach_cost_rates row in
-- place.

BEGIN;

INSERT INTO public.outreach_cost_rates (
    organization_id, category, unit, provider, model, unit_cost_micros, currency, valid_from
)
SELECT NULL, 'inbox_subscription', 'month', 'native', NULL, 0, 'usd', now()
WHERE NOT EXISTS (
    SELECT 1 FROM public.outreach_cost_rates
    WHERE organization_id IS NULL
      AND category = 'inbox_subscription'
      AND unit = 'month'
      AND provider = 'native'
      AND model IS NULL
);

COMMIT;
