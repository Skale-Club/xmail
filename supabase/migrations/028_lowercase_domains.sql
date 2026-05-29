-- ========================================================================
-- 021_lowercase_domains.sql — Backfill: lowercase + trim every domains.name
-- ========================================================================
-- Phase 13 QUA-04 / audit M9.
--
-- POST /api/domains now normalizes `name` via `name.toLowerCase().trim()`
-- before insert (see src/server/routes/domains.ts). This migration brings
-- historical rows into the same shape so the uniqueness invariant
-- (organization_id, name) becomes case/whitespace-insensitive in practice.
--
-- IDEMPOTENT: the WHERE clause makes a second run a no-op.
--
-- IMPORTANT — handling pre-existing case-different dupes:
--   If two rows exist with names that differ only in case (e.g. EXAMPLE.COM
--   and example.com inside the same org), the naive UPDATE below would
--   violate a future unique constraint. We DO NOT add a unique constraint
--   in this migration. We DO log dupes via a SELECT into the output so the
--   operator can resolve them manually before adding a constraint in a
--   later migration.
-- ========================================================================

BEGIN;

-- Step 1: Report any potential collisions before mutating.
DO $$
DECLARE
  collision_count integer;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT organization_id, LOWER(TRIM(name)) AS norm, COUNT(*) AS c
    FROM public.domains
    GROUP BY organization_id, LOWER(TRIM(name))
    HAVING COUNT(*) > 1
  ) sub;

  IF collision_count > 0 THEN
    RAISE NOTICE 'QUA-04: % case-collision group(s) detected in domains. Resolve manually before adding a UNIQUE(organization_id, name) constraint.', collision_count;
  END IF;
END $$;

-- Step 2: Normalize. WHERE-clause idempotent — second run touches 0 rows.
UPDATE public.domains
   SET name = LOWER(TRIM(name))
 WHERE name <> LOWER(TRIM(name));

COMMIT;

-- Post-migration verification query (run manually):
--   SELECT name FROM public.domains WHERE name <> LOWER(name) OR name <> TRIM(name);
-- Expected: zero rows.
