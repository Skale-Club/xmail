---
phase: 16-reply-detection-v2-plus-per-inbox-throttle
plan: 02
subsystem: outreach-processor-throttle
tags: [throttle, outreach, processor, structured-logging, deliverability]
requirements: [INBOX-THROTTLE]
requires:
  - outreach-sender.ts:applySendJitter (Plan 16-01)
  - outreach-sender.ts:canSendFromAccount(account, now) extended signature (Plan 16-01)
  - schema.ts:emailAccounts.lastSentAt (pre-existing column declaration)
  - schema.ts:campaignLeads.assignedEmailAccountId (pre-existing for inbox grouping)
  - schema.ts:emailAccounts.{minMinutesBetweenEmails, maxMinutesBetweenEmails}
provides:
  - "Per-inbox min-spacing throttle at lead-selection time (canSendFromAccount(account, now))"
  - "Jittered nextScheduledAt for the NEXT same-inbox pending lead after every successful send"
  - "Standardized [outreach.processor] structured JSON log shape across all skip/jitter/reset events"
  - "logSkip(reason, ctx) module helper + SkipReason discriminated union"
affects:
  - src/server/jobs/processOutreachSequences.ts (only file modified — 4 atomic commits)
tech-stack:
  added: []
  patterns:
    - "Discriminated-union SkipReason type for compile-time enforcement of log reasons"
    - "In-memory batch mutation (sameInboxNext.nextScheduledAt = jittered) to make the per-tick loop consistent with the DB"
    - "Uniform [outreach.processor] log prefix prepares Phase 17 pino swap (one grep regex)"
key-files:
  created: []
  modified:
    - src/server/jobs/processOutreachSequences.ts
decisions:
  - "Cause-discrimination on canSendFromAccount === false split into two skip reasons (daily_limit_reached vs rate_limit_per_inbox) by re-reading the currentDailySent >= dailySendLimit predicate. Avoids leaking helper internals into the caller while still surfacing ops-actionable reason to the log."
  - "applySendJitter called with fresh `new Date()` (not the tick-time `now`) so the jittered timestamp is anchored at the moment of the send, not at tick-start. Marginal difference in practice (tick is sub-second) but conceptually correct: the new send-spacing budget starts when this send actually completed."
  - "in-memory mutation of pendingLeads[i].nextScheduledAt is intentional. Without it, later iterations in the same tick would see the OLD (already-past) schedule and burn a logSkip+claim-attempt cycle (the throttle would catch them via canSendFromAccount, but the log volume balloons). With the mutation, those leads cleanly skip the eligibility filter on the next tick instead."
  - "Send-failure error log (line 328 `[processOutreachSequences] Send failed`) and advisory-lock log (line 474) are LEFT alone — they are not skip-reasons (they are result.errors++ outcomes / lock-acquisition outcomes). The plan's scope was explicitly skip-branches + the resetDailyLimits log. Phase 17's pino sweep will consolidate them."
  - "incrementAccountStats('totalSent') already writes lastSentAt = NOW() (per outreach-sender.ts:323 — preserved from Plan 16-01 Task 2 verification). No additional `UPDATE email_accounts SET last_sent_at = NOW()` was added because that would be a redundant duplicate UPDATE. The throttle relies on this existing write."
metrics:
  duration: "~12 minutes"
  completed_date: "2026-05-17T15:01:00Z"
  tasks_completed: 4
  tasks_total: 4
  files_changed: 1
  commits: 4
---

# Phase 16 Plan 02: Wire per-inbox throttle into outreach processor — Summary

**One-liner:** `processOutreachSequences.ts` now enforces per-inbox throttling at lead-selection time via the extended `canSendFromAccount(account, now)`, jitters the next same-inbox pending lead's `nextScheduledAt` via `applySendJitter`, and emits standardized `[outreach.processor]` JSON logs for every skip/jitter/reset path — closing the single biggest deliverability gap (burst-send pattern detection by Gmail/Yahoo).

## Tasks Completed

### Task 1: Add structured skip-log helper + import applySendJitter (commit `9bc9340`)

Two edits at the top of `processOutreachSequences.ts`:

1. **Extended outreach-sender import** — added `applySendJitter` to the named-imports block (line 22).
2. **New module-private `logSkip` helper + `SkipReason` discriminated union** — placed after `selectAbVariant`, before `processOutreachSequences`. The union enumerates 13 reasons (`rate_limit_per_inbox`, `daily_limit_reached`, `suppression`, `no_active_step`, `outside_send_window`, `claim_conflict`, `unsubscribed`, `campaign_inactive`, `campaign_not_found`, `lead_not_found`, `no_account`, `account_not_verified`, `in_batch_duplicate`). The helper emits `console.log('[outreach.processor]', JSON.stringify({action: 'skip', reason, ...ctx}))` so a single grep `[outreach.processor]` in production logs returns every processor decision in a uniform shape.

