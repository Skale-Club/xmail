---
phase: 18-outreach-safety-and-execution-reliability
plan: 04
subsystem: outreach-scheduling
tags: [vitest, postgres, dispatcher, idempotency, scheduling, completion]
requires:
  - phase: 18-01
    provides: Fail-closed delivery policy and disposable PostgreSQL test harness
  - phase: 18-02
    provides: Type-safe sequence action state machine
  - phase: 18-03
    provides: Lease-safe durable outreach dispatcher and migration 038
provides:
  - Deterministic per-inbox fair selection with a 200-row hard work cap
  - Dispatcher-only campaign, manual, and agentic send entrypoints
  - Persisted temporal deferrals and provider backpressure without hot-looping
  - Exhaustive shared terminal lead-status contract and locked campaign completion
affects: [19-provider-parity, 20-outreach-product-api-consistency, 21-unified-inbox]
tech-stack:
  added: []
  patterns: [origin-specific idempotency keys, shared dispatch provider adapters, ranked fair scheduling]
key-files:
  created:
    - src/server/lib/outreach-dispatch-provider.ts
    - src/server/lib/__tests__/outreach-scheduling.test.ts
    - src/server/lib/__tests__/outreach-entrypoints.test.ts
  modified:
    - src/server/jobs/processOutreachSequences.ts
    - src/server/jobs/processFollowUps.ts
    - src/server/routes/outreach/send-message.ts
    - src/server/lib/outreach-sequence-state.ts
    - src/server/lib/outreach-dispatch.ts
key-decisions:
  - "Rank due work per email account before applying the global hard cap so one inbox cannot starve the batch."
  - "All send origins enter dispatchOutreachMessage; provider capabilities live behind shared adapters."
  - "Campaign completion imports the same exhaustive terminal-status set used by due-work selection."
patterns-established:
  - "Temporal policy denials persist retryAt and suppress repeated provider/policy work for the same account or campaign in the current tick."
  - "Only a fresh status=sent result increments counters or emits sent events; duplicate recovery advances durable progress without double-counting."
requirements-completed: [SAFE-01, SAFE-03, SAFE-04, SAFE-05, SAFE-06]
duration: 16 min
completed: 2026-07-16
---

# Phase 18 Plan 04: Safe Outreach Entrypoints and Fair Scheduling Summary

**Campaign, manual, and agentic delivery now share one durable dispatcher while fair scheduling, persisted deferrals, and exhaustive terminal progress guarantee forward movement.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-07-16T03:08:00Z
- **Completed:** 2026-07-16T03:24:00Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Replaced the unordered lead scan with SQL `ROW_NUMBER()` ranking per sending account, deterministic hydration order, active/verified/enabled prefilters, and a 200-row cap.
- Routed campaign, manual, and agentic sends through `dispatchOutreachMessage` with stable origin-specific keys, lease-safe retries, current provider adapters, and no direct provider alternative in an entrypoint.
- Persisted policy `retryAt` values and in-tick account/campaign backpressure so repeated ticks advance eligibility instead of spinning.
- Activated campaign completion after every locked outreach tick, requiring at least one lead and treating `completedAt` or any exhaustive terminal engagement status as complete.

## Task Commits

1. **Task 1 RED: Define scheduling and terminal progress behavior** - `62a7011` (test)
2. **Task 1 GREEN: Implement exhaustive progress and fair selection** - `503c778` (feat)
3. **Task 2 RED: Define dispatcher-only entrypoint behavior** - `61907db` (test)
4. **Task 2 GREEN: Wire campaign, manual, and agentic dispatch** - `07c0c35` (feat)
5. **Task 3: Verify terminal campaign completion** - `98b27e6` (fix)

**Plan metadata:** committed with this summary and GSD tracking updates.

## Files Created/Modified

