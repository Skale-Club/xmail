---
phase: 22-unified-inbox-operator-experience
plan: 02
subsystem: frontend
tags: [react, tanstack-query, wouter, unified-inbox, outreach, url-state, tenant-isolation, responsive, accessibility, tdd]

# Dependency graph
requires:
  - phase: 21-unified-inbox-foundation
    provides: "Read API (GET conversations list + opaque cursor, GET thread detail, GET unread-count, PATCH read-state) with explicit DTOs in unified-inbox/queries.ts"
  - phase: 22-unified-inbox-operator-experience (plan 01)
    provides: "Operator endpoints (labels/archive/reminders/snippets/send-commands) + list filters labelId/reminderState/archived + labels[] projection"
  - phase: 20-outreach-product-and-api-consistency
    provides: "OutreachCheck org-member route guard; requireOutreachRead/Write access model"
provides:
  - "src/lib/unified-inbox-url.ts — Zod-validated, shareable URL filter state (parse/serialize/merge) with cursor reset, quick views, active-filter count"
  - "src/lib/unified-inbox-api.ts — typed Phase 21 read-API DTOs, org-scoped query keys, and URL-state -> server-query mapping using apiFetch<T>"
  - "src/hooks/useUnifiedInbox.ts — organization-keyed TanStack Query hooks (cursor infinite list, thread detail, unread count, labels, campaign/account options)"
  - "src/pages/outreach/UnifiedInboxPage.tsx — responsive three-region/staged workspace coordinator at /outreach/unified-inbox"
  - "src/components/outreach/inbox/{InboxFilterRail,ConversationList,ConversationThread,InboxSyncStatus}.tsx — presentational workspace regions"
  - "OutreachLayout Inbox nav item + accessible unread badge; Inboxes renamed to Sending accounts (URL retained)"
