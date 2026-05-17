---
phase: 06-index-foundation
plan: 01
subsystem: database
tags: [indexes, drizzle, postgresql, performance]
dependency_graph:
  requires: []
  provides: [IDX-01, IDX-06]
  affects: [all FK-lookup queries, pagination (Phase 07)]
tech-stack:
  added: []
  patterns: [drizzle-index-api, create-index-concurrently]
key_files:
  created:
    - sql/indexes.sql (rewritten with 48 CONCURRENTLY statements)
  modified:
    - src/db/schema.ts (46 index() definitions added)
decisions: []
metrics:
  duration: ~5 minutes
  completed: "2026-04-01"
  tasks_completed: 3
  files_modified: 2
---

# Phase 06 Plan 01: Foreign Key Indexes Summary

**One-liner:** Added 46 FK index definitions via Drizzle `index()` API in schema.ts and populated sql/indexes.sql with 48 matching `CREATE INDEX CONCURRENTLY` statements for zero-downtime index creation.

## What Was Done

### Task 1: FK Index Definitions in schema.ts
- `index` was already imported from `drizzle-orm/pg-core` (no import change needed)
- Added `index()` callbacks to **21 tables** that had no existing callbacks:
  - `track_domains`, `suppressions`, `statistics`, `email_accounts` (2 indexes), `lead_lists`, `leads` (2 indexes), `campaigns`, `sequences`, `sequence_steps`, `campaign_leads` (4 indexes), `outreach_emails` (5 indexes), `outreach_analytics` (3 indexes), `mailboxes`, `mail_folders` (2 indexes), `mail_messages` (2 indexes), `mail_filters`, `signatures`, `contacts`, `user_notifications`
- Added index entries alongside existing callbacks for **10 tables**:
  - `outlook_mailboxes`, `email_accounts`, `leads`, `campaign_leads`, `outreach_emails`, `outreach_analytics`, `sequence_steps`, `deliveries`, `webhook_requests`, `contacts`
- All existing `uniqueIndex` entries preserved — none removed
- **Total: 46 `index()` definitions** across all FK columns

### Task 2: CONCURRENTLY Statements in sql/indexes.sql
- Replaced placeholder content with **48 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`** statements
- Grouped by table with section comments (core tables, deliveries, webhooks, email accounts, leads, sequences, campaign leads, outreach emails, outreach analytics, mail module)
- Index names match schema.ts definitions exactly (source of truth)
- Nullable FK columns (outlookMailboxId, leadListId, assignedEmailAccountId, currentStepId, campaignId in outreach_analytics, emailAccountId in outreach_analytics) still indexed — NULL values excluded automatically

### Task 3: Verification
- TypeScript compilation: **PASSED** (no errors from schema.ts; pre-existing errors only in node_modules/drizzle-orm and unrelated frontend files)
- `npm run db:generate`: Interactive prompt about pre-existing contacts table rename question (unrelated to our changes; drizzle-kit v0.20.18 doesn't support non-interactive mode)
- `npm run lint`: ESLint config missing (pre-existing project issue, not related to our changes)

## Deviations from Plan

### Auto-fixed Issues

None — plan executed as written with one minor note:

**Note:** The plan stated `index` was NOT in the pg-core imports (line 1-12), but it was already present on line 11. No import change was needed. This is a documentation discrepancy in the plan, not a code issue.

## Verification Results

- ✅ `index` imported from `drizzle-orm/pg-core` (was already present)
- ✅ 46 FK `index()` definitions in schema.ts
- ✅ 48 `CREATE INDEX CONCURRENTLY` statements in sql/indexes.sql
- ✅ No existing `uniqueIndex` entries removed
- ✅ TypeScript compiles without schema.ts errors
- ⚠️ `db:generate` interactive prompt (pre-existing drizzle-kit behavior)
- ⚠️ `npm run lint` — no ESLint config (pre-existing)

## Commits

| Commit | Message |
|--------|---------|
| `8fa5006` | `feat(06-01): add FK index definitions to schema.ts` |
| `d31a039` | `feat(06-01): populate indexes.sql with CONCURRENTLY statements` |

## Self-Check: PASSED

- [x] `src/db/schema.ts` exists and contains 46 `index('idx_` calls
- [x] `sql/indexes.sql` exists and contains 48 `CREATE INDEX CONCURRENTLY` statements
- [x] Commit `8fa5006` exists
- [x] Commit `d31a039` exists
