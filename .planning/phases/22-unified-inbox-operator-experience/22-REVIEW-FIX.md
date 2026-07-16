---
phase: 22
phase_name: unified-inbox-operator-experience
fixed_at: "2026-07-16T16:35:00Z"
addresses: 22-REVIEW.md
status: fixes_complete
findings_fixed: 1 critical, 6 warnings, 2 info
---

# Phase 22 Code Review — Fix Report

All findings from `22-REVIEW.md` (C-1, W-1..W-6, I-1, I-2) are fixed. Each fix was written
test-first (RED confirmed before the change, GREEN after). The clean categories from the review
were not touched. No finding was judged unreal — all nine reproduced.

Test count moved 692 → 700 (8 new regression tests). Gates green twice (deterministic).

---

## C-1 (CRITICAL) — open thread blanks + composer draft destroyed on background detail refetch error

**Real.** `ConversationThread` gated its full-screen error card on `if (isError || !detail)`. React
Query v5 retains cached `detail` after a FAILED background refetch (status flips to `'error'`, data
kept), and SSE `conversation.updated`/`created` invalidates the open thread's detail. A transient
refetch failure while the operator typed replaced the thread with the error card and unmounted
`ConversationComposer`, destroying the in-progress reply (violated UIX-06).

**Fix** (`src/components/outreach/inbox/ConversationThread.tsx`):
- Error card now renders only when there is NO cached data (`if (!detail)`), which is equivalent to
  the review's `isError && !detail` for the error case while still handling the rare `!detail`
  non-error edge.
- When `isError` with cached `detail` present, the thread + composer stay mounted and a
  non-destructive inline "Couldn't refresh — showing the last loaded version." indicator (with a
  Retry affordance) is shown instead of blanking.

**Reproducing test** (`UnifiedInboxPage.test.tsx` → `ConversationThread: background refetch failure
does not blank or destroy the composer (C-1)`): renders the REAL `ConversationThread` parent with a
REAL `ConversationComposer` footer, types a draft, then re-renders with `isError` + retained
`detail`; asserts the heading still renders, the typed draft survives, the non-destructive indicator
appears, and the full error card does NOT. (The pre-existing composer-preservation test renders the
composer in isolation and never exercised this parent-gated unmount.)

---

## W-6 (WARNING) — conversation list blanks on a failed background refetch

**Real.** `ConversationList` checked `isError` before `conversations.length`, so a failed background
list refetch replaced all loaded/cached pages with the error card, losing the operator's place.

**Fix** (`src/components/outreach/inbox/ConversationList.tsx`): the error card renders only when
`isError && conversations.length === 0`. With cached rows present, the rows stay visible and a
non-destructive "Couldn't refresh — showing the last loaded list." indicator is shown. The sr-only
status line was also refined to distinguish "failed to load" (no data) from "couldn't refresh"
(stale data shown).

**Reproducing test** (`ConversationList: async states` → `keeps cached rows visible when a background
list refetch fails…`): `isError: true` with a loaded conversation → asserts the row is still visible
and the refresh-failed indicator (not the blanking error card) is shown.

---

## W-1 (WARNING, backend) — multi-recipient forward delivered only to the first To

**Real.** `resolveSendCommand` put all `forwardRecipients` into `to`, but `executeInboxSendCommand`
used only `toRecipients[0]` as `primaryTo` and never folded `toRecipients[1..n]` anywhere — silently
dropped.

**Fix** (`src/server/lib/inbox-command-dispatch.ts`): the executor now folds `toRecipients.slice(1)`
into the envelope Cc pool (the `DispatchOutreachInput.to` is a single string; `cc`/`bcc` are arrays,
so Cc is how the envelope carries the extra recipients). Every folded recipient is suppression-
filtered through `loadSuppressedAddresses` exactly like reply-all Cc; the primary To remains fully
policy-gated by the dispatcher. Delivery reaches ALL resolved recipients — nothing is dropped, and
the Phase 18 policy gate + suppression filtering are preserved for the whole set.