affects: [22-03, 22-04-reply-composer, 22-05, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The server owns query semantics: filter/search/cursor are validated URL state serialized into the Phase 21 query string; the client never downloads an org mailbox to filter in memory"
    - "URL state is normalized through one Zod-backed boundary (normalizeState); invalid enums/UUIDs/bounds are dropped, defaults omitted, serialization deterministic, and unknown/invalid params scrubbed with replaceState"
    - "A keyset cursor is only valid for its filter set: mergeInboxState resets the cursor whenever any FILTER field changes, but keeps it across selection changes and explicit load-more"
    - "Every TanStack Query key begins ['outreach-inbox', organizationId, ...]; an organization change yields fresh keys (no cross-tenant list/thread/count reuse) and the page also drops the prior tenant's selected conversation + cursor from the URL"
    - "List = useInfiniteQuery keyed by (org, filter signature) only — load-more accumulates server cursor pages; a filter change starts a new query; the selected conversation and cursor never affect the list cache key"
    - "Presentational regions (ConversationList/ConversationThread) are prop-driven so async states are independently recoverable and unit-testable without network/context mocking"

key-files:
  created:
    - src/lib/unified-inbox-url.ts
    - src/lib/unified-inbox-api.ts
    - src/hooks/useUnifiedInbox.ts
    - src/pages/outreach/UnifiedInboxPage.tsx
    - src/components/outreach/inbox/InboxFilterRail.tsx
    - src/components/outreach/inbox/ConversationList.tsx
    - src/components/outreach/inbox/ConversationThread.tsx
    - src/components/outreach/inbox/InboxSyncStatus.tsx
    - src/pages/outreach/__tests__/UnifiedInboxPage.test.tsx
  modified:
    - src/main.tsx
    - src/components/outreach/OutreachLayout.tsx

key-decisions:
  - "Client DTOs REPRODUCE Phase 21's public contract as local string-timestamp types (not @/db/schema Drizzle types), decoupling the client bundle from the schema module; Date fields are string|null over JSON."
  - "Used api-client's apiFetch<T> (the established outreach precedent from LeadsPage) rather than lib/api's apiFetch — both are generic; api-client adds token refresh + GET retry. Never apiRequest (raw Response, non-generic)."
  - "The URL supports repeated `label` params (parsed/deduped) for forward-compat, but the Phase 21 list API filters by a single labelId, so toListQueryString sends labels[0]. Documented as a within-latitude mapping."
  - "Archived is hidden by default: the URL stores archived only when true (the Archived quick-view), and the server query always sends archived=false unless that view is active — an operator inbox hides archived without an extra default param."
  - "Quick views (Inbox/Unread/Needs reply/Reminders/Archived) are DERIVED from orthogonal params (unread/status/reminder/archived) rather than a stored view enum, so a shared URL round-trips exactly and highlighting is a pure function of state."
  - "Selecting a conversation does NOT mark it read — read-state mutation is deferred to a later operator-actions plan (per plan instruction); selection only updates the URL + mobile stage."

patterns-established:
  - "Responsive workspace without JS width math: desktop rail is `hidden xl:flex`, tablet/mobile rail is an overlay sheet toggled by a Filters button, and the mobile single-stage list->thread swap is pure CSS keyed on whether a conversation is selected (list `hidden md:flex` when selected; thread `hidden md:flex` when not)."
  - "EmailHtmlViewer leaks post-teardown resize setTimeouts under jsdom; thread/page tests guard with scoped fake timers (timer fns only, not Date) cleared before RTL unmount — keeps npm run test deterministic."

requirements-completed: [UIX-01, UIX-02]

# Metrics
duration: 23min
completed: 2026-07-16
---

# Phase 22 Plan 02: Unified Inbox Operator Workspace (Read) Summary

**A new organization-scoped `/outreach/unified-inbox` workspace renders a server-cursor-paginated conversation list and complete normalized thread across all sender accounts, with schema-validated shareable URL filters that round-trip to the Phase 21 read API, org-keyed React Query caches that cannot bleed across tenants, and a desktop-three-region / tablet-collapsed / mobile-staged layout whose list and thread states are independently recoverable — 606/606 tests green (+39).**

## Route and layout as built

- Added `/outreach/unified-inbox` in `src/main.tsx`, lazy-loaded and wrapped in `<OutreachCheck>` (the Phase 20 organization-member gate, NOT `AdminCheck`). It renders INSIDE `OutreachLayout` — `/outreach/inboxes` remains the sender-account manager and `/mail/inbox` is untouched (locked decision #1).
- `OutreachLayout` gains an `Inbox` nav item (with the `Inbox` icon) directly after Dashboard, carrying an accessible unread badge (`99+` cap visually, full count in `aria-label`). The old `Inboxes` item is relabelled **Sending accounts** while keeping its `/outreach/inboxes` URL for link compatibility.
- The page is a viewport-height (`h-[calc(100vh-4rem)]`, full-bleed via `-m-4 lg:-m-6`) workspace: a header (`<h1>Unified Inbox</h1>` + a `<xl` Filters button), then a flex row of three regions.

## How filter/search/cursor state round-trips through the URL (not in-memory)

The server owns query semantics (locked #3). `unified-inbox-url.ts` is the single boundary:

1. `parseInboxUrl(search)` → a bounded `InboxUrlState`. Every field passes a Zod validator; invalid enums, non-UUIDs, out-of-bounds/blank search (trim, 1–200), and unknown params are dropped. Repeated `label` params are deduped; `unread`/`archived` are only meaningful when `true`.
2. The page scrubs the URL: whenever the raw `search` differs from `buildInboxSearch(state)` it `replaceState`s the cleaned, deterministic query — a poisoned query never reaches the server, and because `buildInboxSearch` is a fixed point it converges in one replace.
3. `toListQueryString(orgId, state, limit, cursor)` maps the validated state to the exact Phase 21 `GET /conversations` query (`search`, `unread`, `status`, `campaignId`, `emailAccountId`, `reminderState`, `labelId=labels[0]`, `archived` (false by default), `cursor`, `limit`). The client issues this to the server and renders whatever comes back — it never downloads and filters an org mailbox.
4. Pagination is a `useInfiniteQuery` over the server's opaque `(lastMessageAt,id)` keyset cursor; `fetchNextPage` walks it and prior pages accumulate. A shared deep-link `cursor` seeds the first page. `mergeInboxState` resets the cursor whenever any FILTER field changes (a keyset cursor is only valid for its filter set), but preserves it across selection changes and explicit load-more (proven by unit tests).

## How the three responsive stages work

Follows 22-UI-SPEC breakpoints with CSS, no JS width assumptions:

- **Desktop (≥1280px / `xl`):** three regions — filter rail (`hidden xl:flex`, 224px), conversation list (`xl:w-[380px]`), fluid thread (`flex-1`), separated by 1px borders.
- **Tablet (768–1279px / `md`–`xl`):** filter rail is hidden and reachable via a `Filters` button (with an active-count badge) that opens an overlay sheet; list (`md:w-80`) + thread stay split.
- **Mobile (<768px):** exactly one stage. The list is `flex w-full` until a conversation is selected, then it becomes `hidden` and the thread becomes the stage; the thread header shows a labelled **Back** button. Selection is encoded as `conversation=<id>` in the URL, so Back/stage state is shareable and preserves search/filters.

## How list and thread stay independently recoverable

The list (`useInboxConversations`) and thread (`useInboxConversation`) are separate org-scoped queries feeding separate prop-driven presentational components:

- **List:** 8 fixed row skeletons while loading; global empty (`No outreach replies yet`), filtered empty (`No conversations match these filters` + Clear filters), and search empty (echoes a truncated term) states; an inline **Retry** on failure that never blanks a loaded thread; a bounded Load-more with an `aria-live` label and disabled-while-fetching guard.
- **Thread:** header/message skeletons only in the thread pane; a thread-only **Retry** on failure that keeps the list usable; `Select a conversation` placeholder on desktop, list-stays-the-stage on mobile. A thread error can never blank the list and vice-versa (independent queries, independent components) — covered by dedicated tests.

## How React Query keys are org-scoped to prevent cross-tenant reuse

`inboxKeys.*` all begin `['outreach-inbox', organizationId, ...]` (list keyed by `(org, filterSignature)`, detail by `(org, conversationId)`, unread/labels/campaigns/accounts by `org`). A change of `currentOrganization.id` (from `useOrganization`, never the URL) yields brand-new keys — the previous tenant's list/thread/count/labels cannot be re-rendered. The page additionally drops the selected conversation + cursor from the URL on org change (a ref prevents clearing a valid deep link on first mount). `organizationId` is injected into every request; it is never trusted from the URL. Unit tests prove org-A vs org-B keys differ and that the list signature ignores cursor/conversation but reacts to filters; a page test proves an org switch fires a navigate that clears the selection.

## Attribution + safe thread rendering

`ConversationThread` renders exact persisted participants/direction/timestamps and an attribution strip (campaign name via the campaign index or explicit **Not linked**, sending account/provider from the list sync status, lead, first/last activity). Message bodies render through `EmailHtmlViewer` (sandboxed iframe, no `allow-scripts`); the latest message and the latest inbound auto-expand while older messages collapse behind a keyboard-operable toggle (`aria-expanded`). Attachment metadata (filename, MIME category, human size) is shown; the download action is intentionally disabled with an explanatory title (the attachment-lifecycle service is a later plan per 22-01) — see Known Stubs.

## Final gate counts

- `npm run test`: **606 passed / 606** (48 files). +39 over the 22-01 baseline of 567 (all in the new client suite). Exit 0, no unhandled/leaked-timer errors.
- `npm run lint`: PASS (0 warnings, full project).
- `tsc -p tsconfig.json --noEmit` (client): PASS. `tsc -p tsconfig.server.json --noEmit` (server): PASS.
- `npm run build`: PASS (client + server).
- No new migration (frontend plan; 042 confirmed as the latest migration and unchanged). No production DB touched. `vitest.config.ts` unchanged.

## Task Commits

1. **Task 1 — typed API hooks + validated URL state (TDD):** `4d5d5d8` (feat)
2. **Task 2 — route, navigation, responsive workspace shell:** `1519396` (feat)
3. **Task 3 — cursor list, attribution, safe full thread (TDD):** `ea4bcda` (feat)

## Deviations from Plan

### Within-latitude design resolutions

**1. [Rule 3 - Blocking] Used `api-client`'s `apiFetch<T>`, not `lib/api`'s**
- **Found during:** Task 1.
- **Issue:** The plan's read-first pointed at `src/lib/api.ts`, but the established outreach pages (`LeadsPage`, `useOrganization`) import `apiFetch<T>` from `src/lib/api-client.ts` (which adds token refresh + GET retry). Mixing modules would fork the auth path.
- **Fix:** Used `api-client`'s generic `apiFetch<T>` to match the outreach precedent. Still honours the plan's "apiFetch<T>, never apiRequest" rule.

**2. [Rule 2 - Missing behavior] URL supports repeated labels; server filters by one**
- **Found during:** Task 1.
- **Issue:** 22-UI-SPEC/plan require repeated `label` URL params, but the Phase 21/22-01 list API accepts a single `labelId`.
- **Fix:** The URL parser/serializer handles repeated, deduped labels (forward-compat + tested), and `toListQueryString` sends `labels[0]` as `labelId`. The filter rail sets a single label at a time. Documented so a later plan can widen the server filter without a URL migration.

**3. [Rule 3 - Blocking] Scoped fake timers in thread/page tests**
- **Found during:** Task 3 gate.
- **Issue:** `EmailHtmlViewer` schedules resize `setTimeout`s on iframe `load` that fire after jsdom teardown (`window is not defined`) — 3 unhandled errors that, while exit-0, could interleave into the next file in the serial full-suite run.
- **Fix:** A `useThreadTimerGuard()` helper fakes only the timer functions (not Date) around thread-rendering describes and clears the fake queue before RTL unmount. `EmailHtmlViewer` itself was NOT modified (out of scope; shared with personal mail). Full suite now runs clean.

### Task 2/3 file-boundary note

Task 2 shipped `UnifiedInboxPage` with lightweight inline list/thread placeholders so each commit builds green; Task 3 introduced the rich `ConversationList`/`ConversationThread` components and swapped the page over to them (plus the component/page test suite). This matches the plan's task file lists and keeps every commit independently buildable.

## Known Stubs

- **Attachment download is a disabled affordance.** `ConversationThread` renders attachment metadata (filename, MIME category, human size) with a download button that is `disabled`/`aria-disabled` and titled "Attachment download is coming in a later update". The attachment-lifecycle service (signed upload/finalize/download) was explicitly deferred by 22-01; this plan is read-only and does not regress that. Reading threads — the plan's goal — is fully functional. A later operator-actions plan wires download.
- **Reply/actions are not present** by design — UIX-01/02 are read-only; reply/label/archive/read-state mutations are UIX-03/04 (later plans). Selecting a thread deliberately does not mark it read.

No hardcoded empty UI values flow to rendering as fake data; every region is wired to the live Phase 21 API.

## Self-Check: PASSED

- Files verified present: `unified-inbox-url.ts`, `unified-inbox-api.ts`, `useUnifiedInbox.ts`, `UnifiedInboxPage.tsx`, `InboxFilterRail.tsx`, `ConversationList.tsx`, `ConversationThread.tsx`, `InboxSyncStatus.tsx`, `UnifiedInboxPage.test.tsx` (all FOUND).
- Commits verified present: `4d5d5d8` (Task 1), `1519396` (Task 2), `ea4bcda` (Task 3).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 606/606 (exit 0, clean).

## Next Phase Readiness

- **22-03+ (operator actions / composer)** can build on: the org-scoped hooks and query keys (`inboxKeys`), the validated URL state, the prop-driven `ConversationList`/`ConversationThread` (ready to receive action callbacks + optimistic updates), and the durable send-command / label / archive / reminder endpoints already shipped by 22-01. Read-state mutation (`PATCH .../read-state`) is available and intentionally not yet wired.

---
*Phase: 22-unified-inbox-operator-experience*
*Completed: 2026-07-16*
