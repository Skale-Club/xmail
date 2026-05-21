---
phase: 16-reply-detection-v2-plus-per-inbox-throttle
plan: 04
subsystem: outreach-throttle/jobs
tags:
  - inbox-throttle
  - cron
  - hardening
  - jobs
requirements:
  - INBOX-THROTTLE
status: complete
completed: "2026-05-17"
dependency_graph:
  requires:
    - "Existing resetDailyLimits cron in src/server/jobs/index.ts (was already wired in a prior phase via processOutreachSequences.resetDailyLimits)"
    - "node-cron schedule(expression, fn, options) signature with options.timezone"
  provides:
    - "Explicit-UTC midnight cron contract for per-account daily-send counter reset"
    - "Operator-visible startup log mentioning 'midnight UTC' for the resetLimits cron"
  affects:
    - "src/server/jobs/index.ts (only)"
tech_stack:
  added: []
  patterns:
    - "Pin time-coupled cron schedules to an explicit IANA timezone instead of relying on container TZ defaults"
key_files:
  created: []
  modified:
    - "src/server/jobs/index.ts"
decisions:
  - "Pin ONLY the resetDailyLimits cron to UTC; cleanup '0 3 * * *' stays local-time because its 3am semantic is not coupled to any external invariant (out-of-scope per plan)."
  - "Comment block calls out the pairing with processOutreachSequences.resetDailyLimits so future readers know this cron is the per-inbox-throttle reset, not a generic system cleanup."
metrics:
  duration_minutes: 3
  tasks_completed: 1
  files_modified: 1
  commits: 1
---

# Phase 16 Plan 04: Pin resetDailyLimits cron to UTC

One-liner: Add explicit `{ timezone: 'UTC' }` option to the midnight `resetDailyLimits` cron in `src/server/jobs/index.ts` so the per-account daily-send-counter reset contract is immune to a future TZ env change, and surface that pin in the startup log.

## Objective Recap

The per-inbox throttle's daily quota depends on `current_daily_sent` being zeroed at UTC midnight. The cron was scheduled as `'0 0 * * *'` with no `timezone` option, so it fired at the container's local-time midnight. Today the alpine container has `TZ` unset (defaults to UTC) — but that's implicit. If a future ops change sets `TZ=America/Sao_Paulo` (e.g. to align `cleanupOldMessages` with local 3am), the daily reset would silently shift by 3 hours, breaking the throttle's quota semantics. This plan makes the UTC pin explicit so no future TZ change can break the daily-reset contract.

## What Was Built

### `src/server/jobs/index.ts` — two single-line edits + a comment block

**Edit 1 — `resetDailyLimits` cron block (replaces lines 43-46):**

```ts
// Phase 16 — INBOX-THROTTLE: reset per-account daily send counter at midnight UTC.
// Explicit timezone option pins the schedule to UTC independently of container TZ env
// (today alpine defaults to UTC, but pinning here prevents silent breakage if TZ is
// set by a future ops change). Pair with processOutreachSequences.resetDailyLimits.
cron.schedule('0 0 * * *', () => {
    resetDailyLimits().catch((err) => console.error('[jobs] resetDailyLimits failed:', err))
}, { timezone: 'UTC' })
```

**Edit 2 — startup log line (final `console.log` in `startJobs`):**

```ts
console.log('[jobs] Scheduled: processQueue (1min), processHeld (5min), cleanup (daily 3am), outreach (5min), resetLimits (daily midnight UTC), replies (15min), bounces (30min)')
```

No other cron schedule (`processQueue`, `processHeld`, `cleanup`, `outreach`, `replies`, `bounces`) was changed — they retain their current expressions and option sets.

## Verification

| Check                                                       | Result |
| ----------------------------------------------------------- | ------ |
| `grep -c "timezone: 'UTC'" src/server/jobs/index.ts` == 1   | PASS   |
| `grep -c "midnight UTC" src/server/jobs/index.ts` >= 1      | PASS   |
| `grep "Phase 16" src/server/jobs/index.ts` matches          | PASS   |
| `npm run build` exits 0 (vite + tsc -p tsconfig.server.json) | PASS   |
| No other cron schedule lines modified                       | PASS   |
| File ownership respected — only `src/server/jobs/index.ts`  | PASS   |

The plan's automated verify command (inline node script) printed `ok`.

## Decisions Made

- **Pin ONLY resetDailyLimits to UTC, not cleanup.** Cleanup's 3am-local semantic is fine (no external invariant); only the daily-counter reset is coupled to the throttle's quota-period concept, so only that one cron is pinned.
- **Pair-comment over silent change.** The new comment block names the pairing with `processOutreachSequences.resetDailyLimits` so a future reader doesn't grep for "what does this cron do" and miss the throttle relationship.
- **Startup log surface.** The pin is surfaced in the startup log (`midnight UTC`) so operators see at container start which schedule is timezone-pinned vs. local — useful when they're tempted to set a TZ env var.

## Deviations from Plan

None — plan executed exactly as written. The pre-existing cron registration was already in place (no need to create it), so the change was the documented two-line edit + comment block.

## Parallel Wave Coordination

Wave 1 ran 16-01 (schema/migration/helper), 16-03 (processReplies.ts), and 16-04 (this plan) in parallel. File-ownership respected:

- 16-01 owns `drizzle/`, `src/db/schema.ts`, `src/server/lib/perInboxThrottle.ts`
- 16-03 owns `src/server/jobs/processReplies.ts`
- 16-04 owns `src/server/jobs/index.ts` (this plan)

Git status during commit showed siblings' modifications to `processReplies.ts` and `STATE.md` — those were left untouched and only `src/server/jobs/index.ts` was staged for this plan's atomic commit. Used `--no-verify` per parallel-execution instructions.

## Commits

- `ca3af2f` — fix(jobs): pin resetDailyLimits cron to UTC explicitly (16-04)

## Self-Check: PASSED

- File `src/server/jobs/index.ts` exists at expected path: FOUND
- Commit `ca3af2f` exists in git log: FOUND
- Verification command exit code: 0
- Build command exit code: 0
