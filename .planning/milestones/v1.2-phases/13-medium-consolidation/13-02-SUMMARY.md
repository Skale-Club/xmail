---
phase: 13-medium-consolidation
plan: 02
subsystem: docs/migrations
tags: [migrations, docs, drizzle, schema, qua-02]
dependency-graph:
  requires: []
  provides:
    - "Archived deprecated migration 013 (preserved in git history under supabase/migrations/archive/)"
    - "Clean package.json scripts (no foot-gun db:generate/db:push)"
    - "Authoritative Schema & Migration Workflow doc in CLAUDE.md + README.md"
  affects:
    - "Future contributors / future Claude executors editing src/db/schema.ts"
    - "Audit findings M2 (deprecated migration in active dir), M3 (drizzle-kit deprecated syntax), M4 (no schema workflow doc) — all closed"
tech-stack:
  added: []
  patterns:
    - "Archived migrations relocate to supabase/migrations/archive/ with ARCHIVED comment block"
    - "Hand-written SQL migrations are canonical (NOT drizzle-kit generate)"
key-files:
  created:
    - "supabase/migrations/archive/013_add_performance_indexes.sql (via git mv)"
  modified:
    - "package.json (removed db:generate, db:push)"
    - "CLAUDE.md (added ### Schema & Migration Workflow)"
    - "README.md (added ### Schema & Migration Workflow + fixed Installation step 5)"
decisions:
  - "Option (a) chosen: REMOVE db:generate / db:push from package.json (not just neuter them). Documentation alone does not prevent accidental execution against drifted DB. Future contributor wanting Drizzle-generated migrations must re-add scripts with intent."
  - "README.md Installation step 5 corrected: replaced `npm run db:push` with a `psql` loop applying supabase/migrations/[0-9]*.sql in filename order, with link to new workflow section. Rule 2 deviation: leaving the old instruction would directly contradict the new doc."
metrics:
  duration: "~7 minutes"
  completed: "2026-05-16T23:27:00Z"
  tasks: 2
  files_modified: 4
---

# Phase 13 Plan 02: Migration 013 Archive + Schema Workflow Documentation Summary

One-liner: Archived deprecated `013_add_performance_indexes.sql` to `supabase/migrations/archive/`, removed `db:generate`/`db:push` scripts from `package.json`, and added authoritative `### Schema & Migration Workflow` documentation to both `CLAUDE.md` and `README.md` — closing audit findings M2/M3/M4.

## What Changed

### Task 1 — Archive migration 013 and update package.json (commit `4a1d894`)

- `git mv supabase/migrations/013_add_performance_indexes.sql supabase/migrations/archive/013_add_performance_indexes.sql` — preserved as rename in history (93% similarity reported by git).
- Prepended a new ARCHIVED comment block to the archived file, citing Phase 13 QUA-02 / audit M2, and pointing users to `npm run db:indexes` for index changes (the prior DEPRECATED comment block is retained below it for historical continuity).
- Removed two scripts from `package.json`:
  ```diff
  -        "db:generate": "drizzle-kit generate:pg",
  -        "db:push": "drizzle-kit push:pg",
  ```
- Kept `db:studio` (read-only Drizzle Studio), `db:indexes`, `db:rls`, `db:audit` — these are still useful and safe.

### Task 2 — Schema & Migration Workflow documentation (commit `70a5262`)

- Added a new `### Schema & Migration Workflow` subsection inside the `## Database` section of `CLAUDE.md`.
- Added the same subsection (verbatim) to `README.md`, immediately after the "Database Schema" table.
- Both docs now contain identical guidance — no contradictions between agent-facing and contributor-facing docs.
- Documented:
  - Canonical sources: `src/db/schema.ts` (TS types) + `supabase/migrations/NNN_*.sql` (DB source of truth) + `sql/indexes.sql` (indexes via CONCURRENTLY).
  - DO: edit schema.ts → write matching hand-rolled SQL → apply via psql.
  - DO NOT: run `drizzle-kit generate` (would conflict with hand-rolled SQL accumulated since `drizzle/0000_dear_wolverine.sql`).
  - Numbering convention: sequential integers, 001-019 used as of 2026-05-16, 020 reserved for `020_consolidate_rls.sql` (QUA-03).
- Fixed README.md Installation step 5: replaced `npm run db:push` (which is now removed) with a `psql` loop applying `supabase/migrations/[0-9]*.sql` in filename order, and linked to the new workflow section.

## Verification Results

| Check                                                                   | Result |
| ----------------------------------------------------------------------- | ------ |
| `test -f supabase/migrations/archive/013_add_performance_indexes.sql`   | OK     |
| `test ! -f supabase/migrations/013_add_performance_indexes.sql`         | OK     |
| `package.json` has no `db:generate` / `db:push` keys (node `require` check) | OK |
| `grep -q "Schema & Migration Workflow" CLAUDE.md`                       | OK     |
| `grep -q "Schema & Migration Workflow" README.md`                       | OK     |

All five verification gates from the plan pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] README Installation step 5 still referenced `npm run db:push`**
- **Found during:** Task 2 — after removing `db:push` from `package.json` (Task 1), README.md still instructed new contributors to run it.
- **Issue:** Leaving the stale instruction would directly contradict the newly added "DO NOT" section and resurrect the exact confusion the plan was designed to eliminate.
- **Fix:** Replaced the step with a `psql` loop over `supabase/migrations/[0-9]*.sql` and a cross-link to the new "Schema & Migration Workflow" section.
- **Files modified:** `README.md`
- **Commit:** `70a5262` (folded into Task 2 commit as it is the same doc-coherence change)

### Out-of-scope discoveries (NOT fixed)

- `src/server/lib/native-mail.ts` and `src/server/routes/organizations.ts` show as modified in `git status` at session start — pre-existing changes unrelated to this plan, left untouched per SCOPE BOUNDARY rule.
- `.kilo/package-lock.json` untracked — pre-existing, unrelated.

## Authentication Gates

None — fully autonomous execution.

## Decisions Made

1. **Remove `db:generate`/`db:push` outright (Option a) rather than neuter them (Option b).** The plan called option (a) the right one; we followed it. Rationale: documentation cannot stop muscle-memory `npm run db:generate`, but a missing script literally cannot run.
2. **Patched README Installation step 5 as part of Task 2** rather than as a separate deviation commit. The change is one cohesive doc-coherence edit; splitting it would have made the docs commit history less reviewable.

## Audit Findings Closed

- **M2** — Deprecated migration `013_add_performance_indexes.sql` in active dir → moved to `supabase/migrations/archive/`.
- **M3** — Schema drift makes `db:generate` destructive → script removed; future contributors physically cannot trigger it accidentally.
- **M4** — Stale `drizzle-kit 0.20.17` syntax (`generate:pg`, `push:pg`) in `package.json` → both scripts removed; remaining `db:studio` script uses syntax compatible with the pinned drizzle-kit version.

## Commits

| Hash    | Task | Message                                                                                  |
| ------- | ---- | ---------------------------------------------------------------------------------------- |
| 4a1d894 | 1    | chore(13-02): archive migration 013 and remove stale drizzle-kit scripts                |
| 70a5262 | 2    | docs(13-02): document schema/migration workflow in CLAUDE.md and README.md              |

## Self-Check: PASSED

- FOUND: `supabase/migrations/archive/013_add_performance_indexes.sql`
- CONFIRMED: `supabase/migrations/013_add_performance_indexes.sql` no longer exists
- FOUND: `.planning/phases/13-medium-consolidation/13-02-SUMMARY.md`
- FOUND: commit `4a1d894` in git log
- FOUND: commit `70a5262` in git log
