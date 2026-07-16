---
phase: 18-outreach-safety-and-execution-reliability
plan: 01
subsystem: testing
tags: [vitest, testing-library, testcontainers, postgresql, outreach-policy]
requires:
  - phase: 17-observability-foundation
    provides: outreach sender, processor, account throttling, and structured operational context
provides:
  - Multi-project Vitest harness for Node TypeScript, jsdom React TSX, and PostgreSQL integration tests
  - Guarded disposable PostgreSQL lifecycle that cannot fall back to application DATABASE_URL
  - Shared fail-closed outreach delivery policy with stable denial codes and retry timestamps
affects: [18-02, 18-03, 18-04, 19-provider-parity, 21-unified-inbox]
tech-stack:
  added: [vitest, jsdom, testing-library, testcontainers]
  patterns: [injected policy snapshots, dynamic database adapter import, guarded explicit migration targets]
key-files:
  created:
    - vitest.config.ts
    - src/test/postgres-harness.ts
    - src/test/postgres-global-setup.ts
    - src/server/lib/outreach-delivery-policy.ts
  modified: [package.json, package-lock.json]
key-decisions:
  - "All outreach origins share one stable allow/deny contract; origin never bypasses safety checks."
  - "Database tests accept only guarded loopback PostgreSQL URLs whose database name contains a test marker."
  - "Disposable setup uses the baseline plus outreach-relevant migrations; feature migrations are explicit because historical Drizzle and SQL snapshots conflict."
patterns-established:
  - "Canonical test invocation: npm run test -- <file>."
  - "Pure policy evaluation receives injected snapshots; the default Drizzle loader dynamically imports the database."
  - "Migration helpers require an explicit guarded URL and never read DATABASE_URL internally."
requirements-completed: [SAFE-01, SAFE-06]
duration: 13 min
completed: 2026-07-16
---

# Phase 18 Plan 01: Test Harness and Delivery Policy Summary

**Multi-environment Vitest coverage, disposable PostgreSQL isolation, and a fail-closed outreach policy now provide the safety contract for every send origin.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-07-16T02:13:09Z
- **Completed:** 2026-07-16T02:26:40Z
- **Tasks:** 3
- **Files modified:** 11

## Accomplishments

- Added mutually exclusive Vitest projects for server `.ts`, React `.tsx`, and `.db.test.ts` files with one canonical targeted command.
- Added a Testcontainers PostgreSQL 16 harness with hard guards against missing run markers, remote hosts, non-test database names, non-PostgreSQL URLs, and reuse of `DATABASE_URL`.
- Added a shared delivery policy covering organization pause, tenant ownership, campaign/activity state, unsubscribe/suppression, send windows, daily/warm-up limits, and account spacing.
- Verified 25 tests, the full production build, and zero-warning ESLint.

## Task Commits

1. **Task 1: Add Vitest projects for server TS and React TSX** — `cf9d938` (chore)
2. **Task 2: Add a disposable PostgreSQL harness with a hard production guard** — `836dcf6` (test)
3. **Task 3 RED: Define the delivery-policy behavior** — `8c95bb5` (test)
4. **Task 3 GREEN: Implement the shared delivery policy** — `a5f3a4a` (feat)

**Plan metadata:** committed with this summary.

## Files Created/Modified

- `vitest.config.ts` — Routes TS, TSX, and database tests to isolated projects.
- `src/test/setup-jsdom.ts` — Installs jest-dom matchers and explicit DOM cleanup.
- `src/test/postgres-harness.ts` — Validates targets and applies migrations only to explicit guarded URLs.
- `src/test/postgres-global-setup.ts` — Starts and always stops disposable PostgreSQL.
- `src/test/__tests__/postgres-harness.db.test.ts` — Proves isolation, guard failures, and migration readiness.
- `src/server/lib/outreach-delivery-policy.ts` — Pure evaluator plus tenant-safe Drizzle snapshot loader.
- `src/server/lib/__tests__/outreach-delivery-policy.test.ts` — Covers all origins and provider non-dispatch on denial.
- `package.json` / `package-lock.json` — Adds Vitest, Testing Library, jsdom, and Testcontainers.

## Decisions Made

- Kept pure policy evaluation independent from database initialization so unit tests require neither credentials nor PostgreSQL.
- Used UTC midnight as the daily/warm-up retry boundary and the exact account-spacing deadline for throttling.
- Used a bounded campaign-window search so an invalid or closed schedule defers instead of failing open.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Started the installed Docker Desktop service**
- **Found during:** Task 2
- **Issue:** Docker was installed but stopped, so Testcontainers could not create PostgreSQL.
- **Fix:** Started Docker Desktop hidden and re-ran the database suite.
- **Files modified:** None
- **Verification:** PostgreSQL tests passed 9/9 and teardown removed the container.
- **Committed in:** No file change; harness committed in `836dcf6`.

**2. [Rule 1 - Correctness] Scoped the disposable baseline around historical schema drift**
- **Found during:** Task 2
- **Issue:** The old Drizzle snapshot and early SQL files describe mutually exclusive `server_id` and `organization_id` shapes.
- **Fix:** Bootstrap the snapshot, apply only outreach-relevant baseline migrations, and require feature migrations such as 038 explicitly.
- **Files modified:** `src/test/postgres-harness.ts`
- **Verification:** Fresh PostgreSQL 16 reached the outreach fixture and all database tests passed.
- **Committed in:** `836dcf6`

**3. [Rule 2 - Missing Critical] Added a Node-environment smoke fixture**
- **Found during:** Task 1
- **Issue:** The planned TSX fixture alone did not prove ordinary `.test.ts` files were excluded from jsdom.
- **Fix:** Added a TS test asserting `document` is unavailable in the server project.
- **Files modified:** `src/test/__tests__/harness-node-smoke.test.ts`
- **Verification:** Targeted output identified `server` for TS and `client` for TSX.
- **Committed in:** `cf9d938`

---

**Total deviations:** 3 auto-fixed (1 environment blocker, 1 correctness issue, 1 missing verification fixture).
**Impact on plan:** Changes were required for isolation and fail-closed verification; no production database or deployment was touched.

## Issues Encountered

None unresolved. Historical migration drift remains a pre-existing concern; the harness does not pretend incompatible histories form a valid rebuild path.

## User Setup Required

None. Docker is required for `.db.test.ts`; the harness manages containers and credentials.

## Verification

- `npm run test` — PASS, 4 files / 25 tests.
- `npm run build` — PASS, Vite client and TypeScript server.
- `npm run lint` — PASS, zero warnings.
- `npm run test -- src/server/lib/__tests__/outreach-delivery-policy.test.ts` — PASS, 13 tests.
- `npm run test -- src/test/__tests__/postgres-harness.db.test.ts` — PASS, 9 tests against disposable PostgreSQL.

## Next Phase Readiness

- Ready for `18-02-PLAN.md` to implement explicit email/delay/condition transitions.
- `18-03-PLAN.md` can apply migration 038 twice without reading application `DATABASE_URL`.
- `18-04-PLAN.md` must wire campaign/manual/agentic entrypoints through the policy before SAFE-01 is operational end-to-end.

## Self-Check: PASSED

All artifacts exist, all task commits are present, and every plan-level verification passed.

---
*Phase: 18-outreach-safety-and-execution-reliability*
*Completed: 2026-07-16*
