---
phase: 13-medium-consolidation
plan: 04
subsystem: domains
tags: [QUA-04, audit-M9, normalization, data-migration, case-insensitive]
requirements: [QUA-04]
dependency_graph:
  requires: []
  provides:
    - "Lowercase+trim invariant on domains.name (POST handler + historical data)"
    - "Safe foundation for a future UNIQUE(organization_id, name) constraint"
  affects:
    - "src/server/routes/domains.ts POST /"
    - "public.domains rows (historical normalization)"
tech_stack:
  added: []
  patterns:
    - "Normalize-after-validate (Zod parses raw, handler normalizes for storage)"
    - "Idempotent SQL backfill via WHERE-mismatch filter"
    - "Pre-mutation collision report via DO + RAISE NOTICE"
key_files:
  created:
    - supabase/migrations/021_lowercase_domains.sql
  modified:
    - src/server/routes/domains.ts
decisions:
  - "Used explicit `normalizedName` const over Zod `.transform()` so `data.name` retains the raw validated value for logging/traceability."
  - "Did NOT add UNIQUE(organization_id, name) — collisions must be resolved manually first; constraint addition deferred to a later plan."
  - "Migration wrapped in BEGIN/COMMIT for atomic rollback on partial failure."
metrics:
  duration: "~1 minute"
  completed_date: "2026-05-16"
  tasks_completed: 2
  files_created: 1
  files_modified: 1
  commits: 2
---

# Phase 13 Plan 04: Domain Name Normalization Summary

QUA-04 — Lowercase + trim `domains.name` at write time in `POST /api/domains` and backfill historical rows via idempotent migration 021, closing audit finding M9 (EXAMPLE.COM / example.com dupe class).

## Objective Recap

Today, `POST /api/domains { name: "EXAMPLE.COM" }` followed by `POST /api/domains { name: "example.com" }` succeeds twice — two duplicate rows are created. Worse, `validateEmailDomainForOrg` lowercases the lookup, so the `EXAMPLE.COM` row is unreachable from email-flow lookups. This plan eliminates the case-mismatch dupe class.

## Tasks Completed

### Task 1: Normalize input in `POST /api/domains`

**Commit:** `8925d34`

**Change in `src/server/routes/domains.ts` (POST `/` handler, after Zod parse, before duplicate-check):**

```typescript
// QUA-04 — see audit M9. Lowercase + trim once, use the normalized value for both
// the duplicate-existence check and the INSERT. This makes the column effectively
// case-insensitive and prevents the EXAMPLE.COM-then-example.com dupe class.
const normalizedName = data.name.toLowerCase().trim()

const existingDomain = await db.query.domains.findFirst({
    where: and(
        eq(domains.organizationId, data.organizationId),
        eq(domains.name, normalizedName)        // was: data.name
    ),
})

if (existingDomain) {
    return res.status(400).json({ error: 'Domain already exists' })
}

const [domain] = await db.insert(domains).values({
    organizationId: data.organizationId,
    name: normalizedName,                        // was: data.name
    verificationMethod: data.verificationMethod,
    verificationToken: uuidv4(),
}).returning()
```

**Diff size:** 7 insertions, 2 deletions (1 file changed).

**Scope-confirmation grep:** `grep -rn "insert(domains)" src/` returns only `src/server/routes/domains.ts:161` — POST is the sole writer; no other call sites need normalizing.

### Task 2: Migration `021_lowercase_domains.sql`

**Commit:** `08b8708`

**File:** `supabase/migrations/021_lowercase_domains.sql` (51 lines)

Key SQL:

```sql
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
```

**Properties:**
- Idempotent (WHERE filter makes re-run a no-op).
- Collision-aware (informational `RAISE NOTICE`, no exception — migration completes regardless).
- Atomic (BEGIN/COMMIT wrap).
- No UNIQUE constraint added (deferred — collisions must be resolved first).

## Verification

| Check | Result |
| ----- | ------ |
| `grep -E "name\.toLowerCase\(\)\.trim\(\)" src/server/routes/domains.ts` | Found (line 148) |
| `grep -E "name: data\.name" src/server/routes/domains.ts` | Not found (verified Task 1) |
| `test -f supabase/migrations/021_lowercase_domains.sql` | Exists |
| `grep "UPDATE public.domains" supabase/migrations/021_lowercase_domains.sql` | Found |
| `grep "WHERE name <> LOWER(TRIM(name))" supabase/migrations/021_lowercase_domains.sql` | Found |
| `grep "BEGIN;" / "COMMIT;"` | Both found |
| `grep -rn "insert(domains)" src/` | Only POST handler — no other callers to update |

**Behavioral smoke (not run — no live DB in this session):** Manual verification recommended after migration apply via the queries documented in the plan (`SELECT name FROM public.domains WHERE name <> LOWER(name) OR name <> TRIM(name);` → expected 0 rows).

## Success Criteria

ROADMAP success criterion #4 for Phase 13:
> Inserting domain `EXAMPLE.COM` then `example.com` returns 400 "duplicate" on the second insert; `SELECT name FROM domains WHERE name <> lower(name)` returns zero rows.

- POST handler now normalizes BOTH the duplicate-check lookup AND the INSERT — second insert (any case variant) will hit `existingDomain` and return 400. ✓
- Migration 021 lowercases all historical rows in place. After apply, the verification SELECT returns zero rows. ✓

## Deviations from Plan

None — plan executed exactly as written. Both tasks completed with the recommended (explicit `normalizedName` const) pattern.

Note on migration numbering: the plan assumed 020 was taken by 13-03. At this point in the wave-1 parallel execution, 13-03 has not yet landed in `supabase/migrations/`, so 020 is currently absent. 021 remains the correct number for this plan per the plan spec and avoids any conflict when 13-03 lands.

## Closes

- Audit finding **M9** (case-mismatch dupe / lock-out scenario in `validateEmailDomainForOrg` ↔ `POST /domains`).
- Requirement **QUA-04** (lowercase + trim domain names at write time + backfill historical rows).

## Self-Check: PASSED

- FOUND: src/server/routes/domains.ts (modified, contains `normalizedName` on line 148)
- FOUND: supabase/migrations/021_lowercase_domains.sql (created, 51 lines)
- FOUND commit: 8925d34 (Task 1)
- FOUND commit: 08b8708 (Task 2)
