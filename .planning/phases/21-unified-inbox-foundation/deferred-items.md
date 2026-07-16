# Phase 21 — Deferred Items

Out-of-scope discoveries found during execution. Not fixed here (they are not caused
by the current task's changes); recorded so they are not lost.

## DEF-21-A — Phase 19 concurrent-claim db test flakes under full postgres load

- **Found during:** 21-01 final gate (`npm run test`).
- **Symptom:** `src/server/lib/__tests__/outreach-inbound-claim.db.test.ts`
  ("never hands one event to two concurrent workers" / "backs a failed event off")
  intermittently fails with `PostgresError: deadlock detected` inside `seedEvents`,
  and other postgres suites (e.g. `outreach-sequences-migration.db.test.ts`,
  `campaign-*.db.test.ts`) hit 5s/10s hook/test timeouts when the whole postgres
  project is run back-to-back on this machine.
- **Why it is not a Phase 21 regression:** The failure reproduces with the Phase 21
  test file EXCLUDED (`vitest run --project postgres --exclude '**/unified-inbox/**'`),
  i.e. with migration 041 never applied. Migration 041 only adds new tables and
  nullable columns (constant DEFAULTs → no table rewrite) and does not touch the
  `outreach_provider_events` INSERT/claim lock path exercised by that test. Run in
  isolation the claim test passes 6/6, and `npm run test` (all projects) is stable at
  439 passed / 1 flaky failure.
- **Root cause (pre-existing):** These suites share one disposable Testcontainers
  database and several deliberately drive concurrent transactions (FOR UPDATE SKIP
  LOCKED, org-wide queues). `vitest.config.ts` already sets `fileParallelism: false`
  for the postgres project for this reason; under heavy local Docker load the
  concurrent-worker tests still race on the shared catalog/rows.
- **Suggested follow-up (not this plan):** give the concurrency-sensitive Phase 19
  suites their own per-suite schema/database or an advisory lock around the concurrent
  sections, and/or raise `hookTimeout`/`testTimeout` for the postgres project. Owner:
  a future Phase 19 test-hardening task, not Unified Inbox.
