---
phase: 17-observability-foundation
plan: "04"
subsystem: observability
tags: [observability, daily-digest, cron, structured-logs, log-only]
requirements:
  - DAILY-DIGEST
dependency_graph:
  requires:
    - "src/server/lib/logger.ts (17-01) — createLogger"
    - "src/server/lib/outreach-metrics.ts (17-03) — computeOverallMetrics, computeByOrgMetrics, computeTopBouncingCampaigns, buildAlerts"
    - "src/server/jobs/index.ts (17-02) — pino-migrated cron file with `log = createLogger('outreach.jobs')` already in place"
  provides:
    - "src/server/jobs/dailyOutreachDigest.ts — log-only digest job exporting dailyOutreachDigest()"
    - "Action namespace: outreach.digest.daily (success) + outreach.digest.failed (caught error) + outreach.jobs.dailyOutreachDigest_failed (uncaught rejection wrapper)"
    - "Daily 09:00 UTC cron registration in jobs/index.ts"
  affects:
    - "Phase 18+ (notifications): the structured payload is intentionally complete — a future webhook/email transport reads the same JSON, zero extra computation"
    - "Operator's morning routine: `docker logs skaleclub-mail 2>&1 | jq 'select(.action==\"outreach.digest.daily\")'`"
tech_stack:
  added: []
  patterns:
    - "Log-only observability output — no external notification dependencies (Phase 17 scope per 17-CONTEXT.md)"
    - "Single-payload digest: every aggregate (overall + byOrg + topBouncingCampaigns + alerts + summary) inlined into ONE pino log line so `jq` finds the digest in one grep"
    - "Errors caught inside the job and logged as outreach.digest.failed; the function never throws (must not crash the cron scheduler)"
    - "Cron timezone explicitly pinned to UTC via { timezone: 'UTC' } — matches Phase 16-04 resetDailyLimits idiom; immune to container TZ env changes"
    - "Outer .catch wrapper on cron.schedule callback logs outreach.jobs.dailyOutreachDigest_failed as a safety net (defence in depth — the job itself already catches, but node-cron's unhandled-rejection behaviour is process-killing in modern Node)"
    - "performance.now()-based durationMs (sub-ms, monotonic) — same pattern as Plan 17-02 tick metrics"
key_files:
  created:
    - "src/server/jobs/dailyOutreachDigest.ts (100 lines)"
  modified:
    - "src/server/jobs/index.ts (+17 lines: import + cron.schedule block + scheduler_ready log update)"
decisions:
  - "Helper names: used computeOverallMetrics / computeByOrgMetrics / computeTopBouncingCampaigns / buildAlerts as exported by 17-03 (the executor-prompt mentioned `get*Metrics`/`computeAlerts` synonyms, but the PLAN.md must-haves + actual file are the source of truth). The semantic intent is identical — no behaviour change."
  - "Inlined the payload field-by-field (overall.{sent24h, sent7d, openRate24h, ...}) rather than spreading `...overall` so the log shape is grep-stable: if 17-03 ever adds a new field to OverallMetrics, the digest log keeps the documented shape until this file is updated. Explicit is safer for ops queries."
  - "Did NOT wrap the digest in an advisory lock. Phase 14-06's lock pattern protects against multi-instance overlap on the 5-min cadence outreach processor. For a once-per-day digest at 09:00 UTC the racing risk is ~zero (single-container deploy + a 9-second skew window is harmless because it's read-only aggregates, no DB writes). Plan-prescribed Note explicitly authorised this."
  - "Used `outreach.digest.failed` (not `outreach.digest.daily.failed`) for the caught error — matches Plan 17-01's docstring convention (`{action}.{success_or_failure}` not nested triples) and the action namespace map from 17-02 (`outreach.<area>.<event>`)."
  - "Outer cron .catch wrapper uses `outreach.jobs.dailyOutreachDigest_failed` (jobs namespace) while the job's own catch uses `outreach.digest.failed` (digest namespace) — two distinct kinds of failure: cron-scheduler-saw-rejection vs job-caught-exception. Both are visible; the dual layer protects against any future refactor that accidentally lets the function throw."
