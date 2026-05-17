---
phase: 13-medium-consolidation
plan: 01
subsystem: quality
tags: [typescript, tsc, drizzle, webhooks, type-safety]

# Dependency graph
requires:
  - phase: 13-medium-consolidation
    provides: "13-06 schema field rename (organizations.ownerId / outreachEnabled) propagated to all call sites"
provides:
  - "Clean `npx tsc --noEmit` pass against both tsconfig.json and tsconfig.server.json"
  - "Typed event field in webhookRequests inserts (no `as any` escape hatch)"
  - "Type-check gate ready to be wired into CI in Phase 14 (CI-02)"
affects: [14-low-and-ci, ci, type-check-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Use Drizzle pgEnum-derived union types instead of `as any` for enum column inserts"

key-files:
  created: []
  modified:
    - src/server/lib/tracking.ts

key-decisions:
  - "Drop both `event: event as any` casts; the local WebhookEvent union already matches webhookEventEnum.enumValues so the typed insert builder accepts the value directly"
  - "AppLogo.tsx fix (audit M1) confirmed already in tree from prior phase work — no additional edit needed"
  - "No 13-06 fallout errors surfaced; Plan 13-06's grep+update was exhaustive"

patterns-established:
  - "Type-check cleanliness: zero `as any` / `@ts-ignore` / `@ts-expect-error` annotations allowed when the column type is statically derivable from the schema"

requirements-completed: [QUA-01]

# Metrics
duration: 4min
completed: 2026-05-16
---

# Phase 13 Plan 01: tsc-clean Summary

**Zero-error `npx tsc --noEmit` pass on both tsconfig.json and tsconfig.server.json, achieved by removing two `event as any` casts in tracking.ts (audit M12); AppLogo.tsx (audit M1) was already clean from prior work, and Plan 13-06's schema rename produced zero straggler call-site errors.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-16T23:32:21Z
- **Completed:** 2026-05-16T23:36:09Z
- **Tasks:** 2 (one collapsed — see Deviations)
- **Files modified:** 1

## Accomplishments
- `npx tsc --noEmit -p tsconfig.json` exits 0 with zero errors
- `npx tsc --noEmit -p tsconfig.server.json` exits 0 with zero errors
- `src/server/lib/tracking.ts` no longer uses `event: event as any` — Drizzle insert accepts the typed `WebhookEvent` union directly
- `npm run lint` still exits 0 (Phase 12 COR-07 gate stays green)
- Phase 14 CI-02 unblocked — type-check gate can now be wired as a required CI step

## Task Commits

Each task was committed atomically:

1. **Task 1 + Task 2 (combined): Remove `event as any` casts in tracking.ts** - `6712a58` (fix)

**Plan metadata:** (to be assigned by final commit step)

## Files Created/Modified
- `src/server/lib/tracking.ts` — Removed two `event: event as any` casts in `fireWebhooks` (success path + catch path of webhookRequests insert). Drizzle's typed insert builder accepts the value directly because the local `WebhookEvent` union exactly mirrors `webhookEventEnum.enumValues`.

## Decisions Made
- **Combined Task 1 + Task 2 into a single commit:** Task 2 was an iterative tsc-driven hunt for 13-06 fallout errors. Running tsc after the AppLogo + tracking.ts fixes produced zero residual errors on both configs, so there was no work to commit separately for Task 2. The combined commit (Task 1's content) satisfies both task done-criteria.
- **AppLogo.tsx required no edit:** Re-read confirmed the file already destructures `const { branding } = useBranding()` with no `isSuccess` — audit M1 was resolved in earlier phase work (likely Phase 12 lint cleanup). Confirmed via `noUnusedLocals: true` strict pass.
- **Did not touch the `.kilo/package-lock.json` untracked file:** Pre-existing untracked state, unrelated to QUA-01 scope. Left for a future cleanup pass.

## Deviations from Plan

**1. [Rule 3 - Blocking] None — Task 2 was empty work**

- **Found during:** Task 2 baseline tsc runs
- **Issue:** Plan 13-06's schema field rename (`owner_id` → `ownerId`, `outreach_enabled` → `outreachEnabled`) was anticipated to leave behind some straggler call-site errors that tsc would surface here. Zero such errors surfaced — 13-06's sweep was complete.
- **Fix:** None needed. Task 2's done-criteria are auto-satisfied because both tsc invocations already exit 0 after Task 1.
- **Files modified:** None
- **Verification:** `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.server.json && echo TSC_CLEAN` → prints `TSC_CLEAN`. `grep` for `.owner_id` / `.outreach_enabled` TS property accesses in `src/` → zero matches.
- **Committed in:** N/A (no code change)

---

**Total deviations:** 0 functional deviations. One process compression (Task 1 + Task 2 → single commit) documented under Decisions Made.
**Impact on plan:** None — all done-criteria satisfied, both verification commands pass.

## Issues Encountered
None.

## Verification Results

```text
$ npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.server.json && echo TSC_CLEAN
TSC_CLEAN

$ grep -n "as any" src/server/lib/tracking.ts
(no matches)

$ grep -rn "\.owner_id\|\.outreach_enabled" src/
(no matches)

$ npm run lint
> skaleclub-mail@1.0.0 lint
> eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0
(exit 0)
```

All five verification block items pass:
1. ✓ tsconfig.json tsc exits 0
2. ✓ tsconfig.server.json tsc exits 0
3. ✓ Zero `as any` on `event` field in tracking.ts
4. ✓ Zero `.owner_id` / `.outreach_enabled` TS property accesses anywhere in src/ (the only remaining occurrences are SQL column-name strings inside `text('owner_id')` / `boolean('outreach_enabled')` in `src/db/schema.ts` and JSON wire-format key in `src/server/routes/system.ts:416`, both expected and explicitly allowed)
5. ✓ `npm run lint` exits 0

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness
- Phase 13 has one plan remaining (13-04). After it completes, Phase 13 closes and Phase 14 begins.
- Phase 14 CI-02 (CI tsc gate) is unblocked — both tsc configs now pass cleanly and the gate can be wired as a required CI step on day one.

## Self-Check: PASSED

- FOUND: src/server/lib/tracking.ts (modified, 2 deletions / 2 insertions)
- FOUND: commit 6712a58 in git log
- FOUND: .planning/phases/13-medium-consolidation/13-01-SUMMARY.md (this file)
- tsc both configs: exit 0
- lint: exit 0

---
*Phase: 13-medium-consolidation*
*Completed: 2026-05-16*