- `src/server/jobs/processOutreachSequences.ts` - Fair due-work SQL, dispatcher outcomes, backpressure, progress, and completion.
- `src/server/jobs/processFollowUps.ts` - Agentic idempotency and dispatcher-driven retry/deferral handling.
- `src/server/routes/outreach/send-message.ts` - Manual idempotency contract and structured dispatcher HTTP responses.
- `src/server/lib/outreach-dispatch-provider.ts` - Shared campaign and threaded provider adapters.
- `src/server/lib/outreach-sequence-state.ts` - Exhaustive lead progress map and pure fairness/completion helpers.
- `src/server/lib/outreach-dispatch.ts` - A/B ledger metadata carried through durable claims.
- `src/server/lib/outreach-sender.ts` - Stable Message-ID support for SMTP/native threaded delivery.
- `supabase/migrations/038_outreach_dispatch_state_machine.sql` - Backfill key aligned with the runtime campaign key contract.
- `src/server/lib/__tests__/outreach-scheduling.test.ts` - 25 terminal/fairness/completion tests.
- `src/server/lib/__tests__/outreach-entrypoints.test.ts` - Six adapter and dispatcher-only wiring tests.

## Decisions Made

- Used database window ranking rather than offset pagination: each account contributes rank 1 before any contributes rank 2, while `next_scheduled_at,id` remains stable within an account.
- Kept Outlook on its existing Graph payload capability. Phase 19 still owns MIME/header/threading parity; this plan only placed that capability behind the same durable dispatch boundary.
- Advanced sequence/follow-up progress on a durable `duplicate` result but did not increment counters or emit a second sent event.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Correctness] Aligned migration 038 keys and A/B ledger metadata**
- **Found during:** Task 2 (entrypoint dispatch wiring)
- **Issue:** Migration 038 backfilled `campaign:{lead}:step:{step}` while the required runtime key is `campaign:{lead}:{step}`, and the dispatcher claim omitted the selected A/B variant.
- **Fix:** Aligned the idempotency backfill and carried `abVariant` through the durable claim insert.
- **Files modified:** `supabase/migrations/038_outreach_dispatch_state_machine.sql`, `src/server/lib/outreach-dispatch.ts`
- **Verification:** Disposable PostgreSQL migration tests passed 4/4; full suite passed 84/84.
- **Committed in:** `07c0c35`

**2. [Rule 2 - Missing Critical] Added a shared provider adapter boundary**
- **Found during:** Task 2 (entrypoint dispatch wiring)
- **Issue:** `dispatchOutreachMessage` correctly requires an injected provider, but no shared adapter existed; defining provider work independently in each entrypoint would preserve alternate dispatch paths.
- **Fix:** Added campaign and threaded adapters and made every entrypoint depend on them.
- **Files modified:** `src/server/lib/outreach-dispatch-provider.ts`, `src/server/lib/outreach-sender.ts`
- **Verification:** Static entrypoint scan found no direct provider calls; six entrypoint tests passed.
- **Committed in:** `07c0c35`

---

**Total deviations:** 2 auto-fixed (1 correctness bug, 1 missing critical boundary).
**Impact on plan:** Both fixes were required to make the planned dispatcher contract internally consistent; no production database, deployment, or provider-parity expansion occurred.

## Issues Encountered

- The provider adapter test initially loaded the database through the Outlook module and then hit Vitest mock hoisting. Mock isolation was corrected; production code built throughout.

## User Setup Required

None - migration 038 remains an operator-applied production step; this execution did not touch a live database or deployment.

## Verification

- `npm run test` - PASS, 9 files / 84 tests, including 13 policy, 14 dispatcher, and 13 disposable PostgreSQL tests.
- `npm run build` - PASS, Vite client and TypeScript server.
- `npm run lint` - PASS, zero warnings.
- `npm run test -- src/server/lib/__tests__/outreach-scheduling.test.ts` - PASS, 25/25.
- `npm run test -- src/server/lib/__tests__/outreach-entrypoints.test.ts` - PASS, 6/6.
- Direct-dispatch `rg` gate - PASS; no `sendOutreachEmail`, `sendThreadedReply`, or `relayMessage` call exists in the three entrypoints.

## Next Phase Readiness

- Phase 18 is code-complete and ready for phase verification.
- Phase 19 can extend Outlook/SMTP provider parity behind `outreach-dispatch-provider.ts` without reopening entrypoint safety.
- Migration 038 must still be applied through the documented manual PostgreSQL runbook before deploying this dispatcher path.

## Self-Check: PASSED

All created artifacts exist, all five task commits are present, every plan-level verification passed, and no implementation changes remain uncommitted.

---
*Phase: 18-outreach-safety-and-execution-reliability*
*Completed: 2026-07-16*
