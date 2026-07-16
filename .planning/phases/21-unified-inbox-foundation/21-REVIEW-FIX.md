---
phase: 21
phase_name: unified-inbox-foundation
fixed_at: "2026-07-16T16:05:00Z"
addresses: 21-REVIEW.md (W-1, W-2)
status: fixes_applied
result: 2 warnings fixed, 0 observations changed
gates: test x2 (524 pass, identical), build, lint (0 warnings), client+server tsc
---

# Phase 21 Code Review — Fix Report

Both WARNINGs from `21-REVIEW.md` are fixed with TDD (RED confirmed before each fix, GREEN
after). O-1 and O-2 were left untouched as accepted design decisions. No new migration, no
production-DB access, no `vitest.config.ts` change.

## W-1 — Malformed cursor field returns 500 instead of 400 — FIXED

**Root cause.** `decodeConversationCursor` (`src/server/lib/unified-inbox/cursor.ts`) validated that
the keyset fields `t`/`i` were *strings* but not that `t` is a real timestamp and `i` a UUID. The
filter fingerprint is unkeyed (a caller can recompute it for their own filters), so a well-shaped
cursor with a malformed `t`/`i` passed decode, then Postgres threw on the `${t}::timestamp` /
`${i}::uuid` cast in `queries.ts` → caught by the generic handler → HTTP 500.

**Fix.** In the codec, after the existing string-type check and before the fingerprint check,
validate the keyset value shape and raise `ConversationCursorError` (the error the route already maps
to 400):
- `t` — `Number.isNaN(Date.parse(envelope.t))` (the "date parsing pattern" the review pointed to;
  `Date.parse` cleanly accepts every legitimate Postgres `timestamp::text` rendering — incl.
  microsecond precision `2026-07-16 12:00:00.123456` — and returns `NaN` for a non-timestamp).
- `i` — `z.string().uuid()` (the same validator the routes use), imported from `zod`.

Purely defensive; no cross-tenant impact. The genuine round-trip and the existing
"tampered/replayed-under-different-filters → 400" behavior are unchanged (verified by the untouched
cursor tests + a new positive-path assertion).

**Files:** `src/server/lib/unified-inbox/cursor.ts` (+`zod` import, +`uuidSchema`, +2 guards).

**Tests that lock it:**
- `src/server/lib/unified-inbox/__tests__/cursor.test.ts` — two unit tests: a valid-fingerprint
  cursor whose `t` is not a timestamp, and whose `i` is not a UUID, each must throw
  `ConversationCursorError`. Both asserted `payload.f === fingerprintConversationFilters(BASE_FILTERS)`
  first, so the fingerprint genuinely matches (this is the exact bypass the review described).
  **RED before fix:** "expected function to throw an error, but it didn't" (codec returned the
  malformed position). **GREEN after fix.**
- `src/server/routes/outreach/__tests__/unified-inbox.db.test.ts` — a route-level test takes a real
  `nextCursor`, corrupts `t` (then `i`) while keeping `f`/`v` intact, and asserts the endpoint
  returns **400** (was 500), while the genuine cursor still returns 200. Locks the actual HTTP status,
  not just the codec.

## W-2 — Concurrent cron + backfill can split one header-less thread into two conversations — FIXED

