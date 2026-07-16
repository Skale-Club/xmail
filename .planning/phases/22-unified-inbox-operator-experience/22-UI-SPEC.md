# Phase 22 UI Spec — Unified Inbox Operator Workspace

## Design intent

The workspace should feel like an operations console: compact enough to process many replies, calm enough to read long threads, and unmistakably tied to the selected organization/campaign. It inherits Xmail's existing Tailwind tokens and `OutreachLayout`; no new color system, glassmorphism, oversized dashboard cards, or decorative hero area.

## Information architecture

### Outreach navigation

- Add `Inbox` with the `Inbox` icon directly after Dashboard. Show an accessible unread badge (`99+` cap visually, full value in `aria-label`).
- Rename the current sender-account navigation label from `Inboxes` to `Sending accounts` while retaining `/outreach/inboxes` for link compatibility.
- `/outreach/unified-inbox` is the canonical workspace route. Selected conversation is encoded as `conversation=<id>` in the query string so filter state and mobile Back behavior remain shareable.

### Desktop layout (≥1280px)

Inside the Outreach main area, use full available viewport height minus the 64px top bar and page padding:

1. **Filter rail (224px):** Inbox, Unread, Needs reply, Reminders, Archived; label list; sync-health footer.
2. **Conversation list (360–420px):** sticky search/filter row, selected/bulk toolbar, cursor-loaded rows.
3. **Thread pane (fluid, min 480px):** subject/status header, attribution strip, ordered messages, composer/action footer.

Use 1px borders and existing background/card/muted tokens to separate regions. Avoid wrapping the entire workspace in nested cards.

### Tablet (768–1279px)

- Hide the filter rail behind a `Filters` button with active-filter count.
- Keep list + thread split, list width 320px.
- Thread attribution becomes a collapsible row.

### Mobile (<768px)

- Show exactly one stage: conversation list, thread, or composer.
- Opening a conversation preserves list search/filter/scroll and shows a labeled Back button.
- Thread actions use a bottom action bar; secondary actions go in an accessible menu.
- Composer is a full-height stage, not a tiny modal. Attachment/schedule controls remain reachable above the on-screen keyboard.

## Conversation list row

Each row is a real link/button with visible focus and contains:

- selection checkbox only while bulk mode is active;
- lead/sender display name, subject, one-line normalized snippet;
- relative timestamp with exact timestamp in tooltip/title;
- unread weight + dot, but also screen-reader text;
- campaign and sending-account compact badges;
- attachment/reminder icons only when applicable;
- outcome/status label using text + icon, never color alone.

Rows are 72–88px high, subject/snippet are truncated, and unread state must not shift layout. Arrow Up/Down may move focus; Enter opens; `x` toggles selection only when documented in a keyboard-shortcuts help tooltip.

## Thread pane

- Header: subject, lead identity/email, current status, labels, archive/read actions, overflow menu.
- Attribution strip: campaign link, sending account/provider, lead link, first/last activity. Unknown attribution is shown as `Not linked` with a non-destructive linking affordance only if Phase 21 exposes one.
- Message cards reuse `EmailHtmlViewer` for HTML isolation. Latest inbound and unread messages start expanded; older messages may collapse. Direction/provider delivery state is textual.
- Attachments show filename, human size, MIME category, scan/download state, and a server-authorized download action.
- Bottom composer is collapsed to `Reply` by default. Reply-all/forward select explicit modes and show recipients before editing.

## Composer

- Fields: mode, From account (resolved/default but changeable only among policy-eligible accounts), To/Cc for reply-all/forward, subject, rich body, snippet insertion, attachments.
- Primary action wording reflects state: `Send reply`, `Schedule reply`, or `Queue when eligible` after a recoverable policy deferral.
- Before final submit, show provider/account and scheduled timezone. The server remains authoritative.
- A policy denial is not a generic red toast. Render the reason adjacent to the action with the safe next step (paused organization, suppressed address, daily limit, warm-up, spacing, unhealthy account).
- Draft state is durable via send-command draft persistence or explicit Save draft; do not imply autosave unless implemented and tested.

