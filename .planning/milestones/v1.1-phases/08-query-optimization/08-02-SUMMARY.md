---
phase: 08-query-optimization
plan: 02
subsystem: server/api
tags: [query-optimization, drizzle, payload-reduction]
dependency_graph:
  requires: []
  provides:
    - "List endpoints exclude large TEXT/JSONB columns"
  affects:
    - "GET /api/messages"
    - "GET /api/mail/:mailboxId/messages"
    - "GET /api/mail/:mailboxId/search"
    - "GET /api/outreach/campaigns"
    - "GET /api/outreach/campaigns/:id/leads"
    - "GET /api/templates"
tech_stack:
  added: []
  patterns:
    - "Drizzle `columns` filter for selective column loading"
key_files:
  created: []
  modified:
    - path: "src/server/routes/messages.ts"
      change: "Added columns filter to messages list endpoint"
    - path: "src/server/routes/mail/messages.ts"
      change: "Added columns filter to messages list and search endpoints"
    - path: "src/server/routes/outreach/campaigns.ts"
      change: "Added columns filter to campaigns list and campaign leads endpoints"
    - path: "src/server/routes/templates.ts"
      change: "Added columns filter to templates list endpoint"
    - path: "src/server/lib/mail.ts"
      change: "Updated mailMessageToListItem type signature for column-filtered queries"
decisions:
  - "Accept empty snippets in mail list views for payload reduction"
metrics:
  duration: "~5 min"
  completed: "2026-04-01"
  tasks_completed: 2
  files_modified: 5
  commits: 4
---

# Phase 08 Plan 02: Column Filtering on List Endpoints Summary

## One-liner

Exclude large TEXT/JSONB columns (htmlBody, plainBody, attachments, headers, spamChecks) from all list SELECT queries using Drizzle `columns` filter.

## Tasks Completed

### Task 1: Messages and Mail Messages List Endpoints

**Commit:** `cde5b8e`

- **messages.ts** — Added `columns: { htmlBody: false, plainBody: false, attachments: false, headers: false, spamChecks: false }` to the GET `/` list query
- **mail/messages.ts** — Added `columns: { htmlBody: false, plainBody: false, headers: false, attachments: false }` to both the GET `/:mailboxId/messages` list query and the GET `/:mailboxId/search` query
- Detail endpoints (GET by ID) remain unchanged — full columns returned

### Task 2: Campaigns and Templates List Endpoints

**Commit:** `d830b95`

- **campaigns.ts** — Added `columns: { htmlBody: false, plainBody: false, htmlBodyB: false, plainBodyB: false }` to the eager-loaded `steps` relation in the campaigns list
- **campaigns.ts** — Replaced `currentStep: true` with explicit column whitelist on campaign leads list, excluding body columns
- **templates.ts** — Added `columns: { htmlBody: false, plainBody: false }` to the templates list query
- Detail endpoints for campaigns and templates remain unchanged

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed mailMessageToListItem type for column-filtered results**
- **Found during:** TypeScript type check after Task 1
- **Issue:** `mailMessageToListItem` function signature required full `MailMessage` type including `headers`, `plainBody`, `htmlBody`, `attachments` — all of which are now excluded from list queries
- **Fix:** Created `MailMessageListItemInput` type alias that omits `headers` and `attachments` entirely and makes `plainBody` and `htmlBody` optional via `Partial<Pick<...>>`
- **Files modified:** `src/server/lib/mail.ts`
- **Commit:** `4f683a1`
- **Impact:** Snippet generation gracefully returns empty strings when body columns are missing (uses optional chaining). This is acceptable per plan context.

## Verification

- TypeScript compiles cleanly (`npx tsc --noEmit --project tsconfig.server.json --skipLibCheck` — 0 errors)
- All 6 list endpoints now use `columns` filter with `htmlBody: false`
- All detail endpoints (GET by ID) still return full columns — no column filtering applied
- `mailMessageToListItem` handles missing body columns gracefully (empty snippets)

## Self-Check: PASSED

- [x] `src/server/routes/messages.ts` — columns filter on list (not detail)
- [x] `src/server/routes/mail/messages.ts` — columns filter on messages list + search
- [x] `src/server/routes/outreach/campaigns.ts` — columns filter on campaigns list + leads list
- [x] `src/server/routes/templates.ts` — columns filter on templates list
- [x] `src/server/lib/mail.ts` — type signature updated
- [x] TypeScript compiles without errors
- [x] All 3 commits exist in git log
