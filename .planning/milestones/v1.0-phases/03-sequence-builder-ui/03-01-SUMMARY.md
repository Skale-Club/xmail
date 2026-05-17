---
phase: 03-sequence-builder-ui
plan: "01"
subsystem: frontend
tags: [outreach, sequences, ui, react-query, routing]
dependency_graph:
  requires: []
  provides: [NewSequencePage wired save handler, /outreach/campaigns/:id/sequences/new route]
  affects: [src/main.tsx, src/pages/outreach/sequences/NewSequencePage.tsx]
tech_stack:
  added: []
  patterns: [useMutation with apiFetch/apiRequest, useParams for route param extraction]
key_files:
  created: []
  modified:
    - src/pages/outreach/sequences/NewSequencePage.tsx
    - src/main.tsx
decisions:
  - "Import path for api-client corrected to ../../../lib/api-client (plan spec had wrong depth ../../lib/api-client)"
  - "back-link changed from <Link href=...> to <a href=...> to avoid importing unused Link from wouter"
metrics:
  duration_seconds: 418
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 2
requirements: [SEQ-01, SEQ-02, SEQ-03, SEQ-04, SEQ-05]
---

# Phase 03 Plan 01: Wire NewSequencePage Save Handler Summary

**One-liner:** NewSequencePage wired to real API via useMutation with corrected field names (delayHours, htmlBody), campaignId from useParams, and proper main.tsx route added before /outreach/campaigns.

## What Was Built

Completed two focused changes that make the sequence builder UI actually persist data to the database:

1. **NewSequencePage.tsx fully rewritten** — removed the console.log stub and replaced it with a `useMutation` that:
   - POSTs to `/api/outreach/campaigns/${campaignId}/sequences` via `apiFetch`
   - Loops over steps and POSTs each to `/api/outreach/campaigns/sequences/${sequenceId}/steps` via `apiRequest`
   - Reads `campaignId` from `useParams<{ id: string }>()` with a guard that shows a toast if the value is missing
   - Navigates to `/outreach/sequences` on success with a `variant: 'success'` toast
   - Fixed Step interface: `delayDays` → `delayHours`, `bodyHtml` → `htmlBody` (matching Zod schema)
   - Removed unused imports (`Link`, `Plus`) and replaced `isSaving` state with `createMutation.isPending`

2. **main.tsx updated** — added lazy import for `NewSequencePage`, inserted route `/outreach/campaigns/:id/sequences/new` immediately BEFORE the `/outreach/campaigns` route (required for wouter first-match-wins semantics), and removed the dead `/outreach/sequences/new` route that was incorrectly rendering `SequencesPage`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wire NewSequencePage save handler | 063943a | src/pages/outreach/sequences/NewSequencePage.tsx |
| 2 | Add route in main.tsx + fix import path | 5c59e59 | src/main.tsx, src/pages/outreach/sequences/NewSequencePage.tsx |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Wrong api-client import depth in NewSequencePage**
- **Found during:** Task 2 (build verification)
- **Issue:** Plan specified `../../lib/api-client` but the file lives at `src/pages/outreach/sequences/NewSequencePage.tsx` — three directories deep from `src/`, so the correct relative path is `../../../lib/api-client`
- **Fix:** Updated import to `../../../lib/api-client`
- **Files modified:** `src/pages/outreach/sequences/NewSequencePage.tsx`
- **Commit:** 5c59e59

**2. [Rule 1 - Bug] Link component replaced with anchor tag**
- **Found during:** Task 1
- **Issue:** Plan said to remove unused `Link` import but the JSX back-link used `<Link href=...>`. Changed to `<a href=...>` to remove the wouter `Link` dependency entirely while preserving navigation behavior.
- **Fix:** Replaced `<Link href="/outreach/sequences">` with `<a href="/outreach/sequences">`
- **Files modified:** `src/pages/outreach/sequences/NewSequencePage.tsx`
- **Commit:** 063943a

### Pre-existing Issues (Out of Scope)

- `npm run lint` fails with "ESLint couldn't find a configuration file" — no `.eslintrc` file exists anywhere in the project tree. This is a pre-existing condition that predates this plan (confirmed by reverting to prior commit — same failure). Logged for awareness; not fixed as it is out of scope.

## Known Stubs

None — both the sequence creation API call and the steps loop are fully wired to real endpoints.

## Verification Results

All plan-specified acceptance criteria met:

- `delayDays`, `bodyHtml`, `console.log`, `isSaving`, `Plus` — not present in NewSequencePage.tsx
- `useParams`, `useMutation`, `apiFetch`, `apiRequest`, `delayHours`, `htmlBody`, `campaignId`, `setLocation('/outreach/sequences')`, `hours` label — all present in NewSequencePage.tsx
- `const NewSequencePage = React.lazy(...)` — present in main.tsx at line 36
- Route `/outreach/campaigns/:id/sequences/new` — present at line 398, before `/outreach/campaigns` at line 405
- Dead route `/outreach/sequences/new` — removed
- TypeScript build (`npm run build`) — passes with no errors

## Self-Check: PASSED
