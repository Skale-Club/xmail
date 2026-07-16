---
phase: 22
phase_name: unified-inbox-operator-experience
reviewed_at: "2026-07-16T17:00:00Z"
reviewers: 3 (backend security/send-safety, frontend correctness, requirements verification)
range: 0d9b4e1..cb8840b
status: fixes_required
findings: 1 critical, 6 warnings, 2 info
---

# Phase 22 Code Review

Three independent reviewers over `git diff 0d9b4e1..HEAD` (21 commits, ~12700 insertions).
Fresh gates green twice, byte-identical (692 tests, build, lint 0 warnings, both tsc projects). The
requirements verifier PASSED (UIX-01..06, 19/19 must-haves).

**The security and safety-critical surfaces are sound.** The reply/forward send is unspoofably
routed through the single Phase 18 policy gate (recipients/headers resolved server-side from
persisted messages; no second send path); tenant scoping leads every query; the SSE stream is
org-keyed and carries only ids/counts (no bodies); attachments are bounded/owned/private-bucket/
non-base64; the 22-03 `@domain` suppression widening is exact-match, org-scoped, and does not
over-suppress. No cross-tenant read/write, policy bypass, content/secret leak, or injection was
found across any lens.

The findings are one client-side draft-loss bug and a set of same-org reliability/correctness gaps
the tests miss.

## CRITICAL

### C-1 — An open thread blanks and the composer draft is destroyed on a background detail refetch error

`src/components/outreach/inbox/ConversationThread.tsx:170`.
The thread renders its full-screen error card on `if (isError || !detail)`. But the QueryClient uses
`retry` with no `throwOnError`, and React Query v5 RETAINS `data` after a failed refetch while
flipping `status` to `'error'`. The open thread's detail is invalidated by every SSE
`conversation.updated`/`created` signal (`useUnifiedInboxEvents.ts:110`), triggering a background
refetch. If that refetch fails (transient 5xx/network, 2 retries exhausted), `isError` is true while
`detail` is still the last-good thread — so the thread is replaced by the error card and the mounted
`ConversationComposer` UNMOUNTS, silently destroying the operator's in-progress reply draft.

Concrete: operator is typing a reply → any other inbound/status/label change in the org fires an SSE
event → the open thread's detail refetch hits a transient error → "Couldn't load this conversation"
→ **draft gone**; the next successful refetch remounts the composer empty. This directly violates the
UIX-06 guarantee that events must not clobber an active composer. The composer-preservation test
(`UnifiedInboxPage.test.tsx:1444`) renders the composer in isolation and re-renders only a sibling,
so it never exercises this parent-gated unmount; the thread-error test uses first-load
`detail: undefined`.

**Fix:** gate the error card on `isError && !detail` (show the last-good thread + composer with a
non-destructive inline "couldn't refresh" indicator when a background refetch fails but cached data
exists). Add a test that seeds cached detail, forces the detail query to error, and asserts the
thread + composer (with its typed draft) survive.

## WARNING

### W-1 — Multi-recipient forward delivers only to the first To address

`src/server/lib/inbox-command-dispatch.ts:210` (resolve at :474).
`resolveSendCommand` puts all `forwardRecipients` into `to`, but `executeInboxSendCommand` uses only
`command.toRecipients[0]` as `primaryTo` and drops `toRecipients[1..n]` (never folded into cc/bcc).
An operator forwarding to `[a@x, b@y]` silently reaches only `a@x`. Under-delivery of the operator's
own mail — no leak, but a forward that silently drops recipients is trust-breaking. Fix: deliver to
all resolved forward recipients (primaryTo + the rest as additional To/Cc through the dispatch
envelope), or reject multi-recipient forward explicitly if the envelope can't carry them — do not
silently drop.

### W-2 — A scheduled reply can send silently missing attachments deleted before its due time

`src/server/lib/inbox-attachments.ts:302` (`loadAttachmentsForDispatch`).
`assertAttachmentsUsable` verifies the full set only at command CREATION; `deleteInboxAttachment`
removes a bound row with no in-flight guard, and `loadAttachmentsForDispatch` only throws when ALL
attachments are missing. So a scheduled command whose operator deletes SOME (not all) of its
attachments before `due_at` dispatches the reply silently missing those files. Same-org reliability,
but "sent without the files I attached" breaks trust. Fix: at dispatch, re-assert the command's
attachment set is intact (all referenced rows still present + owned); if any are missing, do not send
a partial — fail/hold the command with a visible reason so the operator can correct it.

### W-3 — Bulk mutation patches the detail cache but never snapshots/restores or invalidates it

`src/hooks/useUnifiedInbox.ts:344-366`.
`useInboxBulkAction.onMutate` optimistically patches the detail cache for every selected id, but its
context returns only `{ listSnapshots }`; `onError` restores just the list and `onSettled`
invalidates only unread + list. So a failed bulk action leaves an open selected conversation's thread
header showing the optimistic (wrong) `unread`/`archived`/`status`/`labels` — misrepresenting a
failed action as success — until the detail is independently refetched. The single-conversation path
handles detail correctly; bulk is the asymmetric gap. Fix: snapshot + restore the detail cache in the
bulk mutation the same way the single path does, and invalidate detail on settle.