## Bulk and destructive actions

- Enter bulk mode from the toolbar. `Select all` means only the currently loaded/bounded result set unless the API provides a signed filter-wide operation; copy must say which.
- Bulk actions: mark read/unread, label, archive. Suppression/blocklist always opens `ConfirmDialog` and is never combined with a hidden bulk default.
- Sender suppression confirmation names the email and selected conversation count. Domain suppression names the domain, warns about organization-wide effect, and rejects unsafe/public-domain scope according to server response.

## Async states

### Loading

- Initial list: 8 fixed-size row skeletons; thread pane shows a neutral `Select a conversation` placeholder, not another full spinner.
- Thread load: keep list interactive; show header/message skeletons only in thread.
- Load more: one inline list-row spinner with `aria-live=polite` text.
- Mutation: disable only the affected command; do not freeze the entire workspace.

### Empty

- No conversations at all: `No outreach replies yet` with connected-account/sync-health context and a link to Sending accounts.
- Filters yield none: `No conversations match these filters` with `Clear filters` action; never show onboarding.
- Search yields none: echo a safely truncated term and retain filter chips.
- Thread absent on desktop: explain selection; on mobile the list remains the stage.

### Error

- List failure: retain filters, show inline retry, and do not display stale data as fresh without a `Last updated` marker.
- Thread failure: keep list usable and offer thread-only retry.
- Mutation failure: rollback optimistic state, restore focus, and show specific action/error.
- SSE/sync failure: amber textual `Updates delayed` indicator with last successful sync and polling fallback; existing conversations remain readable. The authenticated stream is implemented with `fetch` + `ReadableStream` + `AbortController`, never `EventSource`.
- Send failure: command remains inspectable/retryable when safe; never clear the composed body automatically.

### Success

- Read/label/archive: immediate row/thread update with short toast only when useful.
- Send/schedule: composer collapses, durable command status appears in thread (`Scheduled`, `Queued`, `Sent`, or `Failed`) and list ordering updates on confirmed activity.
- Incoming reply: update unread count/list ordering, but do not steal focus or replace the open composer.

## URL state

Supported query parameters: `conversation`, `q`, `unread`, `status`, `campaign`, `account`, repeated `label`, `reminder`, and opaque `cursor` only when useful for shareability. Omit default values. Parsing is schema-validated; unknown/invalid values are discarded with `replaceState`, not allowed to poison queries.

Organization ID is never trusted from URL alone. It comes from `useOrganization` and appears in every query key/request.

## Accessibility contract

- One visible `<h1>` (`Unified Inbox`) and ordered landmarks for filters/list/thread.
- All icon buttons have accessible names and 44×44px mobile targets.
- Visible `:focus-visible` rings; dialog open/close restores focus.
- Thread messages preserve semantic heading order; sender/date/body relationships are announced.
- Live region for result count, new replies, load failures, and command state changes.
- Checkbox labels include conversation subject/lead, not `Select row`.
- Escape closes menus/dialogs, not the composer with unsaved content; unsaved exit asks for confirmation.
- Contrast uses existing theme tokens in both light/dark themes; unread and errors never rely solely on hue.

## Components/files anticipated

- `src/pages/outreach/UnifiedInboxPage.tsx`
- `src/components/outreach/inbox/InboxFilterRail.tsx`
- `src/components/outreach/inbox/ConversationList.tsx`
- `src/components/outreach/inbox/ConversationThread.tsx`
- `src/components/outreach/inbox/ConversationComposer.tsx`
- `src/components/outreach/inbox/ConversationActions.tsx`
- `src/components/outreach/inbox/InboxSyncStatus.tsx`
- `src/hooks/useUnifiedInbox.ts`
- `src/lib/unified-inbox-api.ts`

Names may follow Phase 21's finalized terminology, but responsibilities and state boundaries remain fixed.
