---
phase: 16-reply-detection-v2-plus-per-inbox-throttle
plan: 01
subsystem: outreach-throttle-foundation
tags: [migration, throttle, outreach, schema-alignment, dormant-helper]
requirements: [INBOX-THROTTLE]
requires:
  - schema.ts:emailAccounts.lastSentAt (pre-existing at line 681)
  - schema.ts:emailAccounts.minMinutesBetweenEmails (pre-existing line 664)
  - schema.ts:emailAccounts.maxMinutesBetweenEmails (pre-existing line 665)
provides:
  - migration-021:email_accounts.last_sent_at column (timestamptz, nullable)
  - migration-021:email_accounts_last_sent_at_idx partial index (WHERE status='verified')
  - applySendJitter(min, max, now?): Date — exported from outreach-sender.ts
  - canSendFromAccount(account, now?): boolean — extended with per-inbox throttle clause
affects:
  - src/server/lib/outreach-sender.ts (extended canSendFromAccount signature; helper added)
  - supabase/migrations/021_email_accounts_last_sent_at.sql (new file)
tech-stack:
  added: []
  patterns:
    - "Idempotent migration pattern (BEGIN/COMMIT + IF NOT EXISTS) mirroring migration 020"
    - "Optional `now: Date` parameter for time-injectable helpers (testable without mocking Date)"
    - "Dormant helper export — landed in Wave 1, consumed in Wave 2 (Plan 16-02)"
key-files:
  created:
    - supabase/migrations/021_email_accounts_last_sent_at.sql
  modified:
    - src/server/lib/outreach-sender.ts
decisions:
  - "applySendJitter signature is (min, max, now=new Date()) returning Date — Plan 16-02 consumes this when scheduling next pending lead. Plan-internal contract: min/max are MINUTES (not seconds), output is an absolute Date in the future."
  - "canSendFromAccount gained an optional `now` parameter (default new Date()) so processOutreachSequences can pass a single tick-time consistently across all lead-eligibility checks within one cron invocation."
  - "Did NOT modify the incrementAccountStats writes to updateData.lastSentAt at lines 286/290 — they were already correct and will start succeeding in prod once migration 021 lands."
metrics:
  duration: "~10 minutes"
  completed_date: "2026-05-17T14:46:33Z"
  tasks_completed: 3
  tasks_total: 3
  files_changed: 2
  commits: 2
---

# Phase 16 Plan 01: Per-inbox throttle foundation — Summary

**One-liner:** Migration 021 adds `email_accounts.last_sent_at` to prod (closing the schema/prod drift), plus `outreach-sender.ts` gains a dormant `applySendJitter` helper and an extended `canSendFromAccount` that enforces `lastSentAt + minMinutesBetweenEmails*60s > now → false` — both prerequisites for Plan 16-02's processor wiring.

## Tasks Completed

### Task 1: Migration 021 (commit `ed43761`)

Created `supabase/migrations/021_email_accounts_last_sent_at.sql`:

- `ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS last_sent_at timestamptz` — nullable; NULL means "never sent" (throttle inapplicable).
- `CREATE INDEX IF NOT EXISTS email_accounts_last_sent_at_idx ON email_accounts(last_sent_at) WHERE status = 'verified'` — partial index keeps the lookup lean since `canSendFromAccount` short-circuits on `status != 'verified'`.
- `BEGIN; ... COMMIT;` envelope with `IF NOT EXISTS` clauses for idempotent re-runs (mirrors migration 020 style).
- No backfill needed — NULL on existing rows is the correct default semantics.

### Task 2: applySendJitter + canSendFromAccount throttle clause (commit `76948e0`)

Two edits in `src/server/lib/outreach-sender.ts`:

**Edit 1 — Extended `canSendFromAccount` (lines 79-103):**
- Added optional `now: Date = new Date()` parameter.
- New clause AFTER the daily-limit check, BEFORE the final `return true`:
  ```ts
  if (account.lastSentAt) {
      const minMs = account.minMinutesBetweenEmails * 60_000
      const earliestNextSend = account.lastSentAt.getTime() + minMs
      if (earliestNextSend > now.getTime()) {
          return false
      }
  }
  ```
- Backwards-compatible: existing single-argument callers continue to work because `now` defaults to `new Date()`.

