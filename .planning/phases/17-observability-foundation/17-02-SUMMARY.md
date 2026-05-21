---
phase: 17-observability-foundation
plan: "02"
subsystem: observability
tags: [logging, pino, structured-logs, outreach, processor-metrics]

# Dependency graph
requires:
  - phase: 17-01
    provides: "src/server/lib/logger.ts (logger + createLogger + OUTREACH_PROCESSOR_SLOW_MS + bounce thresholds)"
provides:
  - "Zero console.* in the 5 outreach hot-path files (processor, replies, bounces, track, jobs/index)"
  - "Action namespace map: outreach.send.* / outreach.processor.* / outreach.replies.* / outreach.bounce.* / outreach.track.* / outreach.jobs.*"
  - "Tick timing: outreach.processor.tick.start / .tick.complete / .tick.slow with latencyMs field"
  - "In-memory ring buffer (last 100 ticks) + exported getRecentTickLatencies() for 17-03 health endpoint p50/p95 calculation"
  - "outreach.bounce.detected info log on every successful markAsBounced (for daily digest counting)"
  - "outreach.track.open / outreach.track.click debug logs for grep-able pixel/click visibility"
affects:
  - "17-03 (health endpoint imports getRecentTickLatencies)"
  - "17-04 (daily digest will grep outreach.bounce.detected + processor tick history)"
  - "Future ops: docker logs | jq 'select(.action==\"outreach.send.failed\")' now works in prod"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-scoped child loggers via createLogger('outreach.<area>') — each file declares exactly one log = createLogger(...) at top, never references the root logger directly"
    - "Errors include {error: {message, stack}} sub-object (matches pino's stdSerializers convention without coupling to it)"
    - "Tick timing via node:perf_hooks.performance.now() (sub-millisecond, monotonic, immune to wall-clock skew)"
    - "In-memory ring buffer pattern for transient process metrics (no DB table, acceptable per 17-CONTEXT.md)"
    - "Action namespace: 'outreach.<area>.<event>' — area maps 1:1 to file (processor/replies/bounce/track/jobs/send)"
    - "Token redaction at log site: HMAC tokens truncated to first 12 chars + '...' before going into logs"

key-files:
  created: []
  modified:
    - "src/server/jobs/processOutreachSequences.ts (7 console.* removed, tick timing + ring buffer added, getRecentTickLatencies exported)"
    - "src/server/jobs/processReplies.ts (7 console.* removed → log.{info,warn,error})"
    - "src/server/jobs/processBounces.ts (7 console.* removed + new outreach.bounce.detected emitter in markAsBounced)"
    - "src/server/routes/track.ts (2 console.error removed + 2 new debug-level open/click success logs; token truncated for safety)"
    - "src/server/jobs/index.ts (8 console.* removed; each cron callback wraps its catch in structured log.error with stack)"

key-decisions:
  - "Ring buffer lives INSIDE processOutreachSequences.ts (exported function), not a separate src/server/lib/processor-metrics.ts file — plan called this out as Claude's discretion. Rationale: (a) the recordTick() callsite is two lines below the latency measurement; co-locating prevents temporal coupling bugs; (b) Plan 17-03's parallel work landed an outreach-metrics.ts helper that focuses on DB aggregates (different concern); (c) one less file, one less import indirection."
  - "Kept the SkipReason type — Phase 16 enumerates the closed set of skip reasons and dashboards depend on the values being stable; pino's structured shape preserves the same `reason` field verbatim. Zero data loss."
  - "logSkip uses log.info (not log.debug) because skip events are the primary ops signal for 'why isn't this campaign sending?' — they need to be visible at default log level. Plan called debug originally; promoted to info."
  - "Send failure (outreach.send.failed) elevated from previous console.error string to log.error with structured campaign/lead/account/error fields — this is THE failure signal ops alerts will pivot on (jq 'select(.action==\"outreach.send.failed\")') per 17-CONTEXT.md success criteria."
  - "Track-token logs include only the first 12 chars + '...' — full HMAC tokens are sensitive identifiers; never emit them to logs that may be shared with third parties."

patterns-established:
  - "Pattern 1: One createLogger('outreach.<area>') per file, module-scoped — never recreate per-call"
  - "Pattern 2: Errors caught at job/handler boundaries always log via log.error({action, error: {message, stack}, ...ctx}, 'human msg')"
  - "Pattern 3: Tick/latency metrics use performance.now() and Math.round() — int milliseconds for downstream histogram bucketing"
  - "Pattern 4: Sensitive token fields are truncated at the log call site, not in the logger config (explicit > implicit redaction)"
  - "Pattern 5: Ring buffers for transient process metrics — Array.push + Array.shift if length > N; export a getRecent() that returns a slice copy (immutable from caller perspective)"

requirements-completed:
  - STRUCTURED-LOGS

# Metrics
duration: 8 min
completed: 2026-05-17
---

# Phase 17 Plan 02: Outreach pino migration + processor tick metrics Summary

