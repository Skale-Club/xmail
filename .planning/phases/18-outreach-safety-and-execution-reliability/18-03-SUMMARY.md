---
phase: 18-outreach-safety-and-execution-reliability
plan: 03
subsystem: outreach-dispatch
tags: [postgresql, idempotency, leases, retry, smtp, vitest]
requires:
  - phase: 18-01
    provides: Guarded disposable PostgreSQL harness and shared fail-closed delivery policy
provides:
  - Origin-aware outreach attempt ledger with organization-scoped idempotency
  - Lease-safe claim, policy, dispatch, retry, finalize, and ambiguity state machine
  - Normalized provider acceptance/failure metadata with bounded exponential backoff
affects: [18-04, 19-provider-parity, 21-unified-inbox, 23-ai-automation]
tech-stack:
  added: []
  patterns: [lease-token finalization, injected repository/provider adapters, ambiguity quarantine]
key-files:
  created:
    - supabase/migrations/038_outreach_dispatch_state_machine.sql
    - src/server/lib/outreach-dispatch.ts
    - src/server/lib/__tests__/outreach-dispatch.test.ts
    - src/server/lib/__tests__/outreach-dispatch-migration.db.test.ts
  modified:
    - src/db/schema.ts
    - src/server/lib/outreach-sender.ts
key-decisions:
  - "A provider outcome with unknown acceptance is held permanently; only explicit pre-acceptance negative outcomes can retry."
  - "Every finalize mutation is conditioned on the owning lease token, while policy-race release is allowed only before dispatch_started_at."
  - "Stable Message-IDs are derived from organization plus logical idempotency key and are passed only to providers that support them."
patterns-established:
  - "Dispatch adapters: pure orchestration receives injected policy, repository, provider, clock, and lease-token dependencies."
  - "Safe recovery: stale pre-dispatch leases may be reclaimed; stale post-dispatch leases become held."
requirements-completed: [SAFE-01, SAFE-03, SAFE-06]
duration: 18 min
completed: 2026-07-16
---

# Phase 18 Plan 03: Durable Outreach Dispatch Summary

**Origin-aware outreach delivery now uses durable idempotency keys, lease-token ownership, bounded retries, and fail-safe quarantine for ambiguous provider acceptance.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-16T02:44:00Z
- **Completed:** 2026-07-16T03:02:25Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments

- Added hand-written migration 038 and its Drizzle type mirror for origins, recipients, idempotency, attempts, leases, retry timing, dispatch start, and error codes.
- Implemented an injected claim-policy-dispatch-finalize state machine with atomic SQL claims and a production default adapter.
- Retries only explicit negative pre-acceptance outcomes with capped exponential backoff; terminal failures stop and unknown acceptance becomes `held`.
- Extended the existing outreach sender with stable Message-ID support and normalized acceptance/failure metadata without logging content or credentials.
- Proved the migration is rerunnable and the SQL adapter handles contention, pre-dispatch reclaim, and post-dispatch hold in the protected disposable PostgreSQL harness.

## Task Commits

1. **Task 1: Add the hand-written dispatch-state migration and schema mirror** — `5125b8b` (feat)
2. **Task 2 RED: Define durable dispatch behavior** — `ec350c9` (test)
3. **Task 2 GREEN: Implement lease-safe dispatch** — `a3b723c` (feat)

**Plan metadata:** committed with this summary.

## Files Created/Modified

- `supabase/migrations/038_outreach_dispatch_state_machine.sql` — Durable ledger columns, backfill, checks, and dispatch indexes.
- `src/db/schema.ts` — Exact TypeScript mirror for migration 038.
- `src/server/lib/outreach-dispatch.ts` — Injected state machine and atomic PostgreSQL repository.
- `src/server/lib/outreach-sender.ts` — Provider acceptance classification and stable Message-ID handoff.
- `src/server/lib/__tests__/outreach-dispatch.test.ts` — Unit coverage for leases, retries, policy races, duplicates, and stale-token finalization.
- `src/server/lib/__tests__/outreach-dispatch-migration.db.test.ts` — Rerunnable migration and real SQL repository coverage against disposable PostgreSQL.
- `src/server/jobs/processBounces.ts`, `src/server/jobs/processReplies.ts`, `src/server/routes/track.ts`, `src/server/routes/outreach/campaigns.ts` — Campaign-only guards after origin linkage became nullable.
- `src/server/jobs/processOutreachSequences.ts` — Transitional legacy claim now supplies migration-038 required fields until Plan 18-04 replaces it with the dispatcher.