**Root cause.** The scheduled materializer (`materializeUnifiedInbox`, advisory lock
`outreach-unified-inbox-materializer`) and the operator backfill (`backfillUnifiedInbox`, DISTINCT
lock `outreach-unified-inbox-backfill`) could run concurrently. Both reuse the same READ COMMITTED
materializers. For a header-less-root thread (`thread_key = gen:<uuid>`), if the two jobs process
root E1 and reply E2 in overlapping transactions, E2's tier-1a lookup can't see E1's uncommitted
message, so E1 lands under `gen:<uuid>` and E2 derives `rfc:<E1-message-id>` — one logical thread
becomes two conversations. Bounded/cosmetic (nothing lost/duplicated/resent; outreach reply
attribution is unaffected because it converges via tier-1b's rfc reference-root key) but real.

**Fix.** Point `BACKFILL_LOCK_NAME` at `MATERIALIZE_LOCK_NAME` (imported from
`materializeUnifiedInbox`) so `runBackfillUnifiedInboxWithLock` acquires the **same** advisory lock
as the cron materializer. Consequences:
- **Backfill vs cron:** mutually exclusive — they contend on one key, so only one runs at a time.
- **Cron single-instance:** unchanged — the cron still uses its own lock (now shared), two ticks
  still no-op.
- **No deadlock:** the backfill acquires exactly ONE lock (not two), so there is no ordering hazard.
- **Two operator backfills:** still serialized (same lock).
- **Restart-safe / idempotent:** the core `backfillUnifiedInbox` scan/anti-join/materialize logic is
  completely unchanged; only the lock name the runner passes changed.

Because the runner uses non-blocking `pg_try_advisory_lock`, an operator backfill launched while a
cron tick holds the lock now returns `null` (skipped) instead of running — the operator retries. The
return type was already `BackfillResult | null` and there are no in-tree callers, so this is not a
behavioral regression. The runner doc-comment was updated to state this.

**Files:** `src/server/jobs/backfillUnifiedInbox.ts` (import `MATERIALIZE_LOCK_NAME`, repoint
`BACKFILL_LOCK_NAME`, update runner doc-comment).

**Tests that lock it:** new `src/server/jobs/__tests__/unifiedInboxJobLocks.db.test.ts`:
1. **Structural** — `BACKFILL_LOCK_NAME === MATERIALIZE_LOCK_NAME` and
   `computeLockKey(BACKFILL_LOCK_NAME) === computeLockKey(MATERIALIZE_LOCK_NAME)`. Guards against a
   future regression reintroducing a distinct backfill lock.
2. **Behavioral (mutual exclusion observable)** — a holder connection takes
   `pg_advisory_lock(computeLockKey(MATERIALIZE_LOCK_NAME))` (simulating the cron/an in-flight
   backfill); `runBackfillUnifiedInboxWithLock` then returns `null` (its `pg_try_advisory_lock`
   fails, the locked body never runs); after `pg_advisory_unlock`, a second call runs to a zero-row
   result (non-null). Deterministic — advisory locks are synchronous and the holder is established
   before the call.

**RED before fix:** structural test failed (`'outreach-unified-inbox-backfill'` ≠
`'outreach-unified-inbox-materializer'`); behavioral test failed — the backfill ran (returned a
non-null `BackfillResult`) *while the materializer lock was held*, exactly demonstrating the concurrent
window. **GREEN after fix.**

## Observations — unchanged (as instructed)

- **O-1 (poison-event auto-recovery cadence)** — not changed. Correct poison-park pattern; a future
  ops cadence belongs to Phase 22/23. Not a defect.
- **O-2 (outbound hook awaited inline)** — not changed. Runs strictly after `finalizeSent` commits,
  adds latency only to the dispatch *return*, gives backpressure + deterministic tests. Not a defect.

## Gate results (run twice for determinism)

| Gate                         | Run 1              | Run 2              |
| ---------------------------- | ------------------ | ------------------ |
| `npm run test`               | 524 pass / 45 files | 524 pass / 45 files (identical) |
| `npm run build`              | exit 0             | —                  |
| `npm run lint` (max-warnings 0) | exit 0          | —                  |
| `tsc -p tsconfig.json --noEmit` (client) | exit 0 | —                  |
| `tsc -p tsconfig.server.json --noEmit` (server) | exit 0 | —          |

Test count rose 519 → 524 (+2 cursor unit, +1 cursor route db, +2 job-lock db). No Phase 18/19/20/21
regressions; `vitest.config.ts` untouched.

## Commits

- `476bda2` fix(21): reject malformed cursor keyset fields with 400 not 500
- `4aa672d` fix(21): share cron materializer lock in backfill for mutual exclusion

## Deviations

None. Both fixes are exactly the scope in `21-REVIEW.md`; no architectural changes, no unrelated
files touched.
