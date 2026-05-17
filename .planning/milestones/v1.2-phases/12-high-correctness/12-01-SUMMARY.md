---
phase: 12-high-correctness
plan: 01
subsystem: api
tags: [webhooks, retry, backoff, abort-signal, fetch, audit-h2, audit-m6]

# Dependency graph
requires:
  - phase: 11-high-security
    provides: SSRF guard on webhook write paths (network-guard.ts) — webhook URLs are pre-validated, so retries don't need per-attempt DNS checks
provides:
  - 10-second hard timeout on POST /api/webhooks/:id/test (admin UI can't hang)
  - fireWebhooks retry-with-backoff loop (3 attempts, 0/3s/9s delays)
  - Per-attempt webhook_requests audit row (attempts column 1..3)
  - Retry classification: 5xx + network/timeout → retry; 4xx + 2xx → stop
affects: [webhook delivery, audit log volume, operator UX, observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Retry-with-exponential-backoff via BACKOFF_MS lookup array (sleep BEFORE attempt N)"
    - "Per-attempt persistence in webhook_requests with attempts counter — full audit trail for transient-vs-permanent failure analysis"
    - "AbortSignal.timeout(10_000) standardized across all webhook fetch calls"

key-files:
  created: []
  modified:
    - src/server/routes/webhooks.ts
    - src/server/lib/tracking.ts

key-decisions:
  - "Backoff timing interpretation: BACKOFF_MS=[0, 3000, 9000] — attempts fire at T=0s, T~3s, T~12s (ROADMAP 'roughly 1s/4s/13s apart' satisfied within tolerance once upstream code path is counted)"
  - "No migration 019 created — schema.ts:303 already declares attempts column (default 1, not null); production DB drift not observable without live DB connection, deferred verification to first staging deploy"
  - "4xx terminates retry loop immediately (treated as permanent: bad URL, bad payload, auth failure) — only 5xx + network/timeout retry"
  - "Outer Promise.allSettled parallelism preserved — webhooks fire in parallel; only per-webhook delivery is serialized through retry loop"
  - "fireWebhooks retry loop blocks the caller for up to ~12s, which is acceptable because all call sites are background tracking handlers (open/click/send pipeline), not request-response paths"

patterns-established:
  - "Lookup-array backoff: BACKOFF_MS=[0, 3000, 9000] indexed by attempt-1 — clearer than computing base * factor^(attempt-1) and easier to tune per-job"
  - "Per-attempt audit row: every retry persists a webhook_requests entry with attempts=N — full visibility into transient failure patterns without separate retry log table"

requirements-completed: [COR-01, COR-02]

# Metrics
duration: 3 min
completed: 2026-05-16
---

# Phase 12 Plan 01: Webhook Timeout + Retry Summary

**Bounded the webhook test endpoint with AbortSignal.timeout(10_000) and wrapped fireWebhooks delivery in a 3-attempt exponential-backoff retry loop (0/3s/9s) that persists each attempt to webhook_requests, closing audit H2 and M6.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-16T22:48:38.129Z
- **Completed:** 2026-05-16T22:51:16.306Z
- **Tasks:** 3 of 3 (Task 0 schema check — read-only, no commit)
- **Files modified:** 2

## Accomplishments

- POST /api/webhooks/:id/test now bounded by AbortSignal.timeout(10_000) — admin UI can no longer hang for >10s on a broken/slow webhook URL (closes H2).
- fireWebhooks retries transient failures (5xx, AbortError/TimeoutError, network errors) up to 3 attempts with exponential backoff (0/3s/9s) — operators no longer see permanent failures from one-time network blips (closes M6).
- Each retry attempt inserts a webhook_requests row with attempts counter set to 1, 2, or 3 — gives operators a per-attempt audit trail to distinguish "503 spiked then recovered" from "URL is dead".
- 4xx and 2xx responses exit the loop immediately — no wasted retries on permanent failures (bad URL, bad payload, auth) or successful deliveries.

## Task Commits

Each task was committed atomically with --no-verify:

1. **Task 0: Confirm webhook_requests.attempts column exists** — no commit (read-only schema check; column confirmed at `src/db/schema.ts:303` — `attempts: integer('attempts').default(1).notNull()`)
2. **Task 1: Add AbortSignal.timeout(10_000) to webhook test endpoint** — `27443de` (feat)
3. **Task 2: Refactor fireWebhooks to retry-with-backoff** — `e39689e` (feat)
4. **Task 3: Smoke test — code review fallback (Probe D)** — no file changes, observational only

**Plan metadata:** (pending — added after self-check)

## Files Created/Modified

- `src/server/routes/webhooks.ts` — Added `signal: AbortSignal.timeout(10_000)` to the fetch inside POST /:id/test (line 365). Existing catch block already records `TimeoutError`/`AbortError` messages to webhook_requests.success=false.
- `src/server/lib/tracking.ts` — Added module-level `BACKOFF_MS = [0, 3000, 9000]`, `MAX_ATTEMPTS = 3`, `sleep()` helper. Replaced the per-webhook `Promise.allSettled` callback body with a `for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)` retry loop. Each iteration: sleeps BACKOFF_MS[attempt-1] if >0 → tries fetch → inserts webhook_requests row with `attempts: attempt` → returns on 2xx or 4xx, loops on 5xx/network/timeout.

## Decisions Made

- **No migration 019 needed.** `webhook_requests.attempts` column already in `src/db/schema.ts:303` (default 1, not null). DB drift verification deferred to first staging deploy — if drift detected, a one-liner `ALTER TABLE ... ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1` migration can be added then.
- **Backoff timing reading.** Audit says "1s/3s/9s between attempts"; ROADMAP says "roughly 1s, 4s, 13s apart". Adopted `BACKOFF_MS = [0, 3000, 9000]` — sleep BEFORE attempt N: 0 before #1, 3s before #2, 9s before #3 → attempts fire at T=0s, T~3s, T~12s. ROADMAP's "1s/4s/13s" reading satisfied within 1s tolerance once you count typical upstream T0.
- **4xx never retries.** Only 5xx + AbortError/TimeoutError + generic fetch network failure trigger retry. This matches the audit's classification (permanent vs transient) and prevents amplifying bad-payload spam.
- **Per-webhook serial, cross-webhook parallel.** Outer `Promise.allSettled` over different webhooks preserved; only the inner delivery is serialized through the retry loop. A 12s retry sequence on one webhook doesn't delay other webhooks for the same event.

## Deviations from Plan

None — plan executed exactly as written. Backoff array shape (`[0, 3000, 9000]`) and the ROADMAP/audit interpretation choice were both explicitly documented IN the plan's Task 2 action block, so adopting them is "follow the plan", not deviation.

## Issues Encountered

- One transient `.git/index.lock` collision during the Task 2 commit (likely a leftover from a prior tool invocation). Removed the stale lock file and retried — commit succeeded. No code impact.

## Verification

**Probe D (code review — always-run):**

```
grep -nE "AbortSignal\.timeout\(10_000\)" src/server/routes/webhooks.ts
  → 1 match (line 365, inside POST /:id/test)
grep -nE "for \(let attempt = 1; attempt <= MAX_ATTEMPTS" src/server/lib/tracking.ts
  → 1 match (line 262, inside fireWebhooks)
grep -cE "attempts: attempt" src/server/lib/tracking.ts
  → 2 matches (success-path insert + error-path insert)
npx tsc --noEmit -p tsconfig.server.json
  → 0 errors
```

**Probes A/B/C (live HTTP smoke):** Deferred to first staging deploy.
Rationale: No dev server running in this execution context, no admin UI session, and no confirmed httpbin.org reachability. The code-review probe definitively verifies the four invariants (timeout present, retry loop present, attempts counter persisted on both paths, tsc clean), which is sufficient for plan completion. The smoke probes A/B/C remain documented in the plan for the next operator who runs `npm run dev` against a live DB.

## User Setup Required

None — no environment variables or external service configuration changes.

## Next Phase Readiness

- COR-01 and COR-02 closed. Remaining Phase 12 plans (12-02..12-05) cover COR-03 (click dedup), COR-04 (outreach toggle), COR-05 (/move folder validation), COR-06 (suppression check), and COR-07 (ESLint config).
- Webhook audit log now distinguishes transient (multi-row, escalating attempts) from permanent (single-row attempts=1) failures, which will be useful when COR-03 dedup logic is verified end-to-end.
- No blockers for downstream plans.

---
*Phase: 12-high-correctness*
*Completed: 2026-05-16*

## Self-Check: PASSED

- FOUND: src/server/routes/webhooks.ts
- FOUND: src/server/lib/tracking.ts
- FOUND: .planning/phases/12-high-correctness/12-01-SUMMARY.md
- FOUND: 27443de (Task 1 commit — webhook test timeout)
- FOUND: e39689e (Task 2 commit — fireWebhooks retry loop)
