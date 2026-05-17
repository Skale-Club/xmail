---
phase: 02-reply-detection
created: 2026-03-30
status: ready
---

# Phase 2 Context: Reply Detection

## Phase Goal

Migrate `processReplies.ts` from the legacy `imap` package to `imapflow`, matching the connection pattern of `processBounces.ts`, and remove the `imap` dependency.

## Decisions

### Message marking after reply detection
**Decision:** Flag processed messages as `\Seen` after a reply is detected and recorded.

**Rationale:** Matches `processBounces.ts` behavior exactly. Makes the job idempotent — on the next cron tick, already-processed messages are skipped at the IMAP level rather than re-fetched and deduped at the DB level. This is the correct pattern.

**Implementation note:** Use `client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })` inside a try/catch that ignores flag errors — same as `processBounces.ts` line 380.

### Connection pattern
**Decision:** Use the exact `processBounces.ts` connection pattern:
```
connect() → getMailboxLock('INBOX') → search → fetch → lock.release() in finally → logout() in finally
```
No deviation from this pattern is permitted.

### Search strategy
**Decision:** Search for `UNSEEN` messages (`{ seen: false }` in imapflow). Mark each processed reply message `\Seen` after handling. This combination is idempotent.

### Header fetch (efficiency)
**Decision:** Fetch headers only — `In-Reply-To` and `References` — not full message source. Reply detection only needs these two headers; fetching full source is wasteful. Use imapflow's `headers: ['in-reply-to', 'references']` in the fetch options.

### Dead export removal
**Decision:** Remove the exported `connectImap` function from `processReplies.ts`. It is unused across the codebase (grep confirms no imports). Removing it avoids confusion with the imapflow-based client.

### `imap` package removal
**Decision:** After migration, remove `imap` and `@types/imap` from `package.json` (REPLY-03). Run `npm uninstall imap @types/imap`.

### Business logic preservation
**Decision:** Keep ALL existing business logic unchanged:
- `findOutreachEmailByMessageId` (exported — may be used elsewhere)
- `markAsReplied` (exported — used or tested elsewhere)
- `extractFirstReference` (internal helper)
- The In-Reply-To → References fallback logic

Only the IMAP transport layer changes. The matching and recording logic stays identical.

## Canonical Refs

- `src/server/jobs/processReplies.ts` — file being migrated
- `src/server/jobs/processBounces.ts` — reference implementation (connection pattern, flag pattern)
- `src/server/jobs/index.ts` — confirms processReplies is imported and scheduled
- `.planning/REQUIREMENTS.md` — REPLY-01, REPLY-02, REPLY-03

## Out of Scope

- Outlook reply detection (explicitly excluded in REQUIREMENTS.md)
- Reply content parsing or body storage
- Threading / conversation grouping
- Any changes to `markAsReplied` business logic
