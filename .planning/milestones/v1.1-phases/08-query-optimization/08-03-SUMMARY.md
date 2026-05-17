---
phase: 08-query-optimization
plan: 03
subsystem: outreach-sequences
tags: [performance, n+1, drizzle, batch-queries]
dependency_graph:
  requires:
    - "Drizzle ORM with inArray, notInArray, sql helpers"
    - "suppressions table with organizationId + emailAddress columns"
    - "outreachEmails table with campaignLeadId + sequenceStepId columns"
  provides:
    - "Batch pre-loaded Sets for suppression and idempotency checks"
    - "Bounded pendingLeads query (limit 200)"
    - "Single-query markCompletedCampaigns with NOT EXISTS"
  affects:
    - "src/server/jobs/processOutreachSequences.ts"
tech_stack:
  added: []
  patterns:
    - "Batch pre-fetch + Set lookup (replacing per-row DB queries)"
    - "NOT EXISTS subquery for aggregate completion check"
    - "Configurable query limit for memory safety"
key_files:
  modified:
    - "src/server/jobs/processOutreachSequences.ts"
decisions:
  - summary: "PENDING_LEADS_LIMIT set to 200"
    rationale: "Balances throughput (processing 200 leads per cron tick) against memory safety. Can be adjusted based on observed performance."
  - summary: "Composite Set keys using colon separator (orgId:email, leadId:stepId)"
    rationale: "Simple, readable, avoids collision risk. Standard pattern for multi-dimensional Set lookups."
metrics:
  duration: "~3 minutes"
  completed: "2026-04-01"
---

# Phase 08 Plan 03: Fix N+1 in Outreach Sequence Processing — Summary

## One-Liner

Eliminated N+1 patterns in processOutreachSequences.ts by batch-loading suppressions and idempotency checks into in-memory Sets, adding a query limit, and replacing markCompletedCampaigns per-campaign loop with a single NOT EXISTS subquery.

## What Was Done

### Task 1: Batch-load suppressions and idempotency checks, add pendingLeads limit
**Commit:** `6cd7427`

- Added `PENDING_LEADS_LIMIT = 200` constant and `limit` to the pendingLeads query to prevent unbounded memory usage
- Batch-loaded all suppressed emails for involved organizations into a `Set<string>` keyed by `organizationId:emailAddress` — replaces per-lead `db.query.suppressions.findFirst` with O(1) `Set.has()` lookup
- Batch-loaded existing outreach emails into a `Set<string>` keyed by `campaignLeadId:sequenceStepId` — replaces per-lead `db.query.outreachEmails.findFirst` with O(1) `Set.has()` lookup
- Added `sql` to drizzle-orm import for Task 2

**Impact:** Reduces per-lead queries from 2 DB queries (suppression + idempotency) to 0 — all lookups are now in-memory Set operations. Total queries reduced from `2 + 2*N` to `4` (pendingLeads, campaigns, sequenceSteps, suppressions, outreachEmails).

### Task 2: Fix markCompletedCampaigns N+1
**Commit:** `66d4ec1` (co-committed with plan 08-01 due to parallel execution)

- Replaced the per-campaign loop (for each active campaign → query campaignLeads → conditional update) with a single `NOT EXISTS` subquery
- Uses Drizzle's `sql` template for the `NOT EXISTS` correlated subquery
- Batch-updates all completed campaigns in a single `UPDATE ... WHERE IN` statement

**Impact:** Reduces markCompletedCampaigns from `1 + 2*N` queries (1 for campaigns, then per-campaign: 1 select + 1 update) to exactly 2 queries (1 SELECT with subquery, 1 UPDATE with inArray).

## Deviations from Plan

None — plan executed exactly as written.

## Verification

### Acceptance Criteria (Task 1)
| Check | Result |
|-------|--------|
| `PENDING_LEADS_LIMIT` appears ≥2 times | ✅ 2 (declaration + usage) |
| `suppressedSet` appears ≥2 times | ✅ 2 (creation + usage) |
| `existingEmailsSet` appears ≥2 times | ✅ 2 (creation + usage) |
| `db.query.suppressions.findFirst` removed | ✅ 0 occurrences |
| `db.query.outreachEmails.findFirst` removed | ✅ 0 occurrences |
| `inArray(suppressions.organizationId` exists | ✅ 1 occurrence |

### Acceptance Criteria (Task 2)
| Check | Result |
|-------|--------|
| `NOT EXISTS` subquery present | ✅ |
| Per-campaign `for` loop removed | ✅ 0 occurrences |
| `db.query.campaignLeads.findMany` only pendingLeads | ✅ 1 occurrence |

### Build Verification
- `npm run build` — ✅ Passed (client + server both compiled successfully)

## Known Stubs

None — all data flows are wired to actual database queries.

## Self-Check: PASSED

- [x] src/server/jobs/processOutreachSequences.ts exists and contains all changes
- [x] Commit 6cd7427 exists (Task 1)
- [x] Commit 66d4ec1 exists (Task 2 changes included)
- [x] Build passes without TypeScript errors
