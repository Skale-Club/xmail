---
phase: 12-high-correctness
plan: 02
plan_id: 12-02
subsystem: tracking
tags: [tracking, click-dedup, audit-H4, COR-03, migration]
requires:
  - migration: 018_add_mailbox_skip_tls_verify.sql (latest pre-existing)
provides:
  - column: messages.clicked_at (TIMESTAMP NULL)
  - schema-field: messages.clickedAt
  - dedup: 60s sliding-window dedup of /t/click/:token analytics (stat + webhook)
affects:
  - route: GET /t/click/:token
  - stat: statistics.linksClicked
  - webhook: link_clicked event
tech-stack:
  added: []
  patterns:
    - Atomic UPDATE-with-WHERE dedup gate using .returning() (claim-a-row pattern)
    - drizzle-orm raw `sql` template for Postgres INTERVAL expressions
key-files:
  created:
    - supabase/migrations/019_add_message_clicked_at.sql
  modified:
    - src/db/schema.ts
    - src/server/routes/track.ts
decisions:
  - "60-second sliding window for click-replay dedup (per ROADMAP success criterion #3)"
  - "DB-backed dedup (column on messages) instead of in-memory Map — multi-instance safe"
  - "Single atomic UPDATE-with-WHERE replaces SELECT-then-UPDATE — no race window"
  - "Opens stay lifetime-dedup, clicks get 60s-window dedup (intentional semantic asymmetry per audit)"
  - "302 redirect remains on every hit; dedup gates ONLY analytics (stat + webhook), not user-facing redirect"
metrics:
  duration: ~3 minutes
  tasks-completed: 4/4
  files-created: 1
  files-modified: 2
  completed: 2026-05-16
requirements:
  - COR-03
---

# Phase 12 Plan 02: Click-Tracking Replay Dedup Summary

**One-liner:** Atomic UPDATE-with-WHERE gate on a new `messages.clicked_at` column dedups click-tracking analytics within a 60s sliding window, closing audit H4 without affecting the user-facing 302 redirect.

## What Was Built

Closes audit finding **H4** (click-tracking replay multiplication) and ROADMAP success criterion #3 ("10 clicks in 30s increments linksClicked exactly once").

### 1. Migration 019 — `clicked_at` column on `messages`

`supabase/migrations/019_add_message_clicked_at.sql`:

```sql
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS clicked_at timestamp NULL;

COMMENT ON COLUMN public.messages.clicked_at IS
    'Timestamp of most recent link click. Used by /t/click/:token handler to dedup ' ||
    'rapid replays within a 60s window. NULL = no click yet recorded.';
```

- Idempotent (`IF NOT EXISTS`).
- Nullable, no default — first click writes; absence = no click recorded yet.
- Mirrors the existing `opened_at` column pattern.

**Apply command (manual, per project workflow):**

```bash
psql "$DATABASE_URL" -f supabase/migrations/019_add_message_clicked_at.sql
# Verify:
psql "$DATABASE_URL" -c "\d messages" | grep clicked_at
```

### 2. Drizzle schema field — `src/db/schema.ts`

Added `clickedAt: timestamp('clicked_at')` to the `messages` table block, immediately after `openedAt` (line 248). Nullable, no default. tsc clean.

### 3. Click handler dedup gate — `src/server/routes/track.ts`

**Imports extended:**

```ts
import { eq, and, or, lt, isNull, sql } from 'drizzle-orm'
```

**Async tracking block replaced** with a single atomic UPDATE:

```ts
const updated = await db
    .update(messages)
    .set({ clickedAt: new Date(), updatedAt: new Date() })
    .where(
        and(
            eq(messages.token, token),
            or(
                isNull(messages.clickedAt),
                lt(messages.clickedAt, sql`NOW() - INTERVAL '60 seconds'`)
            )
        )
    )
    .returning({ id: messages.id, organizationId: messages.organizationId, subject: messages.subject, fromAddress: messages.fromAddress })

if (updated.length === 0) return  // replay within 60s OR unknown token — no-op

// "winning" first/refresh-after-60s — fire stats + webhook
await Promise.allSettled([
    incrementStat(message.organizationId, 'linksClicked'),
    fireWebhooks(message.organizationId, 'link_clicked', { ... }),
])
```

**Key invariants preserved:**
- `res.redirect(302, targetUrl)` at line 95 — unchanged. **Every hit still redirects.** Dedup gates only the analytics side-effects.
- SSRF guard (`isPrivateHost`) unchanged.
- URL parsing/validation unchanged.
- `fireWebhooks(link_clicked)` payload shape unchanged.
- `trackClicks` / `privacyMode` kill-switch hooks preserved for future per-org settings.

## Why Atomic UPDATE (Not SELECT-then-UPDATE)

The dedup correctness depends on Postgres serializing the WHERE+SET against concurrent UPDATEs on the same row. This is the default behavior under READ COMMITTED isolation (row-level write locks). Two clicks landing simultaneously:

1. Both evaluate the WHERE clause.
2. Postgres takes a row lock for the first writer.
3. The second writer waits, then re-evaluates the WHERE clause against the NOW-newer row → `clicked_at` is no longer NULL nor older than 60s → 0 rows returned → silent no-op.

No explicit transaction or advisory lock needed. The pre-refactor SELECT-then-act pattern had a race window between the SELECT and the side-effect; the new pattern eliminates it.

`updated.length === 0` intentionally conflates "no such token" with "replay hit" — both legitimately no-op the analytics path. The original code's separate `if (!message) return` branch is collapsed into the same silent-skip, trading a small loss of differentiated logging for atomicity and a single round-trip.