### Task 2: Wire throttle filter + replace all skip logs (commit `7e02e67`)

Edited the main `for (const campaignLead of pendingLeads)` loop body (lines ~144-260). Every existing `continue` now has a structured `logSkip(reason, ctx)` immediately before it. The most consequential edit is the throttle wire:

```ts
if (!canSendFromAccount(emailAccount, now)) {
    if (emailAccount.currentDailySent >= emailAccount.dailySendLimit) {
        logSkip('daily_limit_reached', { ... extra: { currentDailySent, dailySendLimit } })
    } else {
        // Implied cause: lastSentAt + min*60s > now
        logSkip('rate_limit_per_inbox', { ... extra: { minMinutesBetweenEmails, lastSentAt } })
    }
    continue
}
```

The `now` second-arg (captured at line 77 of `processOutreachSequences`) ensures every lead within a single tick is evaluated against the same instant — important because `pendingLeads` can have 200 entries and a tick can run hundreds of ms.

Also added `logSkip` for branches that were previously **silently** continuing (no log at all): `campaign_inactive`, `unsubscribed`, `suppression`, `outside_send_window`. Operators can now see WHY any lead was skipped.

### Task 3: Jitter the next same-inbox pending lead's nextScheduledAt (commit `38a19c0`)

Inserted a new block after `incrementAccountStats(emailAccount.id, 'totalSent')` and before the next-step scheduling block. The block walks `pendingLeads` to find another lead sharing this `emailAccount.id` whose `nextScheduledAt <= now`, jitters its `nextScheduledAt` to `applySendJitter(min, max, new Date())`, persists the UPDATE, mutates the in-memory copy, and emits an `[outreach.processor] {action: 'jitter_next', ...}` log.

Why mutate in-memory: without it, the later iterations of THIS tick's loop see the OLD (past) `nextScheduledAt` on the same lead and try to send. The throttle (via `canSendFromAccount`) would catch them, but with N same-inbox leads in the batch we'd burn N redundant `logSkip + INSERT...ON CONFLICT DO NOTHING` cycles. Mutating makes the next iteration's `lte(nextScheduledAt, now)` filter no longer match on the in-memory eligible set — clean log tape.

### Task 4: Standardize resetDailyLimits log (commit `e3740e7`)

Replaced the final `console.log` in `resetDailyLimits` from `[resetDailyLimits] Reset daily send counter for ${result.length} accounts` to:

```ts
console.log('[outreach.processor]', JSON.stringify({
    action: 'reset_daily_limits',
    accounts: result.length,
}))
```

DB UPDATE query is byte-for-byte unchanged. Uniform prefix lets a single ops query (`grep '[outreach.processor]'`) return the full processor tape: skips, jitter, daily reset, future events.

## Verification Results

| Check | Required | Actual | Result |
|---|---|---|---|
| `grep -c "minMinutesBetweenEmails"` | ≥ 1 | 5 | PASS |
| `grep -c "applySendJitter"` | ≥ 2 | 2 (import + call) | PASS |
| `grep -c "pg_try_advisory_lock"` (Phase 14 preserved) | ≥ 1 | 1 | PASS |
| `grep -c "logSkip("` | ≥ 11 | 14 (1 def + 13 callsites) | PASS |
| `grep -c "rate_limit_per_inbox"` | ≥ 2 | 2 (type + callsite) | PASS |
| `grep -c "reset_daily_limits"` | ≥ 1 | 1 | PASS |
| `grep -c "outreach.processor"` | ≥ 3 | 3 (logSkip + jitter_next + reset_daily_limits — all share the prefix; matches once per distinct call site) | PASS |
| `grep -c "[resetDailyLimits]"` (old log gone) | 0 | 0 | PASS |
| `grep -c "lastSentAt"` | ≥ 2 | 5 | PASS |
| `grep -c "sameInboxNext"` | ≥ 3 | 6 | PASS |
| `grep -c "jitter_next"` | exactly 1 | 1 | PASS |
| `npm run build` | exit 0 | exit 0 | PASS |
| `npm run build` after Task 1 | exit 0 | exit 0 | PASS |
| `npm run build` after Task 2 | exit 0 | exit 0 | PASS |
| `npm run build` after Task 3 | exit 0 | exit 0 | PASS |
| `npm run build` after Task 4 | exit 0 | exit 0 | PASS |
| Advisory-lock wrapper byte-for-byte preserved | yes | yes | PASS |

## Deviations from Plan

None — plan executed exactly as written. All four tasks landed in their prescribed locations with the prescribed code. The two `[processOutreachSequences]` strings that remain (line 328 send-failure log, line 474 advisory-lock log) are intentionally out of the plan's scope: the plan governed `skip` branches and the resetDailyLimits log specifically.

