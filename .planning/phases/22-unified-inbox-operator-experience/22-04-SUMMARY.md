---
phase: 22-unified-inbox-operator-experience
plan: 04
subsystem: fullstack
tags: [outreach, unified-inbox, reply, reply-all, forward, threading-headers, durable-command, policy-gate, attachments, supabase-storage, snippets, scheduling, tdd]

# Dependency graph
requires:
  - phase: 22-unified-inbox-operator-experience (plan 01)
    provides: "inbox_send_commands + inbox_attachments model, executeInboxSendCommand executor, processInboxCommands claimer, migration 042 + private bucket"
  - phase: 22-unified-inbox-operator-experience (plan 02/03)
    provides: "Prop-driven workspace (ConversationThread/List), org-scoped inboxKeys + optimistic hooks + validated URL state"
  - phase: 21-unified-inbox-foundation
    provides: "outreach_conversation_messages (normalized recipients/headers) + read API"
  - phase: 19-provider-parity-and-deliverability
    provides: "createThreadedDispatchProvider + composeOutreachMime (attachments + cc/bcc via one raw MIME buffer)"
  - phase: 18-outreach-safety-and-execution-reliability
    provides: "dispatchOutreachMessage + shared delivery-policy gate + lease/idempotency"
provides:
  - "resolveSendCommand — pure server-side reply/reply-all/forward recipient + RFC threading-header resolution from persisted messages (client cannot spoof)"
  - "createResolvedSendCommand — durable command hand-off with NO dispatch capability (route never sends inline)"
  - "executeInboxSendCommand extended: reply-all cc/bcc fan-out (suppression-filtered) + org-owned attachment streaming through the shared policy-gated dispatcher"
  - "src/server/lib/inbox-attachments.ts — bounded, private-bucket, non-base64 attachment lifecycle (validate/upload/assert-owned/load/download/delete/cleanup)"
  - "unified-inbox.ts: server-resolving send-command route + authenticated raw-body attachment upload/download/delete routes"
  - "ConversationComposer + useInboxComposer/useInboxSnippets — reply/reply-all/forward editor with snippets, attachments, durable schedule, and recoverable policy-denial UX"