### W-4 — Concurrent optimistic mutations share an org-wide list snapshot; one rollback can revert another

`src/hooks/useUnifiedInbox.ts:175-181,231`.
`snapshotInboxLists` captures the whole org list at `onMutate` (already including an earlier pending
mutation's optimistic patch) and `restoreInboxLists` writes it all back on error. `ConversationActions`
gates read/archive/status behind a shared `busy`, but label attach/detach is NOT in that `busy`
(`UnifiedInboxPage.tsx:256`), so an operator can fire attach-label + archive concurrently — if the
label call fails, its rollback also erases the archive's optimistic list change. Self-heals via
`onSettled` refetch (transient flicker, not permanent corruption). Fix: include label ops in the
shared `busy` gate, or make the list snapshot/restore per-conversation rather than org-wide.

### W-5 — Organization switch does not reset bulk selection or filter UUIDs

`src/pages/outreach/UnifiedInboxPage.tsx:75-84`.
The org-change effect clears only `conversation` + `cursor`; it leaves `bulkMode`/`selectedIds`
(component state) and the campaign/account/label filter UUIDs (URL) intact. After A→B the bulk bar
still shows "N selected" for org-A ids (a bulk action then POSTs org-A ids under `organizationId=B`,
which the server rejects as non-matching — no cross-tenant mutation, a no-op) and the list is queried
with org-A filter ids under org B (empty/400 until cleared). Query keys are org-scoped so NO
cross-tenant data renders — a server-safe stale-client-state papercut. Fix: on org change, also clear
bulk selection and drop filter UUIDs that belong to the previous org.

### W-6 — The conversation list blanks on a failed background refetch (same anti-pattern as C-1)

`src/components/outreach/inbox/ConversationList.tsx:219`, `UnifiedInboxPage.tsx:334`.
The list checks `isError` before `conversations.length`, so a failed background list refetch (from an
SSE/unread invalidation or a mutation's `onSettled`) replaces the loaded list the operator was
scrolling with "Couldn't load conversations / Retry" even though all pages are still cached.
Recoverable, no data loss, but loses their place on any transient blip. Fix: same as C-1 — show
cached data with a non-destructive refresh-failed indicator; only render the error card when there is
no cached data (`isError && !conversations.length`).

## Info (small, fold in if cheap)

- **I-1** — `cleanupExpiredAttachments` is defined but never scheduled in `jobs/index.ts`. The
  RAW-upload flow creates no `pending` orphans, but abandoned `ready` uploads have no reaper. Wire it
  into the job registry (storage hygiene).
- **I-2** — the unread badge (`InboxFilterRail.tsx:116`) has an `aria-label` but is not inside an
  `aria-live` region, so count changes are not announced to screen readers. Wrap it in a polite live
  region.

## Clean categories (recorded so they are not re-litigated)

- Reply send policy-gate bypass — `executeInboxSendCommand` is the ONLY inbox caller of
  `dispatchOutreachMessage`; the route only persists a durable command; policy runs before claim,
  before provider, and on capacity re-check; scheduled sends only delay the claim.
- Reply recipient/header spoofing — To/Cc/In-Reply-To/References resolved from persisted
  org+conversation-scoped messages; the reply schema does not accept them; cross-tenant
  `sourceMessageId` is impossible (scoped load + composite FKs).
- 22-03 suppression widening — exact equality on address AND `@domain` sentinel, org-scoped, no
  substring, guarded against a bare `@`, public/free-mail domains refused at write-time.
- Attachment security — actual-byte measurement, MIME+extension allow-list, filename traversal
  stripped, server-chosen path, private bucket, org-scoped upload/download/dispatch, non-base64.
- Tenant scoping on every operator mutation; bulk hard 100-ceiling + foreign-org ids skipped; the
  claimer carries org scope from the claimed row and revalidates before side effects.
- SSE org-isolation + fixed-whitelist redaction (no bodies), idempotent cleanup, subscriber caps,
  authenticated fetch+ReadableStream+AbortController (no EventSource), bounded polling fallback.
- Secrets/injection — no credentials in responses/logs; bulk ids are `uuid[]` via Zod+`inArray`;
  free-text parameterized; snippet bodies reject scriptable HTML; `sql.unsafe` uses bound params.
- Frontend: org-scoped query keys (org from `useOrganization`, never URL); composer keyed by
  conversation id (same-id refetch does not remount); no `.focus()`/autoFocus (SSE cannot steal
  focus); URL validation drops invalid enums/UUIDs/oversize; page limit is a fixed constant;
  bulk honesty (bounded 100, real count); `apiFetch<T>` used throughout (no `apiRequest` misuse).
- Migration 042 idempotent + schema mirror matches; private bucket `public=false`; no `bytea`.

## Fix scope for this phase

Fix C-1 (critical draft loss) and W-1..W-6. Fold in I-1 and I-2 if cheap. Re-review C-1 + the two
backend send defects (W-1, W-2), then close.