## Migration Number Coordination

Plan 12-01 (parallel, Wave 1) may have needed migration 019 for `webhook_requests.attempts` if schema drift was detected. **No collision occurred** — at executor start, `supabase/migrations/` showed `018_add_mailbox_skip_tls_verify.sql` as the latest, and 12-01 only claims 019 if `webhook_requests.attempts` is missing in the DB (audit confirms it isn't). Migration 019 is therefore exclusively assigned to 12-02 in this run. No bump to 020 was needed.

## Decisions Made

1. **60-second sliding window.** Per ROADMAP success criterion #3 and audit H4. A click 65 seconds later counts as a new engagement; 10 clicks in 30 seconds count as 1.
2. **DB-backed dedup, not in-memory.** The server may run multi-instance (load-balanced deploys); an in-memory Map would only dedup within one process. A column on `messages` keyed by `(token)` (which is unique per message) is the simplest multi-instance-safe primitive — no new table needed.
3. **Column on `messages`, not a new `track_events` table.** The dedup key is 1:1 with `messages.id` (since `token` is unique per message), so a dedicated table would just duplicate the join. A single column is cheaper and simpler.
4. **Single atomic UPDATE, not SELECT-then-UPDATE.** Eliminates the read-then-write race and saves a round-trip.
5. **Opens stay lifetime-dedup; clicks get 60s-window dedup — intentional asymmetry.** Opens answer "did this email get opened at all" (binary); clicks answer "how often did the user engage" (count with reasonable de-noising). The audit only asks for click dedup; the open-tracking handler at track.ts:19-66 is untouched.
6. **`updated.length === 0` silently no-ops both replays and unknown tokens.** No differentiated logging — the audit didn't ask for it, and it keeps the hot-path branchless.

## Files

**Created:**
- `supabase/migrations/019_add_message_clicked_at.sql` (commit `9fdab4e`)

**Modified:**
- `src/db/schema.ts` — added `clickedAt: timestamp('clicked_at')` after `openedAt` (commit `c379b5c`)
- `src/server/routes/track.ts` — extended drizzle-orm import; replaced async tracking block with atomic dedup-gate UPDATE (commit `51eed30`)

## Commits

| Hash    | Task   | Message                                                                       |
| ------- | ------ | ----------------------------------------------------------------------------- |
| 9fdab4e | Task 1 | feat(12-02): add migration 019 adding messages.clicked_at column              |
| c379b5c | Task 2 | feat(12-02): add clickedAt field to messages schema                           |
| 51eed30 | Task 3 | feat(12-02): atomic 60s dedup gate on click-tracking analytics (COR-03)       |

## Smoke Probe Results

**Probe D — code review (always run):**

```
$ grep -nE "clickedAt|clicked_at" src/server/routes/track.ts src/db/schema.ts supabase/migrations/019_add_message_clicked_at.sql
src/server/routes/track.ts:100:  // Atomic dedup gate: write clicked_at = NOW() only if...
src/server/routes/track.ts:106:  .set({ clickedAt: new Date(), updatedAt: new Date() })
src/server/routes/track.ts:111:  isNull(messages.clickedAt),
src/server/routes/track.ts:112:  lt(messages.clickedAt, sql`NOW() - INTERVAL '60 seconds'`)
src/server/routes/track.ts:140:  clickedAt: new Date().toISOString(),
src/db/schema.ts:248:  clickedAt: timestamp('clicked_at'),
supabase/migrations/019_add_message_clicked_at.sql:11:  ADD COLUMN IF NOT EXISTS clicked_at timestamp NULL;

$ grep -nE "INTERVAL '60 seconds'" src/server/routes/track.ts
112:  lt(messages.clickedAt, sql`NOW() - INTERVAL '60 seconds'`)

$ npx tsc --noEmit -p tsconfig.server.json
# (no output — clean)
```

**Result: PASS.** clickedAt is wired through all three artifacts (migration, schema, handler); INTERVAL clause present exactly once; tsc passes with zero errors.

**Probes A, B, C — runtime click-replay scenarios:**

Deferred to first staging deploy. These require:
1. A live `npm run dev:server` instance.
2. A real tracked message with a click-tracked URL — which requires SMTP credentials and a configured outbound mailbox to send through.
3. Direct DB access to query `statistics.links_clicked` deltas.

This executor runs in a sandboxed plan-execution environment without a running server or SMTP. The probe procedures are documented in 12-02-PLAN.md Task 4 for the staging deploy team to execute as part of the rollout checklist.

## Deviations from Plan

None — plan executed exactly as written. Migration 019 was free (no collision with 12-01), so no number bump needed.

## Audit Checklist

- [x] **H4 (click-tracking replay multiplication)** — closed by atomic 60s dedup gate.
- [x] **COR-03** (ROADMAP success criterion #3) — implementation in place; runtime smoke probes deferred to staging.

## Self-Check: PASSED

- [x] `supabase/migrations/019_add_message_clicked_at.sql` exists.
- [x] `src/db/schema.ts` contains `clickedAt: timestamp('clicked_at')` at line 248.
- [x] `src/server/routes/track.ts` contains the atomic UPDATE with `sql\`NOW() - INTERVAL '60 seconds'\`` at line 112.
- [x] Commit `9fdab4e` (Task 1) found in git log.
- [x] Commit `c379b5c` (Task 2) found in git log.
- [x] Commit `51eed30` (Task 3) found in git log.
- [x] `npx tsc --noEmit -p tsconfig.server.json` passes with zero errors.