metrics:
  duration_ms: 177000
  completed: "2026-05-17"
  tasks_completed: 2
  files_changed: 2
---

# Phase 17 Plan 04: Daily Outreach Digest Summary

**One-liner:** Cron-scheduled job at 09:00 UTC that reuses Plan 17-03's aggregate helpers to emit ONE structured pino log line (`action='outreach.digest.daily'`) containing the prior-24h outreach snapshot — overall metrics, per-org breakdown, top-5 bouncing campaigns, alerts, and a healthy/warning/critical scoreboard — entirely log-only (no email/slack/webhook per Phase 17 scope).

## What was built

### 1. `src/server/jobs/dailyOutreachDigest.ts` (new, 100 lines)

A standalone async function that:
1. Captures `startedAt = new Date()` and `t0 = performance.now()` at entry
2. Runs the three aggregate helpers from `outreach-metrics.ts` **in parallel** via `Promise.all`:
   - `computeOverallMetrics(startedAt)` → 14-field `OverallMetrics` (sent windows, open/click/reply/bounce/suppression rates, processor p50/p95, campaign/account counts)
   - `computeByOrgMetrics(startedAt)` → per-org array with healthy/warning/critical status
   - `computeTopBouncingCampaigns(startedAt)` → top-5 by bounce ratio with sample-size floor (≥10 sends)
3. Calls `buildAlerts(overall, byOrg, topBouncingCampaigns, startedAt)` for derived alerts (1h/24h bounce thresholds, processor slow, failed accounts, per-org critical)
4. Emits a SINGLE `log.info({ action: 'outreach.digest.daily', ... }, 'daily outreach digest')` containing the full snapshot + a `summary` scoreboard block (healthyOrgs / warningOrgs / criticalOrgs / alertCount)
5. Catches any exception and logs `action: 'outreach.digest.failed'` with structured `{error: {message, stack}}`; **never throws** (the cron must not crash on a one-off DB blip)
6. Returns `{ success, durationMs, alertCount }` — useful for future programmatic consumers (e.g. tests, manual REPL invocations)

### 2. `src/server/jobs/index.ts` (modified)

- **Import** added alphabetically with the other job imports: `import { dailyOutreachDigest } from './dailyOutreachDigest'`
- **Cron block** inserted directly after `resetDailyLimits` (the other UTC-pinned daily cron) and before `processReplies` (the next time-based cron):
  ```typescript
  cron.schedule('0 9 * * *', () => {
      dailyOutreachDigest().catch((err) => {
          const e = err instanceof Error ? err : new Error(String(err))
          log.error({
              action: 'outreach.jobs.dailyOutreachDigest_failed',
              error: { message: e.message, stack: e.stack },
          }, 'dailyOutreachDigest failed')
      })
  }, { timezone: 'UTC' })
  ```
- **Scheduler-ready log** updated to advertise the new cron:
  - Before: `processQueue=1min, processHeld=5min, cleanup=daily-3am, outreach=5min, resetLimits=daily-midnight-UTC, replies=15min, bounces=30min`
  - After:  `processQueue=1min, processHeld=5min, cleanup=daily-3am, outreach=5min, resetLimits=daily-midnight-UTC, dailyDigest=09:00-UTC, replies=15min, bounces=30min`

The file now has **2 UTC-pinned crons** (`resetDailyLimits` at `0 0 * * *` and `dailyOutreachDigest` at `0 9 * * *`), both following the same idiom.

## Cron schedule and timezone

| Field        | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| Schedule     | `0 9 * * *` (minute=0, hour=9, every day)                   |
| Timezone     | `UTC` (explicit `{ timezone: 'UTC' }` option to node-cron)  |
| Daily offset | 09:00 UTC = 06:00 America/Sao_Paulo = 09:00 BST (DST-aware) |
| Drift safety | UTC pin survives any future change to container TZ env      |

## Action namespace