## Authentication Gates

None. Pure code changes — no external systems, no auth secrets touched.

## Operator Deployment Gate (CRITICAL — read before shipping)

**Migration 021 (Plan 16-01) MUST be applied to production BEFORE this code is deployed.** The processor now calls `canSendFromAccount(account, now)` which reads `account.lastSentAt`, and `incrementAccountStats('totalSent')` already writes `lastSentAt = NOW()`. Both Drizzle calls map to the `email_accounts.last_sent_at` column which DOES NOT EXIST in production yet (Plan 16-01 created the migration but explicitly did not apply it).

Symptoms of skipping this step:
- First send after deploy: `incrementAccountStats` UPDATE fails with `column "last_sent_at" of relation "email_accounts" does not exist`
- Processor logs `result.errors++` and the lead's outreach_emails row is left in `status='queued'` with no `sentAt`
- The next tick retries (claim-conflict on the existing `queued` row) and the cycle repeats

**Run BEFORE deploying this code:**

```bash
DATABASE_URL=$PROD_DATABASE_URL node scripts/apply-pending-migrations.mjs
```

This applies migration 021 idempotently (CREATE INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS). Verify with:

```bash
psql $PROD_DATABASE_URL -c "\d email_accounts" | grep last_sent_at
```

Expected output: `last_sent_at | timestamp with time zone | | |`

After migration is in, the Plan 16-02 code can roll out safely.

## Downstream Consumers

- **Phase 17 (observability):** will replace every `console.log('[outreach.processor]', JSON.stringify(...))` call in this file with a single `pino` logger statement. The uniform `[outreach.processor]` prefix means Phase 17's sweep is a one-shot find-replace.
- **Plan 16-03 (processReplies — already shipped):** independent — no consumption of this plan's outputs.
- **Plan 16-04 (resetDailyLimits cron pin — already shipped):** depends on the existence of `resetDailyLimits` (unchanged signature). The log-shape change in Task 4 is compatible — Plan 16-04 only edited the cron schedule, not the function body.

## Known Stubs

None. Every emitted log path is connected to either a `continue` (skip-branches) or a DB UPDATE side-effect (jitter_next, resetDailyLimits). No placeholders, no TODOs, no commented-out code introduced.

## Production Behavior Forecast

With migration 021 applied and this code deployed, for a campaign with 10 leads all assigned to one inbox and `minMinutesBetweenEmails=5`:

- **Tick 1** (T+0): Lead 1 sends. Lead 2's `nextScheduledAt` is jittered to T+jitter_minutes (e.g., T+12min if max=30). Leads 3-10 are still at their original past `nextScheduledAt` BUT canSendFromAccount returns false for the inbox → 8 logSkip with `reason: 'rate_limit_per_inbox'`.
- **Tick 2** (T+1min, cron interval): Lead 1's lastSentAt = T+0, so canSendFromAccount false until T+5min → all 9 remaining leads logSkip `rate_limit_per_inbox`.
- **Tick at T+5min**: Lead 1's throttle clears, but Lead 2's `nextScheduledAt` is at T+jitter (could be T+5..T+30). If T+jitter < T+5min, Lead 2 becomes eligible NOW and sends. If T+jitter > T+5min, the throttle clears but `lte(nextScheduledAt, now)` filter excludes Lead 2 — wait until that point.
- **Steady state**: One send per inbox per `random(min, max)` minutes. For default 5..30, that's 2-12 sends/hour/inbox = well below Gmail's 500/day soft limit and far below the burst-detection threshold (~10 in <30sec).

`grep '[outreach.processor]' app.log | jq -s 'group_by(.reason) | map({reason: .[0].reason, count: length})'` gives an ops dashboard of skip-cause distribution per hour.

## Commits

| # | Hash | Type | Description |
|---|---|---|---|
| 1 | `9bc9340` | feat | add logSkip helper and import applySendJitter |
| 2 | `7e02e67` | feat | wire per-inbox throttle + standardize all skip logs |
| 3 | `38a19c0` | feat | jitter next same-inbox lead nextScheduledAt after send |
| 4 | `e3740e7` | refactor | standardize resetDailyLimits log to [outreach.processor] shape |

Final docs commit will bundle this SUMMARY.md plus STATE.md and ROADMAP.md updates.

## Self-Check: PASSED

- src/server/jobs/processOutreachSequences.ts (modified) — FOUND on disk
- .planning/phases/16-reply-detection-v2-plus-per-inbox-throttle/16-02-SUMMARY.md (this file) — being created
- Commit `9bc9340` — FOUND in git log
- Commit `7e02e67` — FOUND in git log
- Commit `38a19c0` — FOUND in git log
- Commit `e3740e7` — FOUND in git log
- `npm run build` — exit 0 (verified after each task)
- All success-criteria greps — pass (table above)