**Reproducing tests** (`executeInboxSendCommand: multi-recipient forward fan-out`): a forward to
`[a@x, b@y]` dispatches with `to = a@x` and `cc` containing `b@y` (never only `a@x`); a second test
asserts a suppressed folded recipient is stripped while the rest are still delivered.

---

## W-2 (WARNING, backend) — scheduled reply could send silently missing partially-deleted attachments

**Real.** `loadAttachmentsForDispatch` threw only when ALL attachments were missing
(`rows.length === 0`), so a scheduled command whose operator deleted SOME attachments before `due_at`
would dispatch a partial reply.

**Fix**:
- `src/server/lib/inbox-attachments.ts`: `loadAttachmentsForDispatch` now re-asserts the full
  referenced set is intact — throws `attachment_missing` when `rows.length !== unique-id count`
  (any referenced, ready, org-owned row gone), not only when all are gone.
- `src/server/lib/inbox-command-dispatch.ts`: the executor distinguishes a PERMANENTLY missing
  attachment (`attachment_missing`/`attachment_not_found`, unrecoverable — the operator deleted it)
  from a transient storage read failure. Missing → the command is HELD (`markHeld`,
  `last_error = 'attachment_missing'`, lease released) so the operator sees why and can correct it,
  never a partial send and never an endless retry. Transient storage errors still reschedule
  (bounded by attempts), preserving the existing behavior.

**Reproducing test** (`executeInboxSendCommand: policy denial preserves the draft` → `holds (never
dispatches a partial) when a referenced attachment was deleted before dispatch`): a command with 3
attachment ids whose loader throws `attachment_missing` → outcome `held`, dispatch never called,
finalize UPDATE sets `status = 'held'` with `attachment_missing`. The existing "reschedules … when a
bound attachment cannot be resolved" (generic storage error, no code) still passes.

---

## W-3 (WARNING) — bulk mutation patched detail cache but never snapshot/restored/invalidated it

**Real.** `useInboxBulkAction.onMutate` optimistically patched each selected id's detail cache but
returned only `{ listSnapshots }`; `onError` restored just the list, `onSettled` invalidated only
unread + list. A failed bulk action left an open selected thread's header showing the phantom
optimistic state.

**Fix** (`src/hooks/useUnifiedInbox.ts`): the bulk mutation now snapshots the detail cache for every
selected id (cancelling in-flight detail queries first, matching the single-conversation path),
restores every detail snapshot in `onError`, and invalidates each affected detail in `onSettled`.

**Reproducing test** (`operator mutations: optimistic + rollback` → `restores the DETAIL cache of an
open selected conversation when a bulk action fails`): open conversation X seeded in the detail
cache, bulk-select X + another, action 500s → asserts X's detail is restored to `unread=true` (not
left optimistically read) and the list rollback still holds.

---

## W-4 (WARNING) — concurrent optimistic mutations shared an org-wide list snapshot

**Real.** `snapshotInboxLists` captures the whole org list at `onMutate`; label attach/detach were
NOT in the shared `busy` gate, so a failed label rollback could revert an in-flight archive's
optimistic patch.

**Fix** (lower-risk option per the review — `src/pages/outreach/UnifiedInboxPage.tsx`): the `busy`
prop passed to `ConversationActions` now includes `labelAttach.isPending || labelDetach.isPending`
alongside read/archive/status. `ConversationActions` already disables all its controls (including the
label menu) on `busy`, so single-conversation optimistic mutations can no longer overlap.

**Reproducing test** (`UnifiedInboxPage: tenant isolation + selection` → `gates single-conversation
actions while a label mutation is in flight`): with the label-attach hook reporting `isPending`, the
Mark read and Archive buttons are asserted disabled.

---

## W-5 (WARNING) — org switch didn't reset bulk selection or filter UUIDs