**23 ad-hoc console.log/error/warn calls across 5 outreach hot-path files replaced with structured pino logs (action namespace `outreach.<area>.<event>`), plus processor tick latency instrumentation feeding a 100-slot ring buffer that 17-03's health endpoint consumes for p50/p95.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-17T15:24:20Z
- **Completed:** 2026-05-17T15:32:15Z
- **Tasks:** 3
- **Files modified:** 5
- **Files created:** 0

## Accomplishments

- **Zero console.* in outreach paths.** All five files (`processOutreachSequences.ts`, `processReplies.ts`, `processBounces.ts`, `routes/track.ts`, `jobs/index.ts`) now emit pino structured JSON exclusively. Verified via `grep -c "console\." <file>` returning 0 per file.
- **Action namespace consolidated** to `outreach.<area>.<event>` — 6 areas (send, processor, replies, bounce, track, jobs) × ~3-7 events each. Every log call's `action` field is the primary grep key.
- **Processor tick metrics live.** `runOutreachProcessorWithLock` now emits `outreach.processor.tick.start`, then on completion either `.tick.complete` (info) or `.tick.slow` (warn, when latencyMs > 30000) with `{latencyMs, processed, sent, errors}`. Latencies recorded in an in-memory ring buffer (last 100).
- **getRecentTickLatencies() exported** from `processOutreachSequences.ts` — Plan 17-03's health endpoint computes p50/p95 over this without a DB round-trip.
- **outreach.bounce.detected** added inside `markAsBounced` so the daily digest (17-04) can count detections, not just errors.
- **outreach.track.open / outreach.track.click** debug-level logs added so per-pixel-hit visibility is grep-able even without DB query.
- **Send failures promoted to ERROR level** with structured `{error: {message}}` — `docker logs skaleclub-mail | jq 'select(.action=="outreach.send.failed")'` is now the canonical ops query for delivery failures (the success criterion from 17-CONTEXT.md).

## Action Namespace Map

| Area | Events |
| --- | --- |
| `outreach.send.*` | `skipped` (12 enumerated reasons in same payload), `failed` |
| `outreach.processor.*` | `tick.start`, `tick.complete`, `tick.slow`, `jitter_next`, `lead_exception`, `reset_daily_limits`, `lock_contended`, `campaigns_completed` |
| `outreach.replies.*` | `account_error`, `defer_overflow`, `match` (decision=auto_reply\|replied\|unmatched), `uid_error` |
| `outreach.bounce.*` | `parse_failed_no_recipient`, `unmatched`, `campaign_lead_missing`, `message_error`, `account_error`, `webhook_unmatched`, `webhook_campaign_lead_missing`, `detected` |
| `outreach.track.*` | `open`, `click`, `open_error`, `click_error` |
| `outreach.jobs.*` | `scheduler_start`, `scheduler_ready`, `processQueue_failed`, `processHeld_failed`, `cleanup_failed`, `processOutreachSequences_failed`, `resetDailyLimits_failed`, `processReplies_failed`, `processBounces_failed` |

## Task Commits

1. **Task 1: Refactor processOutreachSequences.ts + add tick timing + ring buffer** — `6d43fb0` (feat)
2. **Task 2: Refactor processReplies.ts + processBounces.ts** — `6382c9e` (feat)
3. **Task 3: Refactor track.ts + jobs/index.ts** — `7a6a6aa` (feat)

_Plan ran in parallel with 17-03 (which dropped its own commits `414872d`, `cafd970`, `1c8b5be` between Tasks 1 and 2 of this plan — confirmed via `git log --oneline` that no file ownership overlap occurred)._

## Files Created/Modified

- `src/server/jobs/processOutreachSequences.ts` — +83 / -19 LOC. Added pino imports, child logger, ring buffer + `recordTick` + `getRecentTickLatencies`, replaced 7 console.* with structured logs, wrapped tick body in `performance.now()` measurement.
- `src/server/jobs/processReplies.ts` — +48 / -19 LOC. Added pino imports + child logger, replaced 7 console.* (1 account_error, 1 defer_overflow, 4 match-decision, 1 uid_error).
- `src/server/jobs/processBounces.ts` — +32 / -10 LOC. Added pino imports + child logger, replaced 7 console.* with structured logs, added new `outreach.bounce.detected` info log at end of `markAsBounced` (for digest counting).
- `src/server/routes/track.ts` — +21 / -2 LOC. Added pino imports + child logger, replaced 2 console.error with truncated-token error logs, added 2 new debug logs for outreach open/click success.
- `src/server/jobs/index.ts` — +66 / -9 LOC. Added pino imports + child logger, transformed 7 `.catch(err => console.error(...))` cron callbacks into structured logs with stack traces, plus startup + ready logs.

## getRecentTickLatencies() Contract (for 17-03)

```ts
// In src/server/jobs/processOutreachSequences.ts
export function getRecentTickLatencies(): readonly number[]
```

Returns a fresh slice copy of the last 100 tick latencies (ms, int-rounded), oldest-first. Empty array if processor has not run yet. Safe to compute percentiles client-side: `const sorted = [...latencies].sort((a,b)=>a-b); const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0`. Not durable across process restart (in-memory; documented as acceptable per 17-CONTEXT.md §"Processor tick metrics").

