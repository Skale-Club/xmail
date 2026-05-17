---
phase: 05-rls-migration-safety
plan: "02"
subsystem: database
tags: [indexes, migration, postgresql, concurrently, safety]
dependency_graph:
  requires: []
  provides:
    - sql/indexes.sql (CONCURRENTLY index scaffold)
    - scripts/verify-indexes.ts (index health checker)
    - npm run db:indexes script
  affects:
    - Phase 06 (will populate indexes.sql with all required indexes)
    - Database write availability during index operations
tech_stack:
  added: []
  patterns:
    - postgresql: CREATE INDEX CONCURRENTLY for non-blocking index creation
    - postgres: direct connection via postgres library (not Drizzle)
    - npm script: psql invocation for transaction-free SQL execution
key_files:
  created:
    - sql/indexes.sql
    - scripts/verify-indexes.ts
  modified:
    - package.json
decisions:
  - CONCURRENTLY via separate SQL file: db:push wraps transactions which blocks CONCURRENTLY; psql executes directly
  - postgres library for verification: matches existing db connection pattern from src/db/index.ts
  - Minimal indexes.sql scaffold: actual indexes deferred to Phase 06 (index foundation)
  - Drop-and-recreate for invalid indexes: safer than trying to fix corrupted index entries
metrics:
  duration: "0h:1m"
  completed: "2026-03-31"
---

# Phase 05 Plan 02: Safe Index Migration Workflow (DBS-02, DBS-03) Summary

## One-Liner

Infrastructure for safe, non-blocking index creation via `CREATE INDEX CONCURRENTLY` executed through a dedicated npm script, with automated index health verification and invalid index recovery.

## What Was Built

### 1. sql/indexes.sql — CONCURRENTLY Index Scaffold
- Header comment explaining CONCURRENTLY requirements and execution method
- Placeholder for Phase 06 to populate with FK/composite indexes
- Example index on `messages(organization_id)` to prove the workflow works
- Designed for execution via `npm run db:indexes` (outside transactions)

### 2. scripts/verify-indexes.ts — Index Health Checker
- Connects to database using `postgres` library with `DATABASE_URL`
- Queries `pg_index` joined with `pg_class` and `pg_namespace` for all public schema indexes
- Checks `indisvalid` flag on each index (false = failed creation, e.g., interrupted CONCURRENTLY)
- For invalid indexes: logs name/table, drops with `DROP INDEX CONCURRENTLY`, re-creates from `sql/indexes.sql`, re-checks validity
- Prints summary: total, valid, invalid counts
- Exits with code 0 on success, 1 if any indexes remain invalid after retry

### 3. package.json — db:indexes Script
- Added `"db:indexes": "psql \"$DATABASE_URL\" -f sql/indexes.sql"`
- Runs SQL file directly via psql (no transaction wrapping) — required for CONCURRENTLY

## Task Log

| # | Task | Commit | Status |
|---|------|--------|--------|
| 1 | Create sql/indexes.sql with CONCURRENTLY statements | `9039c8e` | ✅ |
| 2 | Add db:indexes script and create index verification | `6c5d8b2` | ✅ |

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- [x] `npm run db:indexes` script exists pointing to `psql -f sql/indexes.sql`
- [x] `sql/indexes.sql` exists with `CREATE INDEX CONCURRENTLY` statements
- [x] `scripts/verify-indexes.ts` exists, connects to DB, checks `indisvalid`, drops/retries invalid indexes
- [x] `tsx` can execute the verification script (runs successfully, found 98 existing indexes)

## What's Next

Phase 06 (Index Foundation) will populate `sql/indexes.sql` with all required FK and composite indexes. The workflow established here ensures those indexes will be created without blocking writes.

## Self-Check: PASSED