| Action                                           | Level | Source                                | When                                                  |
| ------------------------------------------------ | ----- | ------------------------------------- | ----------------------------------------------------- |
| `outreach.digest.daily`                          | info  | `dailyOutreachDigest.ts` job          | Successful daily snapshot — primary ops grep target   |
| `outreach.digest.failed`                         | error | `dailyOutreachDigest.ts` job catch    | Job-internal exception (DB error, helper bug, etc.)   |
| `outreach.jobs.dailyOutreachDigest_failed`       | error | `jobs/index.ts` cron callback catch   | Defence-in-depth: unhandled rejection at cron edge    |

## Payload shape (annotated example)

```json
{
  "level": "info",
  "time": "2026-05-18T09:00:01.234Z",
  "module": "outreach.digest",
  "action": "outreach.digest.daily",
  "asOf": "2026-05-18T09:00:00.000Z",
  "window": "24h",
  "durationMs": 38,

  "overall": {
    "sent24h": 1203,           "sent7d": 8451,
    "openRate24h": 0.31,       "clickRate24h": 0.04,
    "replyRate24h": 0.018,     "bounceRate24h": 0.022,
    "suppressionRate24h": 0.005,
    "processorTickP50Ms": 412, "processorTickP95Ms": 1830,
    "activeCampaigns": 7,      "activeEmailAccounts": 12,
    "failedEmailAccounts": 0
  },

  "byOrg": [
    { "organizationId": "uuid", "name": "Acme",
      "sent24h": 540, "bounceRate24h": 0.018, "replyRate24h": 0.022,
      "status": "healthy" }
  ],

  "topBouncingCampaigns": [
    { "campaignId": "uuid", "name": "Q2 Outbound",
      "sent24h": 220, "bounceRate24h": 0.054 }
  ],

  "alerts": [
    { "severity": "warning", "kind": "processor_slow",
      "message": "Processor tick p95 31200ms exceeds 30000ms threshold",
      "since": "2026-05-18T09:00:00.000Z" }
  ],

  "summary": {
    "healthyOrgs": 4,
    "warningOrgs": 1,
    "criticalOrgs": 0,
    "alertCount": 1
  },

  "msg": "daily outreach digest"
}
```

The `summary` block at the end is the at-a-glance scoreboard — three integers (healthy / warning / critical orgs) + `alertCount`. Full data sits above for forensics. A future webhook transport (Phase 18+) can post the whole object verbatim to Slack or email.

## How to verify after deploy

```bash
# After next 09:00 UTC roll-over:
docker logs skaleclub-mail 2>&1 \
  | jq 'select(.action=="outreach.digest.daily")'

# Sanity: confirm the cron was registered at startup
docker logs skaleclub-mail 2>&1 \
  | jq 'select(.action=="outreach.jobs.scheduler_ready") | .schedule' \
  | grep -q 'dailyDigest=09:00-UTC' \
  && echo "OK: digest cron registered"

# If anything went wrong:
docker logs skaleclub-mail 2>&1 \
  | jq 'select(.action=="outreach.digest.failed" or .action=="outreach.jobs.dailyOutreachDigest_failed")'
```

Manual one-shot (no waiting for 09:00 UTC) — can be invoked in a dev REPL or migration shell:

```bash
node -e "require('./dist/server/jobs/dailyOutreachDigest').dailyOutreachDigest().then(r => console.log(JSON.stringify(r)))"
# Expected output: {"success":true,"durationMs":<N>,"alertCount":<N>}
# And in the same process, the structured log line is emitted to stdout.
```

## Task commits

| Task | Description                                              | Commit    |
| ---- | -------------------------------------------------------- | --------- |
| 1    | Create `src/server/jobs/dailyOutreachDigest.ts`          | `98d9a73` |
| 2    | Register `0 9 * * *` UTC cron in `src/server/jobs/index.ts` | `ee8acf6` |

## Verification