affects: [22-05, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Recipients + In-Reply-To/References are RESOLVED SERVER-SIDE from persisted outreach_conversation_messages; the route schema has no reply-mode To/Cc/In-Reply-To/References field, so a client cannot inject or spoof them"
    - "Every immediate OR scheduled send is a durable inbox_send_commands row; the create path (createResolvedSendCommand) has NO dispatch dependency and the sole dispatcher stays executeInboxSendCommand behind the shared delivery-policy gate"
    - "Reply-all Cc/Bcc are fanned out into the composed MIME but first filtered through the org suppression list (exact + @domain sentinel), so a reply respects suppression like campaign mail — the primary To is always policy-gated by the dispatcher"
    - "Attachments are bounded metadata + bytes in one PRIVATE Supabase Storage bucket under a SERVER-CHOSEN path; the server measures ACTUAL bytes (a client cannot under-declare a size) and never accepts base64-in-JSON; the executor loads ready, org-owned bytes at dispatch time and a retry re-loads (no bytes frozen in the row)"
    - "Policy denial preserves the draft: the executor reschedules (status back to scheduled, body untouched, lastPolicyCode recorded); the composer never clears the body on failure and shows the recoverable reason + Cancel"

key-files:
  created:
    - src/server/lib/inbox-attachments.ts
    - src/components/outreach/inbox/ConversationComposer.tsx
    - src/server/lib/inbox-command-dispatch.test.ts
  modified:
    - src/server/lib/inbox-command-dispatch.ts
    - src/server/lib/inbox-operator.ts
    - src/server/lib/outreach-dispatch.ts
    - src/server/lib/outreach-dispatch-provider.ts
    - src/server/lib/outreach-sender.ts
    - src/server/routes/outreach/unified-inbox.ts
    - src/server/jobs/processInboxCommands.ts
    - src/lib/unified-inbox-api.ts
    - src/hooks/useUnifiedInbox.ts
    - src/components/outreach/inbox/ConversationThread.tsx
    - src/pages/outreach/UnifiedInboxPage.tsx
    - src/pages/outreach/__tests__/UnifiedInboxPage.test.tsx
    - src/server/routes/outreach/__tests__/inbox-operator.db.test.ts

key-decisions:
  - "The pure resolver (resolveSendCommand) chooses the source message (latest inbound for reply, sourceMessageId if in-thread, latest for forward), derives To from Reply-To -> From -> our-own-To (excluding self, deduped case-insensitively), builds In-Reply-To/References from the persisted parent id + chain (bounded to 20 ids / 8000 chars), and Re:/Fwd:-derives the subject — forward requires explicit recipients and starts a NEW thread (no In-Reply-To)."
  - "createResolvedSendCommand is injectable (loadConversation/loadAccountAddress/loadThreadMessages/validateAttachments/persistCommand) and has NO dispatch seam, so 'the route never sends inline' is structural, not incidental — proven by a test asserting `'dispatch' in deps === false`."
  - "Attachment transport honors locked #7's security intent (authenticated fetchWithAuth path, server-validated count/size/mime/extension/ownership, private bucket, non-base64) via an authenticated RAW-body upload (express.raw) rather than multipart/form-data, because no multipart parser (multer/busboy) is installed and adding one to express-5-beta is a needless risk; the byte stream is bounded by express.raw and stored server-side under a server-chosen path."
  - "Attachments/cc/bcc ride the LIVE dispatch input (not the frozen outreach_emails payload), so the executor re-resolves them from the durable command each attempt; composeOutreachMime already emits attachments + cc/bcc into the single raw MIME buffer every provider transmits, so no provider adapter changed."
  - "The composer is prop-driven (matching 22-02/22-03): the page owns useInboxComposer (create + poll + cancel + upload) and passes handlers, so the composer is unit-testable without a QueryClient."

patterns-established:
  - "A durable-command status DTO now carries lastPolicyCode/lastError so the UI can render a recoverable delivery-policy denial (paused org, suppressed, daily limit, warm-up, spacing, unhealthy account) with the safe next step."
  - "A .db route test that exercises reply resolution must seed the persisted inbound sender (from_address); the route no longer trusts client recipients/headers."

requirements-completed: [UIX-03, UIX-05]

# Metrics
duration: 34min
completed: 2026-07-16
---

# Phase 22 Plan 04: Unified Inbox Reply Composer + Attachments Summary

**Reply / reply-all / forward now work across the workspace as DURABLE commands whose recipients and RFC threading headers are resolved and validated SERVER-SIDE from the persisted thread (a client cannot inject or spoof them), every immediate or scheduled send flows through the single Phase-18 policy-gated executor, attachments are bounded, organization-owned, private-bucket, non-base64 bytes, and a policy denial preserves the operator's draft with a recoverable reason — 674/674 tests green (+40).**

## Provider matrix

Sends reuse the Phase 19 shared path (`createThreadedDispatchProvider` → `sendThreadedReply` → `composeOutreachMime`), which composes ONE raw MIME buffer transmitted byte-identically by every provider. Reply/reply-all/forward therefore work on every provider Phase 19 marks supported:

| Provider | Reply/Reply-all/Forward | Cc/Bcc + attachments | Notes |
| --- | --- | --- | --- |
| `native` | ✅ via shared dispatcher | ✅ (raw MIME relayed) | Sent copy filed with the composed headers |
| `smtp` (IMAP/SMTP) | ✅ via shared dispatcher | ✅ (raw + explicit envelope) | Bcc carried in the envelope, not the header |
| `outlook` (Graph) | ✅ via shared dispatcher | Cc ✅ / Bcc refused | Graph MIME already refuses Bcc (would disclose or silently drop) |

Manual provider smoke sends were NOT run here (no production credentials in this environment); the send path is the same policy-gated dispatcher Phases 18–21 verified, and is exercised end-to-end by the DB test (a real leased command → executor → dispatcher stub).

## How recipients + threading headers are resolved/validated server-side (anti-spoof)

`resolveSendCommand` (pure, in `inbox-command-dispatch.ts`) takes ONLY the mode, the sending account address, the persisted `outreach_conversation_messages`, and (forward-only) the operator's explicit recipients. It:

- picks the source message (latest inbound for reply/reply-all, `sourceMessageId` only if it is in the thread, latest for forward — a source id not in the persisted thread throws);
- derives **To** from the source's Reply-To → From → (replying to our own outbound) original To, always excluding the sending account and de-duplicating case-insensitively;
- derives **reply-all Cc** as the union of the source's To+Cc minus self minus the primary To;
- builds **In-Reply-To** = the source's persisted `internet_message_id` and **References** = the persisted chain + parent (bounded to 20 ids / 8000 chars);
- **forward** requires explicit recipients and starts a new thread (no In-Reply-To/References).

The route schema (`sendCommandSchema`) has **no** reply-mode `to`/`cc`/`inReplyTo`/`references` field — the only recipients a client can name are `forwardTo`/`forwardCc`, still validated as emails. Spoofing is structurally impossible.

**Tests that prove it:** `resolveSendCommand` unit tests (reply/reply-all/forward, Reply-To precedence, self-exclusion, dedupe, subject de-prefixing, missing headers, cross-tenant/non-thread source id, self-only reply rejected); `createResolvedSendCommand` tests (recipients + headers come from `loadThreadMessages`, not the caller); and a DB test asserting the STORED command's `to_recipients`/`in_reply_to`/`subject` were server-resolved from the seeded inbound sender.

## How every send becomes a durable command through one policy-gated executor

`POST /conversations/:id/send-commands` calls `createResolvedSendCommand`, which resolves the thread and persists an `inbox_send_commands` row. That create path has **no dispatch dependency** (proven by a test asserting `'dispatch' in deps === false`); a route can only hand off a durable command. The advisory-locked `processInboxCommands` claimer later leases the row and calls `executeInboxSendCommand` — the SOLE inbox caller of `dispatchOutreachMessage` — which evaluates the shared delivery policy and performs the one low-level dispatch. Immediate and scheduled sends are the same durable row (immediate = `due_at now`, scheduled = `due_at future`); no browser timers (locked #6). At-most-once survives restarts via the command's stable idempotency key.

## How attachments stay bounded / owned / non-base64

`inbox-attachments.ts` is the whole lifecycle:

- **Bounded (pure, unit-tested):** ≤10 per command, ≤25 MiB per file, ≤25 MiB aggregate, MIME/extension allow-list (active-content types like html/svg rejected), and a strict `[A-Za-z0-9._-]` filename allow-list so no path traversal survives.
- **Actual-vs-declared:** upload measures the RECEIVED bytes as the size of record — a client cannot under-declare a size to slip past the ceiling; oversize is rejected **before** any storage/DB write.
- **Non-base64 + private:** bytes stream as an authenticated RAW body (`fetchWithAuth` → `express.raw`) into ONE **private** Supabase Storage bucket under a **server-chosen** `org/attachmentId/filename` path; Postgres holds only metadata. There is no base64-in-JSON and no caller-selected path.
- **Owned:** `assertAttachmentsUsable` verifies every id is ready, org-scoped, and not already bound to another command before the durable command is persisted; the executor's `loadAttachmentsForDispatch` loads only ready, org-owned bytes and a retry re-loads (bytes never frozen in the row). Download returns only a short-lived (120s) signed URL under `requireOutreachRead`; delete removes row+object; a lifecycle helper prunes expired orphans.

## How policy denial preserves the draft

When the dispatcher returns `deferred` (org paused, suppressed, daily limit, warm-up, spacing, unhealthy account), `executeInboxSendCommand` **reschedules** the command — status back to `scheduled`, body/attachments untouched, the claim's attempt refunded, and `last_policy_code` recorded (proven by a unit test asserting the finalize UPDATE contains `status = 'scheduled'` and the policy code, never `failed`). The composer never clears the body on any failure; it renders the recoverable reason from the polled command's `lastPolicyCode` with the safe next step and a Cancel affordance, and an unsaved-exit confirmation guards a dirty draft against a stray Escape/Cancel.

## Final gate counts

- `npm run test`: **674 passed / 674** (49 files), run to completion. +40 over the 22-03 baseline of 634 (+28 server resolution/attachment/executor unit tests in `inbox-command-dispatch.test.ts`, +12 composer client tests, +1 DB resolution assertion, − consolidations).
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings, full project).
- `tsc -p tsconfig.json --noEmit` (client): PASS. `tsc -p tsconfig.server.json --noEmit` (server): PASS.
- No new migration (042 already carries `inbox_send_commands` + `inbox_attachments`; confirmed 042 is the latest). No production DB / Storage touched. `vitest.config.ts` unchanged.

## Task Commits

1. **Task 1 — server-side resolution + durable policy-gated executor + attachment plumbing** — `c29f610` (feat)
2. **Task 2 — bounded attachment lifecycle tests + typed composer client contract** — `ded7665` (feat)
3. **Task 3 — reply/reply-all/forward composer with snippets/attachments/schedule/command state** — `25bc782` (feat)
4. **Send-command DB test updated to the server-resolution contract** — `29499f3` (test)

## Deviations from Plan

### Within-latitude adjustments

**1. [Rule 3 - Blocking] Attachment upload uses an authenticated RAW body, not `multipart/form-data`**
- **Found during:** Task 2.
- **Issue:** Locked #7 and the plan describe "multipart upload through fetchWithAuth", but no multipart parser (multer/busboy) is installed and adding one to Express 5 beta is a needless dependency risk; the disposable test harness also has no Supabase Storage.
- **Fix:** Uploaded the file as an authenticated RAW body via `fetchWithAuth` (Content-Type `application/octet-stream`, filename/type in headers) parsed by a route-level `express.raw` with a byte ceiling. This preserves EVERY security property of locked #7 (authenticated fetchWithAuth path, server-validated count/size/MIME/extension/ownership, private bucket, non-base64, server-chosen path) — only the wire encoding differs from `multipart/form-data`.

**2. [Rule 2 - Correctness] Reply-all Cc/Bcc are suppression-filtered before send**
- **Found during:** Task 1.
- **Issue:** Campaign mail is one-to-one, so the policy gate only checks the primary recipient. A reply-all could copy a suppressed Cc, violating "a reply must respect suppression like campaign mail".
- **Fix:** The executor filters Cc/Bcc through the org suppression list (exact + `@domain` sentinel, the same model the delivery policy enforces) before composing the MIME. The primary To remains fully policy-gated by the dispatcher.

**3. [Rule 2 - Correctness] Send-command DTO now exposes `lastPolicyCode`/`lastError`**
- **Found during:** Task 2/3.
- **Issue:** The composer must render a specific, recoverable policy-denial reason, but the 22-01 DTO omitted it.
- **Fix:** Additive DTO fields (populated from the existing columns); no schema change.

**4. [Rule 3 - Blocking] 22-01 tests updated for the new contract**
- `inbox-operator.db.test.ts`: the send-command route no longer trusts client `to`/`inReplyTo` — seeded the persisted inbound `from_address` so the resolver can derive the recipient, and asserted the stored command was server-resolved. A `ClaimedInboxCommand` literal gained the new `attachmentIds` field.

**Scope note:** Full remote-provider attachment MIME streaming rides the existing `composeOutreachMime` attachments path (already present since Phase 19), so no provider adapter changed. The `defaultResolveAttachments`/`defaultStorage` Storage calls are server-only and injectable; their bounded validation + ownership logic is fully unit-tested, and end-to-end Storage delivery is a production-runtime verification (no Storage in the disposable harness).

## Known Stubs

None that block the plan's goal. Attachment byte upload/download and dispatch streaming depend on the production Supabase Storage `inbox-attachments` bucket (created by migration 042 where a `storage` schema exists); the bounded validation, ownership, and lifecycle logic are fully covered via the injectable storage seam, and the executor resolves only ready, org-owned attachments. No hardcoded empty values flow to rendering as fake data.

## User Setup Required

None for automated verification. **Production rollout:** migration 042 (already written/tested; NOT applied to prod) must be applied after 038→041, and its private `inbox-attachments` Storage bucket + signed-URL policies must exist for real attachment upload/download. Manual provider smoke (one native, one IMAP/SMTP, one Outlook reply) should be run against the deployed environment.

## Self-Check: PASSED

- Files verified present: `inbox-attachments.ts`, `ConversationComposer.tsx`, `inbox-command-dispatch.test.ts` (all FOUND).
- Commits verified present: `c29f610`, `ded7665`, `25bc782`, `29499f3` (all FOUND).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 674/674.

---
*Phase: 22-unified-inbox-operator-experience*
*Completed: 2026-07-16*
