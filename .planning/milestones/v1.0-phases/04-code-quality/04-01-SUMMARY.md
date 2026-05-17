---
phase: 04-code-quality
plan: "01"
subsystem: outreach
tags: [import-hygiene, typescript, code-quality]
dependency_graph:
  requires: []
  provides: [QUAL-01, QUAL-02, QUAL-03]
  affects: [src/pages/outreach/inboxes/NewInboxPage.tsx, src/pages/outreach/SequencesPage.tsx]
tech_stack:
  added: []
  patterns: [lib/api-client import consistency]
key_files:
  created: []
  modified:
    - src/pages/outreach/inboxes/NewInboxPage.tsx
    - src/pages/outreach/SequencesPage.tsx
    - .planning/REQUIREMENTS.md
decisions:
  - "QUAL-03 was pre-satisfied by Phase 1 — processOutreachSequences.ts had no sendEmail function at plan time"
metrics:
  duration: "5 minutes"
  completed: "2026-03-31"
  tasks: 2
  files: 3
---

# Phase 4 Plan 1: Import Hygiene and Code Quality Summary

**One-liner:** Fixed legacy lib/api import in NewInboxPage.tsx and removed unused Link import from SequencesPage.tsx, eliminating all TS6133 errors in outreach files.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Swap NewInboxPage.tsx import from lib/api to lib/api-client | a4a4eeb | src/pages/outreach/inboxes/NewInboxPage.tsx |
| 2 | Remove unused Link import from SequencesPage.tsx and verify QUAL-03 | 450ec59 | src/pages/outreach/SequencesPage.tsx, .planning/REQUIREMENTS.md |

## Verification Results

- `npx tsc --noEmit` produces zero TS6133 errors in any outreach file
- `NewInboxPage.tsx` line 14 contains `from '../../../lib/api-client'`
- `SequencesPage.tsx` wouter import is `import { useLocation } from 'wouter'`
- `processOutreachSequences.ts` confirmed to have no `sendEmail` function
- `REQUIREMENTS.md` has `[x]` for QUAL-01, QUAL-02, QUAL-03

## Deviations from Plan

None - plan executed exactly as written. QUAL-03 was confirmed pre-satisfied (Phase 1 already removed `sendEmail` from `processOutreachSequences.ts`).

## Known Stubs

None.
