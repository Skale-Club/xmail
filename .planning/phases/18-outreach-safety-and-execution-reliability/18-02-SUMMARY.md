---
phase: 18-outreach-safety-and-execution-reliability
plan: 02
subsystem: outreach-sequences
tags: [state-machine, vitest, campaign-activation, fail-closed, scheduling]
requires:
  - phase: 18-01
    provides: Multi-project Vitest harness and shared fail-closed delivery-policy contract
provides:
  - Pure ordered sequence-action resolver for email, delay, completion, and quarantine outcomes
  - Stable activation issue codes for invalid canonical campaign sequences
  - Processor boundary that prevents non-email rows from creating claims or reaching providers
affects: [18-03, 18-04, 20-outreach-product-api-consistency]
tech-stack:
  added: []
  patterns: [discriminated sequence actions, timezone-aware transition scheduling, stable 422 issue contracts]
key-files:
  created:
    - src/server/lib/outreach-sequence-state.ts
    - src/server/lib/__tests__/outreach-sequence-state.test.ts
  modified:
    - src/server/routes/outreach/campaigns.ts
    - src/server/jobs/processOutreachSequences.ts
key-decisions:
  - "Explicit delay rows own their wait; an email advances to a following delay immediately so delayHours is applied exactly once."
  - "Until Phase 20 adds an explicit canonical-sequence field, activation validates the same oldest-created sequence used by lead enrollment."
  - "Activation failures return HTTP 422 with stable issues[].code values while retaining human-readable details for existing clients."
patterns-established:
  - "Resolve the current sequence row before send-window, account, claim, token, or provider work."
  - "Only the send_email union member carries provider-ready subject/body content."
requirements-completed: [SAFE-02, SAFE-06]
duration: 8 min
completed: 2026-07-16
---

# Phase 18 Plan 02: Type-safe Sequence Execution Summary

**Ordered sequence actions now transition delays without sending, quarantine unsupported or malformed rows, and reject invalid campaigns before activation.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-16T02:33:01Z
- **Completed:** 2026-07-16T02:40:33Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added a pure, tested state machine covering unordered input, delay transitions, completion, invalid email content, legacy conditions, and weekend/send-window rollover.
- Changed campaign activation to validate the canonical sequence and return stable `422` issue codes for unsupported or malformed configurations.
- Moved sequence resolution ahead of account/claim/provider work, with atomic delay transitions, configuration quarantine, and a hard email-type assertion immediately before dispatch.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Define sequence action behavior** — `7580ca6` (test)
2. **Task 1 GREEN: Implement ordered sequence actions** — `d16a2af` (feat)
3. **Task 2: Fail closed at activation and processor boundaries** — `53df58c` (fix)

**Plan metadata:** committed with this summary.

## Files Created/Modified

- `src/server/lib/outreach-sequence-state.ts` — Pure discriminated-union resolver, send-window scheduler, and activation validator.
- `src/server/lib/__tests__/outreach-sequence-state.test.ts` — Ten behavioral tests for transitions, quarantine, scheduling, completion, and stable issue codes.
- `src/server/routes/outreach/campaigns.ts` — Canonical sequence validation with stable `422` activation issues.
- `src/server/jobs/processOutreachSequences.ts` — Pre-claim sequence transitions/quarantine and email-only provider boundary.

## Decisions Made

- An explicit delay step becomes due immediately after the preceding email, then applies its own `delayHours` while advancing to the next row. This avoids applying the same wait twice and preserves email-only sequence timing.
- The oldest-created sequence remains canonical for both enrollment and activation until Phase 20 replaces the implicit selection rule.
- A missing current step completes safely without sending; a current row absent from its loaded sequence quarantines as configuration corruption.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Verification

- `npm run test -- src/server/lib/__tests__/outreach-sequence-state.test.ts` — 10/10 passed.
- `npm run test` — 35/35 passed across server, client, and disposable PostgreSQL projects.
- `npm run build` — Vite client and TypeScript server builds passed.
- `npm run lint` — ESLint passed with zero warnings.
- `rg -n -C 5 "sendOutreachEmail" src/server/jobs/processOutreachSequences.ts` — confirmed the non-email hard guard immediately precedes provider dispatch.

## Next Phase Readiness

- Plan 18-03 can build durable claims/retries on top of a processor that now admits only validated email actions into the attempt ledger.
- No blockers or production database actions are required from this plan.

## Self-Check: PASSED

All four plan artifacts exist, all task commits are present, every plan-level verification passed, and the worktree contained no unrelated changes.

---
*Phase: 18-outreach-safety-and-execution-reliability*
*Completed: 2026-07-16*
