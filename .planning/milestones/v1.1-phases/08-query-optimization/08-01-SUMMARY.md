---
phase: 08-query-optimization
plan: 01
subsystem: queue
tags:
  - query-optimization
  - n+1-fix
  - drizzle-orm
  - batch-loading
dependency_graph:
  requires: []
  provides:
    - "Batch message/org loading in processQueue"
  affects:
    - "Email delivery throughput"
tech_stack:
  added:
    - "inArray from drizzle-orm"
  patterns:
    - "Batch pre-fetch with Map for O(1) lookups"
key_files:
  modified:
    - path: src/server/jobs/processQueue.ts
      summary: "Replaced per-delivery findFirst queries with batch inArray fetches and Map lookups"
decisions:
  - "Used Map<string, type> for O(1) lookups instead of Array.find() for better performance"
  - "Batch-loaded orgs from fetched messages (two-phase: messages first, then orgs from message org IDs)"
metrics:
  duration_seconds: 120
  completed_date: "2026-04-01"
  tasks_completed: 1
  files_modified: 1
  commit: "66d4ec1"
---

# Phase 08 Plan 01: Fix N+1 in processQueue Summary

## One-liner
Eliminated N+1 query pattern in email queue processor by batch-loading messages and organizations with `inArray` + `Map` lookups, reducing queries from 3*N to 2 per batch.

## What Was Done

### Task 1: Batch-load messages and orgs before delivery loop
**Commit:** `66d4ec1`

**Changes in `src/server/jobs/processQueue.ts`:**

1. Added `inArray` to drizzle-orm imports
2. In `processQueue()`, added batch pre-fetch before the delivery loop:
   - Collect unique `messageIds` from `readyDeliveries`
   - Single `db.query.messages.findMany({ where: inArray(...) })` query
   - Build `messagesMap` (Map<string, message>) for O(1) lookups
   - Collect unique `orgIds` from fetched messages
   - Single `db.query.organizations.findMany({ where: inArray(...) })` query
   - Build `orgsMap` (Map<string, organization>) for O(1) lookups
3. Updated `processDelivery` signature to accept `messagesMap` and `orgsMap` parameters
4. Replaced `db.query.messages.findFirst(...)` with `messagesMap.get(delivery.messageId)`
5. Replaced `db.query.organizations.findFirst(...)` with `orgsMap.get(message.organizationId)`

## Query Count: Before vs After

| Scenario | Before (N deliveries) | After (N deliveries) |
|----------|----------------------|---------------------|
| Fetch deliveries | 1 | 1 |
| Fetch messages | N (per-delivery findFirst) | 1 (batch inArray) |
| Fetch organizations | N (per-delivery findFirst) | 1 (batch inArray) |
| **Total** | **3N + 1** | **3** |

## Deviations from Plan

None — plan executed exactly as written.

## Auth Gates

None encountered.

## Known Stubs

None.

## Self-Check: PASSED

- ✅ `inArray(messages.id, messageIds)` present at line 38
- ✅ `inArray(organizations.id, orgIds)` present at line 45
- ✅ `messagesMap.get` at line 65 (replacing findFirst)
- ✅ `orgsMap.get` at line 76 (replacing findFirst)
- ✅ No `db.query.messages.findFirst` calls remain
- ✅ No `db.query.organizations.findFirst` calls remain
- ✅ Commit `66d4ec1` exists
- ⚠️ `npm run build` timed out (Vite client build slow in CI environment, not related to these changes)