- `test -f src/server/jobs/dailyOutreachDigest.ts` → exists
- `grep -c "export async function dailyOutreachDigest" src/server/jobs/dailyOutreachDigest.ts` → 1
- `grep -c "outreach.digest.daily" src/server/jobs/dailyOutreachDigest.ts` → 3 (header docstring + jq-example + log action)
- `grep -c -E "computeOverallMetrics|computeByOrgMetrics|computeTopBouncingCampaigns|buildAlerts" src/server/jobs/dailyOutreachDigest.ts` → 8 (4 imports + 4 call sites)
- `grep -c "dailyOutreachDigest" src/server/jobs/index.ts` → 4 (import + cron callback + .catch action + ready-schedule string)
- `grep -c "'0 9 \* \* \*'" src/server/jobs/index.ts` → 1
- `grep -c "timezone: 'UTC'" src/server/jobs/index.ts` → 2 (resetDailyLimits + dailyOutreachDigest)
- `grep -c "dailyDigest=09:00-UTC" src/server/jobs/index.ts` → 1
- `npm run build` → exits 0 twice (Task 1 + Task 2)

## Deviations from Plan

None — the plan executed exactly as written. The executor-prompt's `<phase_context>` block referenced helper-name synonyms (`getOverallMetrics`, `computeAlerts`) that don't match the actual exports in `outreach-metrics.ts` (`computeOverallMetrics`, `buildAlerts`), but the PLAN.md `<read_first>` block + must-haves + `<action>` code-block all use the correct names. Following PLAN.md as the source of truth (per orchestrator instructions).

### Out-of-scope discoveries (logged, not fixed)

- Pre-existing untracked planning artefacts (`.planning/phases/{15,16,17}/.gitkeep`, `17-03-PLAN.md`, `17-04-PLAN.md`) and unstaged working-tree modifications (`src/hooks/useKeyboardShortcuts.ts`, `src/index.css`) — belong to other plans / the planner / earlier sessions. Not 17-04's concern. Left untouched.
- `npm audit` continues to report 34 pre-existing vulnerabilities — not introduced by this plan.

## Issues encountered

None. Both tasks went green on first attempt; build passed cleanly each time.

## User setup required

None. The cron auto-registers on next deploy (next `npm start` → `startJobs()` runs at boot). At the first 09:00 UTC after deploy, the digest line appears in `docker logs skaleclub-mail`.

## Known stubs

None. The job is fully wired:
- All four helpers from `outreach-metrics.ts` are imported and invoked with real arguments.
- The pino logger is the production logger (not a mock).
- The cron is registered via the same `cron.schedule` call as the seven other jobs in `jobs/index.ts`.
- No `// TODO`, no placeholder data, no UI surface that needs wiring.

## Next phase readiness

This plan **completes Phase 17 (observability foundation)** and the **informal v1.3 (Outreach Hardening) milestone**:

- 17-01: pino logger + threshold constants ✅
- 17-02: outreach-module pino migration + processor tick ring buffer ✅
- 17-03: GET /api/admin/outreach/health endpoint + aggregate helpers ✅
- 17-04: daily 09:00 UTC log-only digest ✅

The full ops command surface promised in 17-CONTEXT.md is now live:
1. **Per-event grep:** `docker logs skaleclub-mail 2>&1 | jq 'select(.action=="outreach.send.failed")'`
2. **Real-time pull:** `curl /api/admin/outreach/health -H "Authorization: Bearer $TOKEN" | jq '.byOrg'`
3. **Daily push:** `docker logs ... | jq 'select(.action=="outreach.digest.daily")'`

Phase 18+ can wire the digest payload to webhooks/email/Slack — the JSON shape is intentionally a complete snapshot so a downstream transport needs zero extra computation.

## Self-Check: PASSED

- FOUND: `src/server/jobs/dailyOutreachDigest.ts`
- FOUND: commit `98d9a73` (Task 1 — create digest job)
- FOUND: commit `ee8acf6` (Task 2 — register cron)
- VERIFIED: `export async function dailyOutreachDigest` present
- VERIFIED: action string `outreach.digest.daily` present (3 occurrences)
- VERIFIED: all four helpers from outreach-metrics.ts imported and used (8 grep hits = 4 imports + 4 call sites)
- VERIFIED: cron registered at `'0 9 * * *'` with `{ timezone: 'UTC' }`
- VERIFIED: scheduler_ready log lists `dailyDigest=09:00-UTC`
- VERIFIED: `timezone: 'UTC'` appears 2 times in jobs/index.ts (resetDailyLimits + dailyOutreachDigest)
- VERIFIED: `npm run build` exits 0 (twice — once per task)
