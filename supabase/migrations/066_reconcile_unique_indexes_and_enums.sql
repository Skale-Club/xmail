-- Schema drift reconciliation (CLAUDE.md P0-5).
--
-- src/db/schema.ts and drizzle/archive/0000_dear_wolverine.sql (the genesis DDL — moved
-- to drizzle/archive/ by this same change, see its README) both define an
-- email_provider enum and two unique indexes that no supabase/migrations/*.sql file has
-- ever created:
--   - the email_provider enum itself: pgEnum('email_provider', ['smtp','outlook','native'])
--     (src/db/schema.ts ~line 650). Migration 032 only ever ALTERs it (adds 'native'); the
--     type's original CREATE TYPE lives solely in the genesis file.
--   - lead_org_email_unique on leads (organization_id, email) (src/db/schema.ts ~line 780,
--     drizzle/archive/0000_dear_wolverine.sql:638).
--   - campaign_lead_unique on campaign_leads (campaign_id, lead_id) (src/db/schema.ts
--     ~line 918-957 uniqueIndex, drizzle/archive/0000_dear_wolverine.sql:637).
--
-- Production already has all three (it was bootstrapped from the genesis file), so this
-- migration is a no-op there (EXCEPTION / IF NOT EXISTS everywhere). It exists so a FRESH
-- database built ONLY from supabase/migrations/*.sql — the documented source of truth for
-- the running schema — ends up with the same structure production actually has, instead of
-- silently missing an enum type and two unique constraints that later migrations (032,
-- 052's case-sensitivity note, drizzle-side types) all assume already exist.
--
-- Deliberately NOT in scope here: converting email_accounts.provider's column type. It is
-- already the real Postgres enum in production (migration 032's fix), and a fresh database
-- gets that from the CREATE TYPE below plus the emailAccounts table definition itself
-- (src/db/schema.ts) using emailProviderEnum — no separate ALTER COLUMN ... TYPE is needed
-- or safe to add generically here.
--
-- Idempotent and transaction-safe: no CREATE INDEX CONCURRENTLY (fails inside a
-- transaction, per CLAUDE.md's Schema & Migration Workflow), so this uses the plain
-- (non-concurrent) form like every other migration that predates sql/indexes.sql.

-- No BEGIN/COMMIT here on purpose: scripts/apply-pending-migrations.mjs wraps each file in its
-- own transaction, and an inner COMMIT would land the ledger row outside it (see CLAUDE.md).

DO $$
BEGIN
    CREATE TYPE email_provider AS ENUM ('smtp', 'outlook', 'native');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lead_org_email_unique
    ON leads (organization_id, email);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_lead_unique
    ON campaign_leads (campaign_id, lead_id);