## Decisions Made

- Ordinary SMTP cannot prove exactly-once delivery after remote acceptance and process loss, so ambiguous outcomes prefer a visible held record over automatic resend.
- SMTP 4xx, HTTP 408/429/5xx, DNS failures, and connection failures known to precede DATA are retryable; SMTP 5xx, auth/content/HTTP terminal errors are not.
- The default repository is backed by the application PostgreSQL client, while tests inject the guarded disposable client directly and never fall back to `DATABASE_URL`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Guarded campaign-only consumers after nullable origin linkage**
- **Found during:** Task 1 build verification
- **Issue:** Making campaign, campaign-lead, sequence-step, and tracking-token fields nullable correctly widened the ledger, but legacy bounce, reply, tracking, campaign-metric, and claim code assumed every row was campaign-owned and no longer type-checked.
- **Fix:** Added explicit campaign-link guards, skipped campaign-only aggregation/notifications for other origins, and supplied the new required recipient/idempotency fields in the transitional legacy claim.
- **Files modified:** `src/server/jobs/processBounces.ts`, `src/server/jobs/processReplies.ts`, `src/server/routes/track.ts`, `src/server/routes/outreach/campaigns.ts`, `src/server/jobs/processOutreachSequences.ts`
- **Verification:** Full server/client build and all 53 tests passed.
- **Committed in:** `5125b8b`

**2. [Rule 2 - Missing Critical] Exercised the production SQL adapter against disposable PostgreSQL**
- **Found during:** Task 2 GREEN verification
- **Issue:** Pure injected tests proved orchestration but would not detect invalid atomic-claim SQL or enum/cast behavior in the default repository.
- **Fix:** Made the SQL client injectable beneath the default adapter and added a guarded database test for active contention, stale pre-dispatch reclaim, stale post-dispatch hold, and persisted error state.
- **Files modified:** `src/server/lib/outreach-dispatch.ts`, `src/server/lib/__tests__/outreach-dispatch-migration.db.test.ts`
- **Verification:** Targeted PostgreSQL suite passed 4/4 and the complete suite passed 53/53.
- **Committed in:** `a3b723c`

---

**Total deviations:** 2 auto-fixed (1 blocking compatibility issue, 1 missing critical integration verification).
**Impact on plan:** Both changes were required to keep the widened ledger safe and prove the production adapter; no provider entrypoint wiring from Plan 18-04 was pulled forward.

## Issues Encountered

None unresolved. No migration was applied to the application or production `DATABASE_URL`.

## User Setup Required

None. Production migration application remains a deliberate manual/deployment action:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/038_outreach_dispatch_state_machine.sql
```

## Verification

- `npm run test` — PASS, 7 files / 53 tests.
- `npm run test -- src/server/lib/__tests__/outreach-dispatch.test.ts src/server/lib/__tests__/outreach-dispatch-migration.db.test.ts` — PASS, 18/18.
- `npm run build` — PASS, Vite client and TypeScript server.
- `npm run lint` — PASS, zero warnings.
- Migration 038 applied twice only through the guarded disposable PostgreSQL URL — PASS.

## Next Phase Readiness

- Ready for `18-04-PLAN.md` to replace direct campaign, manual, and agentic provider calls with `dispatchOutreachMessage`.
- The temporary legacy campaign claim has the new required fields but does not yet use leases; Plan 18-04 owns that entrypoint wiring as planned.

## TDD Gate Compliance

- **RED:** `ec350c9` — 12 behavioral tests failed on the deliberate unimplemented state machine.
- **GREEN:** `a3b723c` — 14 unit tests and 4 disposable-PostgreSQL tests pass.
- **REFACTOR:** No separate refactor commit was needed; classification corrections were completed before the GREEN commit.

## Self-Check: PASSED

All plan artifacts exist, every task commit is present, the migration and SQL adapter were verified only against disposable PostgreSQL, and all plan-level verification commands passed.

---
*Phase: 18-outreach-safety-and-execution-reliability*
*Completed: 2026-07-16*
