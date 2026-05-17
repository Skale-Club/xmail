---
phase: 09-schema-hardening
plan: "01"
subsystem: database
tags: [schema, constraints, migrations, drizzle]
dependency_graph:
  requires: []
  provides: [schema-check-constraints, migration-deprecation]
  affects: [sequence_steps]
tech_stack:
  added: [drizzle-check-constraints]
  patterns: [check-constraints, migration-deprecation]
key_files:
  created: []
  modified:
    - path: src/db/schema.ts
      reason: Added CHECK constraints to sequenceSteps table
    - path: supabase/migrations/013_add_performance_indexes.sql
      reason: Added deprecation comment header
decisions:
  - "Used Drizzle .check() API (available in project's drizzle-orm version) instead of raw SQL migration"
metrics:
  duration: "< 1 minute"
  completed_date: "2026-04-01"
  tasks_completed: "2/2"
  files_modified: 2
---

# Phase 09 Plan 01: Schema Hardening — CHECK Constraints & Migration Deprecation Summary

Add CHECK constraints to prevent invalid data in sequence_steps and deprecate the now-superseded performance indexes migration file.

## Tasks Completed

### Task 1: Add CHECK Constraints to sequenceSteps (SCH-01)
- Imported `check` from `drizzle-orm/pg-core`
- Added `sequence_steps_delay_hours_positive` constraint: `delayHours >= 0`
- Added `sequence_steps_order_positive` constraint: `stepOrder >= 1`
- Both constraints defined using Drizzle's `.check()` API in the table's index/constraint callback
- **Commit:** `7c24c56`

### Task 2: Deprecate 013_add_performance_indexes.sql (SCH-02)
- Added deprecation comment header at top of file (before line 1)
- Header explains indexes are now managed via Drizzle `index()` API in `src/db/schema.ts` (Phase 06)
- Original SQL content preserved untouched
- **Commit:** `8beec5e`

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- ✅ `sequence_steps_delay_hours_positive` found in `src/db/schema.ts` (line 825)
- ✅ `sequence_steps_order_positive` found in `src/db/schema.ts` (line 826)
- ✅ `013_add_performance_indexes.sql` has DEPRECATED comment header (lines 1-5)
- ✅ `npm run build` — passed (client + server)

## Requirements Satisfied

- **SCH-01:** CHECK constraints on `sequence_steps.delay_hours >= 0` and `sequence_steps.step_order >= 1` exist in schema.ts
- **SCH-02:** `013_add_performance_indexes.sql` has deprecation comment header

## Known Stubs

None.

## Self-Check: PASSED
