---
phase: 14-outreach-p0-fixes
plan: 03
subsystem: schema/db
tags: [schema, migrations, drizzle, cascade-fk, tracking-token, suppressions]
requirements_satisfied:
  - P0-10
  - P0-02 (prereq only — full fix in 14-05)
  - P0-03 (prereq only — full fix in 14-04 unsubscribe)
  - P0-07 (prereq only — full fix in 14-06)
dependency_graph:
  requires: []
  provides:
    - "cascade FKs so DELETE FROM campaigns succeeds (Plan 14-04 cleanup, deployer DELETE in Postal-style UI)"
    - "outreach_emails.tracking_token UNIQUE column for Plan 14-05 HMAC token lookup"
    - "suppressions.source column for Plan 14-06 bounce/unsubscribe provenance"
    - "Drizzle types mirror the new shape so 14-04/14-05/14-06 can use them"
  affects:
    - "Plan 14-05 must replace the placeholder trackingToken in recordOutreachEmail"
    - "Plan 14-06 must write to suppressions.source on bounce/unsubscribe"
tech_stack:
  added: []
  patterns:
    - "raw SQL migrations in supabase/migrations/NNN_name.sql with Drizzle schema.ts as mirror"
    - "idempotent migrations via DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT pairs covering both naming conventions (`*_fkey` and `*_<target>_<col>_fk`)"
    - "backfill before NOT NULL: ADD COLUMN nullable → UPDATE → ALTER COLUMN SET NOT NULL → CREATE UNIQUE INDEX"
key_files:
  created:
    - supabase/migrations/020_outreach_p0_fixes.sql
  modified:
    - src/db/schema.ts
    - src/server/lib/outreach-sender.ts
decisions:
  - "Placeholder trackingToken concatenates campaignLeadId AND sequenceStepId (not campaignLeadId alone) so step 2 of any multi-step sequence does not collide with step 1 on the UNIQUE index"
  - "CHECK constraint for suppressions.source lives in SQL only, not in Drizzle check() — defense against duplicate DDL if anyone runs db:push"
  - "ON DELETE SET NULL (not CASCADE) on campaign_leads.current_step_id — deleting a step should not orphan-delete the lead from the campaign; processor recovers"
  - "FKs on outreach_emails.email_account_id / campaign_leads.assigned_email_account_id / outreach_emails.organization_id intentionally NOT cascaded — deleting an inbox/org should not silently delete sent-email history"
metrics:
  duration_seconds: 219
  duration_human: "~4 minutes"
  tasks_completed: 3
  files_touched: 3
  commits: 3
  completed_at: "2026-05-17T04:18:15Z"
---

# Phase 14 Plan 03: Schema/DDL bundle for outreach P0 fixes — Summary

One migration + Drizzle mirror + one-line build bridge lands all schema groundwork for Phase 14 in Wave 1, unblocking Waves 2 and 3 to ship behavior without waiting on DDL.

## What was built

### 1. `supabase/migrations/020_outreach_p0_fixes.sql` (new, 106 lines)

Three independent sections wrapped in a single `BEGIN; ... COMMIT;` block, each idempotent.

**Section 1 — Cascade FKs for campaign deletion (P0-10):**

| Table | Column | Action |
|---|---|---|
| `sequences` | `campaign_id` | `ON DELETE CASCADE` |
| `sequence_steps` | `sequence_id` | `ON DELETE CASCADE` |
| `campaign_leads` | `campaign_id` | `ON DELETE CASCADE` |
| `campaign_leads` | `lead_id` | `ON DELETE CASCADE` |
| `campaign_leads` | `current_step_id` | `ON DELETE SET NULL` |
| `outreach_emails` | `campaign_id` | `ON DELETE CASCADE` |
| `outreach_emails` | `campaign_lead_id` | `ON DELETE CASCADE` |
| `outreach_emails` | `sequence_step_id` | `ON DELETE CASCADE` |

Each FK drop is doubled (`*_fkey` and `*_<target>_<col>_fk` variants) so the migration is robust to whichever Postgres / Drizzle generation created the original constraint.

**Section 2 — `outreach_emails.tracking_token` (P0-02 prereq):**
- `ADD COLUMN IF NOT EXISTS tracking_token text;`
- Backfill: `UPDATE outreach_emails SET tracking_token = id::text WHERE tracking_token IS NULL;`
- `ALTER COLUMN tracking_token SET NOT NULL;`
- `CREATE UNIQUE INDEX IF NOT EXISTS outreach_emails_tracking_token_unique ON outreach_emails(tracking_token);`

**Section 3 — `suppressions.source` (P0-07 prereq):**
- `ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';`
- `CHECK (source IN ('bounce', 'complaint', 'unsubscribe', 'manual'))`

### 2. `src/db/schema.ts` (modified, +14 / -9)

