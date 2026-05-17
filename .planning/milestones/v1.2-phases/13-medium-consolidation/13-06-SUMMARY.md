---
phase: 13-medium-consolidation
plan: 06
subsystem: database
tags: [drizzle, schema, typescript, naming-conventions, refactor]

# Dependency graph
requires:
  - phase: 12-high-correctness
    provides: outreach global-toggle handlers (system.ts) using outreach_enabled column
provides:
  - organizations.ownerId (TS) -> SQL column owner_id (unchanged)
  - organizations.outreachEnabled (TS) -> SQL column outreach_enabled (unchanged)
  - organizationsRelations.owner.fields references organizations.ownerId
  - Uniform camelCase convention across entire src/db/schema.ts
affects: [13-01 (tsc-clean safety net), future-plans-touching-organizations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Drizzle TS-key vs SQL-column decoupling now uniform across schema"

key-files:
  created: []
  modified:
    - src/db/schema.ts
    - src/server/routes/organizations.ts
    - src/server/routes/system.ts
    - src/pages/admin/OrganizationsPage.tsx
    - src/pages/admin/OrganizationDetailPage.tsx
    - scripts/check-full.ts
    - scripts/check-org.ts
    - scripts/fix-org-link.ts
    - scripts/test-cascade-delete.ts

key-decisions:
  - "Renamed Drizzle SELECT alias outreach_enabled -> enabled in system.ts (option a in plan) for internal consistency"
  - "Preserved JSON wire-format key outreach_enabled in res.json({...}) responses to avoid frontend ripple breakage"
  - "Extended rename sweep into scripts/ (4 files) — direct Drizzle property accesses would have broken tsc otherwise (Rule 3 — blocking)"

patterns-established:
  - "TS field names follow camelCase, SQL column strings follow snake_case, wire-format JSON keys follow snake_case for stable API contract"

requirements-completed: [QUA-08]

# Metrics
duration: 3min
completed: 2026-05-16
---

# Phase 13 Plan 06: Schema field rename to camelCase (QUA-08) Summary

**Renamed `organizations.owner_id` -> `ownerId` and `organizations.outreach_enabled` -> `outreachEnabled` in Drizzle schema, swept all 9 touching files, both `tsc --noEmit` configs clean.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-05-16T23:26:10Z
- **Completed:** 2026-05-16T23:28:31Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- `src/db/schema.ts`: 2 column TS-key renames + 1 relations-block field reference update; SQL column names preserved verbatim (`'owner_id'`, `'outreach_enabled'`).
- All 4 known call sites in `src/server/routes/organizations.ts` updated (insert payload + 3 owner guards).
- All 6 known call sites in `src/server/routes/system.ts` updated; SELECT aliases renamed from `outreach_enabled` -> `enabled` for internal symmetry; JSON wire-format keys preserved for frontend contract.
- 2 admin pages: local TS interfaces + JSX consumer updated.
- 4 script files (`scripts/check-full.ts`, `scripts/check-org.ts`, `scripts/fix-org-link.ts`, `scripts/test-cascade-delete.ts`) updated — direct Drizzle property accesses that would have failed `tsc --noEmit`.
- `npx tsc --noEmit` (default) and `npx tsc --noEmit -p tsconfig.server.json` both pass with zero output.

## Task Commits

1. **Task 1: Rename TS keys in src/db/schema.ts** - `a2af0d9` (refactor)
2. **Task 2: Update all known caller sites + scripts/ sweep** - `00f967e` (refactor)

## Files Created/Modified
- `src/db/schema.ts` - `organizations.ownerId`, `organizations.outreachEnabled`, `organizationsRelations.owner.fields`
- `src/server/routes/organizations.ts` - 4 call sites: insert payload + 3 owner-guard checks
- `src/server/routes/system.ts` - 2 SELECT-alias renames (`outreach_enabled` -> `enabled` for internal use), 1 `.set()` payload key (`outreachEnabled`); JSON response key `outreach_enabled` intentionally preserved as wire contract
- `src/pages/admin/OrganizationsPage.tsx` - interface field `ownerId: string`
- `src/pages/admin/OrganizationDetailPage.tsx` - interface field + JSX prop source (`org.ownerId`)
- `scripts/check-full.ts` - 2 logging accesses to `org.ownerId`
- `scripts/check-org.ts` - 1 logging access
- `scripts/fix-org-link.ts` - 5 accesses (logging + `.set({ ownerId })`)
- `scripts/test-cascade-delete.ts` - 2 seed-data insert payloads

## Decisions Made
- **SELECT alias rename** (system.ts L411, L453): Option (a) from plan — renamed alias from `outreach_enabled` to `enabled` for internal-use clarity. The downstream consumer is co-located in the same function body, so the rename is self-contained. No cross-file ripple.
- **JSON wire-format preservation** (system.ts L416-419): `res.json({ outreach_enabled, enabled_count, total_count })` left as snake_case. The frontend already consumes this contract; flipping it would force an unrelated breaking change. The whole point of TS-vs-SQL decoupling in Drizzle is to allow these three layers (TS field, SQL column, JSON wire) to evolve independently.
- **Scripts/ scope expansion** (Rule 3 — blocking): The plan flagged scripts as "risk handled by 13-01 in Wave 2", but `tsc --noEmit` includes `scripts/` and would have surfaced these as hard errors. Fixing them now satisfies the plan's verification step (`npx tsc --noEmit` passes) and removes a guaranteed straggler.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extended rename sweep into `scripts/` directory**
- **Found during:** Task 2 (broader grep sweep across `src/` + `scripts/`)
- **Issue:** 4 scripts (`check-full.ts`, `check-org.ts`, `fix-org-link.ts`, `test-cascade-delete.ts`) use `org.owner_id` and `.set({ owner_id })` directly via Drizzle. These are real TS property accesses, not log strings — `tsc --noEmit` would fail because the schema property no longer exists under that name.
- **Fix:** Updated all property accesses to `ownerId` (10 total spots across 4 files). Kept the user-facing log string text containing the literal phrase `owner_id` since that's display text describing the SQL column, not a JS access.
- **Files modified:** `scripts/check-full.ts`, `scripts/check-org.ts`, `scripts/fix-org-link.ts`, `scripts/test-cascade-delete.ts`
- **Verification:** `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.server.json` both pass with zero output.
- **Committed in:** `00f967e` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Strictly within plan scope — the plan explicitly stated "broader grep across `src/`" and flagged scripts/ as a risk handled by Wave 2; resolving them inline removes that residual risk and lets this plan deliver a fully tsc-clean rename on its own. No scope creep.

## Issues Encountered
- None. The rename was mechanical; the grep enumerated every call site; both tsc configs passed first try after the sweep.

## User Setup Required

None - this is a pure refactor. No env vars, no migrations, no manual steps.

## Next Phase Readiness
- **13-01 (Wave 2, tsc-clean):** This plan already delivered tsc-clean status as a side-effect (broader sweep was extended into scripts/). 13-01 will be a trivial confirmation step.
- ROADMAP success criterion #7 for Phase 13 satisfied: `organizations.ownerId` and `organizations.outreachEnabled` (camelCase) are used in TypeScript; SQL columns remain `owner_id` / `outreach_enabled`.
- Closes audit finding M13.

## Self-Check: PASSED

Verifications run after writing this SUMMARY:
- `src/db/schema.ts` matches `ownerId: uuid('owner_id')` and `outreachEnabled: boolean('outreach_enabled')` (one match each).
- `organizationsRelations.owner.fields` references `organizations.ownerId`.
- Commit `a2af0d9` exists in `git log`.
- Commit `00f967e` exists in `git log`.
- Both `tsc --noEmit` runs (default + tsconfig.server.json) exit with zero output.
- No remaining TS property accesses to `.owner_id` or `.outreach_enabled` across `src/` and `scripts/`. Remaining grep matches are: SQL column strings (schema.ts), JSON wire-format key (system.ts L416), display-text log strings + comments (scripts/).

---
*Phase: 13-medium-consolidation*
*Completed: 2026-05-16*
