---
phase: 02-reply-detection
plan: 01
status: complete
date: 2026-03-30
---

# Plan 02-01 Summary

## What was done
Migrated `processReplies.ts` from the legacy callback-based `imap` package to `imapflow`, matching the connection pattern of `processBounces.ts`. Removed the dead `connectImap` export and replaced `processAccountInbox` (Promise-wrapped callback IMAP) with `processAccountReplies` (async/await ImapFlow).

## Changes
- `src/server/jobs/processReplies.ts`: Replaced `processAccountInbox` (Promise-wrapped callback IMAP) with `processAccountReplies` (async/await ImapFlow). Removed `connectImap` export. Added `messageFlagsAdd(\\Seen)` after each matched reply.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Re-installed imap to preserve compilation for other files**
- **Found during:** Task 2 (uninstall imap)
- **Issue:** `src/server/lib/mail-sync.ts`, `src/server/routes/mail/mailboxes.ts`, `src/server/routes/mail/messages.ts`, and `src/server/routes/mail/send.ts` all import from `imap`. Uninstalling it broke TypeScript compilation across those 4 files.
- **Fix:** Re-installed `imap@^0.8.19` and `@types/imap@^0.8.43`. Those files are out of scope for this plan; migrating them is an architectural change tracked separately.
- **Result:** `package.json` is net-unchanged. `processReplies.ts` now uses ImapFlow only.

## Verification
All acceptance criteria passed: no `imap` imports in processReplies.ts, no `connectImap`, ImapFlow used with correct lock/flag pattern, TypeScript compiles cleanly.
