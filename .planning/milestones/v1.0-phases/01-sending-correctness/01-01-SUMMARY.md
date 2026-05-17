---
phase: 01-sending-correctness
plan: 01
subsystem: outreach-jobs
tags: [daily-reset, idempotency, schema, cron]
dependency_graph:
  requires: []
  provides: [SEND-01, SEND-05]
  affects: [processOutreachSequences, schema.outreachEmails]
tech_stack:
  added: []
  patterns: [drizzle .returning(), db.query.findFirst idempotency check, uniqueIndex constraint]
key_files:
  created: []
  modified:
    - src/server/jobs/processOutreachSequences.ts
    - src/db/schema.ts
decisions:
  - Idempotency guard inserted after currentStep is confirmed but before subject interpolation, so currentStep.id is available
  - DB-level unique constraint added as a safety net; code-level check fires first for clean log output
metrics:
  duration: 3 minutes
  completed: 2026-03-30
---

# Phase 1 Plan 01: Daily Reset + Idempotency Guard Summary

**One-liner:** Added `.returning()`+log to `resetDailyLimits` and a pre-send `outreachEmails` existence check with a `uniqueIndex` on `(campaignLeadId, sequenceStepId)`.

## What Was Done

### Task 1 — resetDailyLimits (SEND-01)

The `resetDailyLimits` function already existed with the correct WHERE clause (`gt(emailAccounts.currentDailySent, 0)`) and was already imported and scheduled at `'0 0 * * *'` in `index.ts`. The only gap was observability: operators had no way to know how many accounts were reset. Fixed by adding `.returning({ id: emailAccounts.id })` and a `console.log` count line.

### Task 2 — Idempotency guard (SEND-05)

Two changes:

1. **schema.ts**: Added `uniqueIndex('outreach_emails_campaign_lead_step_unique').on(table.campaignLeadId, table.sequenceStepId)` as the second argument to the `outreachEmails` pgTable call. This is a DB-level guard that prevents duplicate rows even if the code check is bypassed.

2. **processOutreachSequences.ts**: Inserted a `db.query.outreachEmails.findFirst` call immediately after `currentStep` is confirmed and before `sendEmail` is called (line 251 vs 267). If a matching row exists the loop logs and `continue`s — no SMTP call is made.

## Files Changed

| File | Change |
|------|--------|
| `src/server/jobs/processOutreachSequences.ts` | Added `.returning()`+log to `resetDailyLimits`; added idempotency guard block |
| `src/db/schema.ts` | Added `campaignLeadStepUnique` uniqueIndex on `outreachEmails` |

## Acceptance Criteria Verification

```
grep "export async function resetDailyLimits" src/server/jobs/processOutreachSequences.ts  -> PASS (line 368)
grep "currentDailySent: 0" src/server/jobs/processOutreachSequences.ts                    -> PASS (line 370)
grep "resetDailyLimits" src/server/jobs/index.ts                                           -> PASS (lines 5, 34)
grep "'0 0 \* \* \*'" src/server/jobs/index.ts                                            -> PASS (line 33)
grep "campaignLeadStepUnique" src/db/schema.ts                                             -> PASS (line 846)
grep "outreach_emails_campaign_lead_step_unique" src/db/schema.ts                          -> PASS (line 846)
grep "existingEmail" src/server/jobs/processOutreachSequences.ts                           -> PASS (lines 251, 257, 258)
grep "Skipping duplicate send" src/server/jobs/processOutreachSequences.ts                 -> PASS (line 258)
existingEmail (251) appears before sendEmail call (267)                                    -> PASS
uniqueIndex imported exactly once in schema.ts                                             -> PASS (line 10 only)
```

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `src/server/jobs/processOutreachSequences.ts` — modified and committed (171bc02, 5077479)
- `src/db/schema.ts` — modified and committed (5077479)
- Both commits exist in git log