Mirrors every change from migration 020:
- 7 FKs annotated with `{ onDelete: 'cascade' }` (matches the 7 cascade entries in the migration)
- 1 FK annotated with `{ onDelete: 'set null' }` (`currentStepId`)
- New `outreachEmails.trackingToken: text('tracking_token').notNull()` column inserted between `messageId` and `subject`
- New `trackingTokenUnique: uniqueIndex('outreach_emails_tracking_token_unique').on(table.trackingToken)` in the table options
- New `suppressions.source: text('source').notNull().default('manual')` column with inline comment listing allowed values

CHECK constraint deliberately omitted from Drizzle — lives only in the SQL migration to avoid duplicate DDL if someone runs `db:push`.

`relations()` block untouched (Drizzle relations API does not consume `onDelete` hints).

### 3. `src/server/lib/outreach-sender.ts` (modified, +2)

Inside `recordOutreachEmail`, added a single line to satisfy the new `NOT NULL` constraint until Plan 14-05 lands the real HMAC token:

```ts
// TEMP: placeholder token until Plan 14-05 replaces with HMAC (concatenated to satisfy UNIQUE)
trackingToken: `${params.campaignLeadId}:${params.sequenceStepId}`,
```

The `:` concatenation is **load-bearing**: a campaign with a 3-step sequence would otherwise insert the same `campaignLeadId` three times and blow up on the UNIQUE constraint at step 2. Concatenating with `sequenceStepId` matches the natural granularity of an `outreach_emails` row (which already has a `(campaignLeadId, sequenceStepId)` unique index).

## Deviations from Plan

None — plan executed exactly as written. The plan's CRITICAL-1 fix (template literal concatenating both UUIDs) was followed verbatim.

## Commits

| # | Hash | Message |
|---|---|---|
| 1 | `b2f43ce` | feat(14-03): add migration 020_outreach_p0_fixes.sql |
| 2 | `528d6f5` | feat(14-03): mirror migration 020 in Drizzle schema |
| 3 | `54c6b0f` | feat(14-03): add placeholder trackingToken to recordOutreachEmail |

## Verification

- `node` script asserting BEGIN/COMMIT, cascade count ≥ 7, unique index, suppressions check — **PASS**
- Grep counts on `src/db/schema.ts`: 7 cascade, 1 set null, 1 trackingToken, 1 unique index, 1 suppressions.source — **PASS**
- Grep on `src/server/lib/outreach-sender.ts` for placeholder + TEMP marker — **PASS**
- `npm run build` — **EXIT 0** (Vite + tsc -p tsconfig.server.json)

## Contracts published for later plans

**Plan 14-05 (P0-02 HMAC token):**
- Grep for `TEMP: placeholder token` in `src/server/lib/outreach-sender.ts` to find the placeholder line
- Replace with the real `generateOutreachToken(campaignLeadId, secret)` call from the new `src/server/lib/outreach-tokens.ts` module
- The replacement must keep the field as a string (no schema change needed; column already `text`)
- Will likely also extend `track.ts` to look up `outreach_emails.tracking_token` (column is in place + indexed)

**Plan 14-06 (P0-07 suppression on bounce / unsubscribe):**
- `INSERT INTO suppressions (..., source) VALUES (..., 'bounce' | 'unsubscribe' | 'complaint')` — column exists with CHECK
- The CHECK rejects any other value at the DB layer; insert code should pass exactly one of the four enum values

**Plan 14-04 (P0-04 middleware + cleanup):**
- Can safely call `db.delete(campaigns).where(eq(campaigns.id, id))` — all downstream rows cascade-delete

## Operator follow-up (out of scope for this plan)

Before deploying Plan 14-05 or 14-06 code to production, the operator must run migration 020 on the production Supabase. Project uses raw SQL migrations applied manually (per `.planning/STATE.md` "Supabase migration history drift" blocker — `npm run db:push` is NOT used for production). Suggested command:

```bash
psql "$DATABASE_URL" -f supabase/migrations/020_outreach_p0_fixes.sql
```

The migration is idempotent and transactional — safe to re-run if anything errors mid-flight.

## Known Stubs

One intentional, plan-documented stub:

| File | Line | Stub | Resolved by |
|---|---|---|---|
| `src/server/lib/outreach-sender.ts` | 209 | `trackingToken: \`${params.campaignLeadId}:${params.sequenceStepId}\`` placeholder | Plan 14-05 (replaces with HMAC-signed token) |

This stub is **not blocking** — emails still send, tracking pixel still injects with `campaignLeadId`, the only thing missing is the new HMAC verification path which lands in 14-05.

## Self-Check: PASSED

Files verified to exist:
- FOUND: supabase/migrations/020_outreach_p0_fixes.sql
- FOUND: src/db/schema.ts (modified)
- FOUND: src/server/lib/outreach-sender.ts (modified)

Commits verified in git log:
- FOUND: b2f43ce
- FOUND: 528d6f5
- FOUND: 54c6b0f