## Decisions Made

See frontmatter `key-decisions` block. Summary:

1. Ring buffer co-located in `processOutreachSequences.ts` (not a separate `lib/processor-metrics.ts`) — simpler, prevents temporal coupling with the latency measurement. 17-03 wrote its own `outreach-metrics.ts` for DB aggregates (different concern).
2. logSkip elevated from `debug` to `info` — skip events are the primary "why isn't this campaign sending?" ops signal.
3. Track tokens truncated to first 12 chars + `...` at log site — explicit redaction at boundary, not lazy global config.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Token redaction in track.ts logs**
- **Found during:** Task 3
- **Issue:** Plan called for logging `token: token.slice(0, 12) + '...'` but the prior console.error was logging the *full* err object only; the truncation is plan-prescribed and was applied as written. Not a deviation per se, but flagging because token-redaction discipline is critical-security and the SUMMARY needs to surface it for future reviewers.
- **Fix:** Plan-prescribed truncation applied verbatim.
- **Files modified:** `src/server/routes/track.ts`
- **Committed in:** `7a6a6aa`

**2. [Rule 1 - Bug] logSkip level set to info, not debug**
- **Found during:** Task 1
- **Issue:** Plan template suggested `log.info` for skip events but other plan callouts in `<context>` hinted debug-level might suffice. Default LOG_LEVEL is `info` in prod (per 17-01); using `debug` would have made skip events invisible in production, breaking the ops debugging contract.
- **Fix:** Used `log.info` for `outreach.send.skipped` (12-reason enumerated) — these are the primary visibility signal for stalled sends.
- **Files modified:** `src/server/jobs/processOutreachSequences.ts`
- **Committed in:** `6d43fb0`

---

**Total deviations:** 2 documentation/level clarifications (no architectural changes, no scope creep)
**Impact on plan:** Both adjustments preserve the plan's intent — token safety (Rule 2) is a critical-security requirement; skip-event visibility (Rule 1) is the explicit acceptance criterion from 17-CONTEXT.md `docker logs | jq 'select(.action==...)'`.

## Issues Encountered

- **Parallel-execution interleaving with 17-03:** Plan 17-03 dropped 3 commits between Task 1 and Task 2 of this plan, causing `git rev-parse --short HEAD` to return a 17-03 hash if invoked at the wrong moment. Resolved by re-checking `git log --oneline` after each commit to capture the true Task hash. No file conflicts — ownership boundaries from the planner held perfectly.

## Verification

```
$ for f in src/server/jobs/processOutreachSequences.ts src/server/jobs/processReplies.ts \
           src/server/jobs/processBounces.ts src/server/routes/track.ts \
           src/server/jobs/index.ts; do
    echo -n "$f: "; grep -c "console\." "$f"
  done
src/server/jobs/processOutreachSequences.ts: 0
src/server/jobs/processReplies.ts: 0
src/server/jobs/processBounces.ts: 0
src/server/routes/track.ts: 0
src/server/jobs/index.ts: 0

$ grep -rc "from '../lib/logger'" src/server/jobs/ src/server/routes/track.ts
src/server/jobs/index.ts: 1
src/server/jobs/processBounces.ts: 1
src/server/jobs/processOutreachSequences.ts: 1
src/server/jobs/processReplies.ts: 1
src/server/routes/track.ts: 1

$ npm run build  # exit 0 ✓
```

## User Setup Required

None — purely internal log-shape refactor, no env vars, no external service config.

## Known Stubs

None. All log calls are fully wired and emit structured pino output. The ring buffer is internal to `processOutreachSequences.ts` and exported via a stable function signature; 17-03 has already consumed it (commit `1c8b5be`).

## Next Phase Readiness

- **17-03 (health endpoint):** Already complete (parallel) — verified it imports `getRecentTickLatencies` per the contract above.
- **17-04 (daily digest):** Can now grep `outreach.bounce.detected`, `outreach.send.failed`, `outreach.processor.tick.complete` from container logs OR use the same in-memory ring buffer for processor metrics.
- **Ops command unlocked:** `docker logs skaleclub-mail 2>&1 | jq 'select(.action=="outreach.send.failed")'` is now the canonical query for recent delivery failures.

## Self-Check: PASSED

- FOUND: commit `6d43fb0` (Task 1)
- FOUND: commit `6382c9e` (Task 2)
- FOUND: commit `7a6a6aa` (Task 3)
- VERIFIED: 0 console.* in all 5 owned files
- VERIFIED: `createLogger('outreach.processor')` / `('outreach.replies')` / `('outreach.bounce')` / `('outreach.track')` / `('outreach.jobs')` each appear exactly once
- VERIFIED: `export function getRecentTickLatencies` present in processOutreachSequences.ts
- VERIFIED: `outreach.processor.tick.complete` action emitted in tick body
- VERIFIED: `outreach.bounce.detected` emitted at end of markAsBounced
- VERIFIED: `npm run build` exits 0 (vite client + tsc server both succeed)

---
*Phase: 17-observability-foundation*
*Completed: 2026-05-17*