**Edit 2 — New `applySendJitter` export (lines 105-122):**
```ts
export function applySendJitter(min: number, max: number, now: Date = new Date()): Date {
    const lo = Math.max(0, min)
    const hi = Math.max(lo, max)
    const minutes = lo + Math.random() * (hi - lo)
    return new Date(now.getTime() + minutes * 60_000)
}
```
- Clamps negatives to 0 and `hi >= lo` defensively so degenerate inputs (min===max, or max<min) don't produce a past timestamp.
- Returns minutes (not seconds) offset — aligns with the `minMinutesBetweenEmails` column unit.

### Task 3: schema.ts mirror verification (no commit — verification-only)

`src/db/schema.ts:681` already declares `lastSentAt: timestamp('last_sent_at')` (added pre-phase-16). No code change required — task was a guard against regression.

- `grep -c "lastSentAt: timestamp('last_sent_at')" src/db/schema.ts` = **1** (passed).
- `npm run build` exits 0 (full TS surface compiles cleanly — verified after Task 2 edits, see verification section).

## Verification Results

| Check | Result |
|---|---|
| Migration 021 has `ADD COLUMN IF NOT EXISTS last_sent_at` | PASS |
| Migration 021 has `CREATE INDEX IF NOT EXISTS email_accounts_last_sent_at_idx` | PASS |
| Migration 021 has `WHERE status = 'verified'` partial-index clause | PASS |
| Migration 021 has `BEGIN; ... COMMIT;` envelope | PASS |
| `applySendJitter` exported from outreach-sender.ts | PASS (line 117) |
| `account.lastSentAt` reference in `canSendFromAccount` body | PASS (line 95) |
| `minMinutesBetweenEmails * 60_000` in `canSendFromAccount` | PASS (line 96) |
| `now: Date = new Date()` optional param pattern | PASS (lines 81 and 117) |
| `npm run build` exits 0 | PASS — both client (Vite) and server (tsc -p tsconfig.server.json) compiled cleanly |
| schema.ts `lastSentAt` declaration intact | PASS (1 match at line 681) |
| `incrementAccountStats` lines 286/290 lastSentAt writes unchanged | PASS (no diff in those lines) |

## Deviations from Plan

None — plan executed exactly as written. Task 3 produced no commit because the schema.ts column declaration was already present and verification passed.

## Authentication Gates

None. Pure code + DDL changes — no external systems touched.

## Operator Deployment Gate (carried forward to Plan 16-02 ship)

Before Plan 16-02 deploys to production, the operator MUST run:

```bash
DATABASE_URL=$PROD_DATABASE_URL node scripts/apply-pending-migrations.mjs
```

This applies migration 021 to prod. Skipping this step will cause `incrementAccountStats('totalSent')` to fail with `column "last_sent_at" of relation "email_accounts" does not exist` on the next send. The schema.ts already references the column so Drizzle types are correct, but the underlying DB will reject the UPDATE.

**This plan does NOT apply the migration** — that is an explicit operator step.

## Downstream Consumers

- **Plan 16-02 (processOutreachSequences):** imports `applySendJitter` to spread `nextScheduledAt` across pending leads; relies on the extended `canSendFromAccount` for per-inbox throttle gating. Both APIs are now dormant-but-ready.
- **Plan 16-03 (processReplies):** independent — no consumption of this plan's outputs.
- **Plan 16-04 (jobs/index.ts):** independent — no consumption of this plan's outputs.

## Known Stubs

None. All exports are functional and verified by `npm run build` to typecheck cleanly. The `applySendJitter` helper has no callers yet (intentional — Plan 16-02 wires it), but this is not a stub: the function is fully implemented and a separate plan is the consumer.

## Commits

| # | Hash | Type | Description |
|---|---|---|---|
| 1 | `ed43761` | feat | add migration 021 for email_accounts.last_sent_at |
| 2 | `76948e0` | feat | add applySendJitter helper and extend canSendFromAccount with throttle check |

Final docs commit will bundle this SUMMARY.md plus STATE.md and ROADMAP.md updates.

## Self-Check: PASSED

- supabase/migrations/021_email_accounts_last_sent_at.sql — FOUND
- src/server/lib/outreach-sender.ts (modified) — FOUND
- Commit ed43761 — FOUND in git log
- Commit 76948e0 — FOUND in git log
- npm run build — exit 0
- schema.ts:681 lastSentAt declaration — FOUND (1 match)
