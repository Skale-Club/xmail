# Phase 11 — Deferred Items

Out-of-scope discoveries logged during plan execution.

## From 11-03 (auth-cache wiring)

### Pre-existing TypeScript errors in `src/server/lib/cron-lock.ts`

- **Discovered during:** Task 2 verification (`npx tsc --noEmit -p tsconfig.server.json`)
- **File:** `src/server/lib/cron-lock.ts` (untracked, work-in-progress from another plan)
- **Errors:**
  - L64: TS1320 — `await` operand not a valid promise (bigint result of `pg_try_advisory_lock`)
  - L64: TS2345 — `bigint` not assignable to `ParameterOrFragment<never>`
  - L80: TS2769 — `bigint` not assignable in sql template parameter
- **Out of scope for 11-03:** Not introduced by this plan; file is untracked and unrelated to auth-cache.
- **Disposition:** Defer to whichever plan owns `cron-lock.ts` (likely a later Phase 11 plan or a separate concurrency plan).