**Real.** The org-change effect cleared only `conversation` + `cursor`; `bulkMode`/`selectedIds` and
the campaign/account/label filter UUIDs survived into the new org (stale count; org-A ids POSTed
under org B; org-A filter ids queried under org B).

**Fix** (`src/pages/outreach/UnifiedInboxPage.tsx`): on org change the effect now also drops the
campaign/account/label filter UUIDs from the URL (folded into the same replace-navigation that
already dropped conversation/cursor) and clears the bulk selection (`setBulkMode(false)` +
`setSelectedIds(new Set())`). (Forward references to the state setters are lint-safe — neither
`no-use-before-define` nor `exhaustive-deps` is enabled — and run post-render.)

**Reproducing test** (`… → clears bulk selection and drops the previous org filter UUIDs on
organization change`): org A with `campaign=<uuid>` + an active 1-row bulk selection → switch to org
B → asserts navigate dropped the campaign filter (`/outreach/unified-inbox`, replace) and the "1
selected" bulk bar is gone with the Select-mode entry restored.

---

## I-1 (info) — cleanupExpiredAttachments never scheduled

**Real.** The function existed but was never wired, and (as the review noted) the raw-upload flow
marks rows `ready` immediately, so a pending/failed-only reaper would not have reclaimed anything —
abandoned `ready` uploads had no reaper and their objects leaked in the private bucket.

**Fix**:
- `src/server/lib/inbox-attachments.ts`: `cleanupExpiredAttachments` now also reaps abandoned,
  never-bound `ready` rows (`isNull(send_command_id)` + older than the 24h TTL) in addition to
  pending/failed. The TTL + null-binding guard leave any in-flight compose→bind window untouched.
- `src/server/jobs/index.ts`: wired as a daily global reaper (`30 3 * * *`) following the existing
  cron registration pattern, with success/failure logging.

No new test (DB-bound, imports `../../db` directly; classified info/small). Server tsc + build green.

## I-2 (info) — unread badge not in a live region

**Real.** The unread badge (`InboxFilterRail.tsx`) had an `aria-label` but no live region, so count
changes were not announced.

**Fix**: the badge is wrapped in a persistent `aria-live="polite"` `aria-atomic="true"` region
(always mounted for the unread view) so count changes are announced to screen readers.

---

## Gate results (run twice for determinism)

| Gate                                   | Run 1        | Run 2        |
| -------------------------------------- | ------------ | ------------ |
| `npm run test` (vitest run)            | 700 passed / 50 files | 700 passed / 50 files |
| `npx tsc --noEmit -p tsconfig.json`    | clean        | —            |
| `npx tsc --noEmit -p tsconfig.server.json` | clean    | —            |
| `npm run lint` (--max-warnings 0)      | 0 warnings   | —            |
| `npm run build` (client + server)      | built        | —            |

Test count: 692 (review baseline) → 700 (+8 regression tests: C-1, W-6, W-3, W-4, W-5 frontend;
W-1 ×2, W-2 ×1 backend). Both test runs byte-stable at 700 passed.

## Deviations / judgment calls

- **W-1** delivered to all recipients by folding the extra To into the envelope Cc rather than
  rejecting multi-recipient forwards — the dispatch envelope carries multiple recipients fine
  (`cc: string[]`), so rejection was unnecessary. Suppression + policy gate preserved for the full
  set, as required.
- **W-2** uses `held` (not `failed`) for a permanently missing attachment: it preserves the command
  with a visible `last_error` and releases the lease (manual-review semantics), consistent with how
  policy-denial preserves the command. Transient storage failures keep the prior reschedule-then-
  fail behavior. The loader now distinguishes "partial set" from "all gone".
- **I-1** extended `cleanupExpiredAttachments` to reap abandoned `ready` uploads (the review's stated
  gap) rather than wiring the pending/failed-only reaper as a no-op. No dedicated test (DB-bound).
- No production DB was touched; no migration added (schema unchanged from 042); `apiFetch<T>` used
  throughout; no drizzle generate/push; `vitest.config.ts` untouched.
