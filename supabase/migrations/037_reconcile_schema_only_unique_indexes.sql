-- 037_reconcile_schema_only_unique_indexes.sql
-- Reconciles two unique indexes that exist in src/db/schema.ts (type-info only) but were never
-- created by any SQL migration. Production has them (applied out-of-band via the long-removed
-- db:push), but a database rebuilt purely from these migrations — staging, DR, a fresh local —
-- would lack them, and the application relies on both as ON CONFLICT targets:
--
--   * suppressions (organization_id, email_address) — suppression dedup upsert. Missing → 42P10.
--   * statistics   (organization_id, date)          — incrementStat upsert in lib/tracking.ts,
--                                                      hit on every open/click. Missing → 42P10.
--
-- This is the same class of gap that 035 closed for the outreach claim-lock index and 036 for
-- the email_accounts case-insensitive unique.
--
-- No prod change is intended: verified against production (2026-07-15) that both indexes already
-- exist with exactly these definitions, so `IF NOT EXISTS` makes this a no-op there. It matters
-- only for environments built from migrations. Unlike the abandoned branch version, this does NOT
-- delete rows to force uniqueness: a fresh rebuild starts with empty tables, and if some
-- environment somehow holds duplicates, the CREATE fails loudly here rather than silently dropping
-- data — reconcile by hand, then re-run.
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS suppression_org_email_unique
    ON suppressions (organization_id, email_address);

CREATE UNIQUE INDEX IF NOT EXISTS stats_org_date_unique
    ON statistics (organization_id, date);

COMMIT;
