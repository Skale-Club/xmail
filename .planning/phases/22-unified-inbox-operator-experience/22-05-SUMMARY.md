---
phase: 22-unified-inbox-operator-experience
plan: 05
subsystem: fullstack
tags: [outreach, unified-inbox, sse, near-real-time, react-query, fallback-polling, accessibility, uat, tdd]

# Dependency graph
requires:
  - phase: 22-unified-inbox-operator-experience (plan 01)
    provides: "Migration 042 operator model + inbox router; materializer post-commit point"
  - phase: 22-unified-inbox-operator-experience (plan 02/03/04)
    provides: "Workspace (list/thread/filter rail/composer) + org-scoped inboxKeys + optimistic hooks + validated URL state + InboxSyncStatus"
  - phase: 21-unified-inbox-foundation
    provides: "materializeProviderEvent ingestion transaction (the post-commit fanout trigger)"
  - phase: 20-outreach-product-and-api-consistency
    provides: "requireOutreachRead org-scoped read guard for the SSE endpoint"
provides:
  - "src/server/lib/inbox-events.ts — in-process, org-scoped publish/subscribe bus carrying ONLY ids/counts (whitelist redaction), bounded subscribers, listener-error isolation, SSE frame/heartbeat helpers"
  - "GET /api/outreach/unified-inbox/events — bearer-authed (requireOutreachRead), org-scoped SSE with heartbeat + clean AbortController/close teardown"
  - "Post-commit fanout: materializeUnifiedInbox publishes conversation.updated on a new inbound message (MaterializeResult now carries organizationId)"
  - "src/hooks/useUnifiedInboxEvents.ts — ONE authenticated fetch + ReadableStream + AbortController stream, capped-backoff reconnect, bounded unread/list polling fallback, version-guarded targeted invalidation; InboxRealtimeProvider + useInboxRealtimeStatus"
  - "InboxSyncStatus + InboxFilterRail + OutreachLayout + UnifiedInboxPage wired for a visible degraded-sync (Updates delayed) marker"
  - "22-UAT.md — executable responsive/a11y/tenant/restart/provider acceptance script"
affects: [23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Near-real-time = ONE org-scoped SSE aggregate channel (locked #9): the browser uses authenticated fetch + Response.body ReadableStream + AbortController — never EventSource (bearer auth can't ride EventSource) — and reacts to a signal by invalidating a Query key, never by receiving content"
    - "The fanout channel is structurally incapable of leaking content: the bus rebuilds every event from a fixed whitelist (org/kind/conversationId/version/unreadCount/syncDegraded/at), so a body/subject/address on a caller's object is dropped before it reaches a subscriber or the wire"
    - "Tenant isolation is structural: subscribers are a Map keyed by organization id, so a publish for org B is only ever iterated against org B's listener set — there is no shared channel to leak across, and the endpoint subscribes under the same requireOutreachRead + org predicate as every read route"
    - "Convergence without per-thread polling: an event invalidates unread + list + the detail NAMESPACE (predicate), so only the currently-open thread (the sole active observer) refetches; the rest are untouched"
    - "Safe degradation: on disconnect the client reconnects with capped exponential backoff AND runs a bounded unread/list poll (never per-thread) with a visible 'Updates delayed' state — threads stay readable throughout"
    - "Focus/draft safety: the realtime hook ONLY invalidates queries (never touches composer state or calls focus), and the composer is keyed by conversation id with local draft state, so an event-driven re-render can neither clobber a half-typed reply nor steal focus"

key-files:
  created:
    - src/server/lib/inbox-events.ts
    - src/server/lib/inbox-events.test.ts
    - src/hooks/useUnifiedInboxEvents.ts
    - .planning/phases/22-unified-inbox-operator-experience/22-UAT.md
  modified:
    - src/server/routes/outreach/unified-inbox.ts
    - src/server/lib/unified-inbox/ingest.ts
    - src/server/jobs/materializeUnifiedInbox.ts
    - src/components/outreach/OutreachLayout.tsx
    - src/components/outreach/inbox/InboxSyncStatus.tsx
    - src/components/outreach/inbox/InboxFilterRail.tsx
    - src/pages/outreach/UnifiedInboxPage.tsx
    - src/pages/outreach/__tests__/UnifiedInboxPage.test.tsx

key-decisions:
  - "Fanout is an in-process bus, not a multi-process broker: production runs a single xmail container (CLAUDE.md) with the jobs in-process, so an in-memory Map bus reaches every open SSE connection. Multi-process fanout is intentionally NOT implemented; the client's bounded list/unread polling fallback is the authoritative safety net for any missed signal (proxy buffering / future scale-out). Documented in code + UAT §9."
  - "The single stream is hosted in OutreachLayout (locked #9 'ONE stream') via InboxRealtimeProvider, so exactly one connection keeps the unread badge live everywhere in outreach; the inbox page reads status read-only through context (no second stream)."
  - "The realtime hook does NOT need the active conversation id: it invalidates the detail NAMESPACE, so only the open thread (the sole observer) refetches. This decouples the shell-hosted stream from the page's selection and still avoids polling every thread."
  - "MaterializeResult gained organizationId (additive) so the materializer can publish an org-scoped signal post-commit; the injected test seam stays optional, so a publish is skipped when org is absent."
  - "The bus redacts via a whitelist rebuild (not a denylist), so the content-free guarantee holds even if a future caller passes a richer object — proven by a test that publishes body/subject/address and asserts they never survive."

patterns-established:
  - "SSE on Express 5: set text/event-stream + no-cache/no-transform + X-Accel-Buffering:no, flushHeaders(), write an initial comment, unref() the heartbeat interval, and clean up (clearInterval + unsubscribe + res.end) idempotently on req/res close|aborted|error — no leaked intervals/handles."
  - "Testing an authenticated SSE hook without a server: mock fetchWithAuth to return a controllable {ok, body:{getReader}} for delivery or reject for disconnect; fake timers drive the bounded-poll fallback; a captured AbortSignal proves teardown."

requirements-completed: [UIX-01, UIX-02, UIX-03, UIX-04, UIX-05, UIX-06]

# Metrics
duration: 16min
completed: 2026-07-16
---

# Phase 22 Plan 05: Near-Real-Time + UAT Summary

**One organization-scoped, bearer-authenticated SSE aggregate channel now converges the unread badge, conversation list, and open thread near-real-time — carrying ONLY ids/counts (never a message body, subject, or address, and never another org's activity) — while a disconnect falls back to bounded unread/list polling (never per-thread) with a visible "Updates delayed" state and an incoming event can neither steal focus nor clobber a half-typed reply; closed out with an executable responsive/accessibility/tenant/restart/provider UAT — 692/692 tests green (+18).**

## How the authenticated SSE stream works (and carries no bodies)

`src/server/lib/inbox-events.ts` is a small in-process publish/subscribe bus. `subscribeToInboxEvents(orgId, listener)` registers a listener in a `Map<orgId, Set<listener>>` and returns an idempotent unsubscribe; `publishInboxEvent(event)` **rebuilds the event from a fixed whitelist** (`organizationId`, `kind`, `conversationId`, `version`, `unreadCount`, `syncDegraded`, `at`) and iterates ONLY the event-org's listener set with per-listener `try/catch`. Because the outgoing object is reconstructed from those keys, a caller that carelessly passes a `plainBody`/`subject`/`fromAddress` has it dropped before it can reach a subscriber or the SSE wire (proven by tests asserting `Object.keys` and that the serialized frame does not contain the secret text). Tenant isolation is structural — a publish for org B is never iterated against org A's set.

`GET /api/outreach/unified-inbox/events` sits behind `authorizeOrganization` → `requireOutreachRead` with the verified `organizationId` predicate (the same front door as every read route), so the stream can never leak another org's activity. It sets `text/event-stream` + `no-cache, no-transform` + `X-Accel-Buffering: no`, `flushHeaders()`, writes a `: connected` comment, then relays each redacted event as `event: <kind>\ndata: <json>\n\n`. A 25s heartbeat comment (an `unref()`-ed interval) keeps the connection alive; a per-org/global subscriber cap fails a runaway client with `503`. The browser (`src/hooks/useUnifiedInboxEvents.ts`) connects with **authenticated `fetch` (`fetchWithAuth`, bearer token), consumes `Response.body` via a `ReadableStream` reader, and closes with `AbortController`** — never `EventSource` (which cannot send an Authorization header, locked #9). Frames are parsed off the byte stream (comments/heartbeats ignored) and each event triggers targeted TanStack Query invalidation. Post-commit publication is wired into `materializeUnifiedInbox`: after the ingestion transaction commits a new inbound message, it publishes a `conversation.updated` signal (org id + conversation id + a monotonic version) — best-effort, so a fanout error never affects the durable materialization.

## How disconnect falls back to bounded polling with visible stale state

When the stream ends (server close) or the `fetch` rejects/`!ok`, the hook enters `reconnecting` (capped exponential backoff: 1s→2s→…→30s) AND starts a **bounded fallback poll** that invalidates ONLY the unread aggregate + the conversation list every 30s — it NEVER enumerates or polls individual threads. `isStale` flips true, and `InboxSyncStatus` renders a color-independent **"Updates delayed — Reconnecting, refreshing periodically. Conversations remain readable."** The open thread's cached detail keeps rendering (nothing blanks it), so the inbox stays fully usable while degraded. On a successful reconnect the hook returns to `live`, resets the attempt counter, and stops the fallback poll. This is the authoritative safety net behind proxies that buffer SSE (documented single-container fanout scope — UAT §9).

## How an incoming event avoids stealing focus / clobbering an active composer

The realtime hook's ONLY side effect is `queryClient.invalidateQueries` (unread + list + the detail *namespace*). It never writes composer state and never calls `.focus()`. Only the open thread has an active observer, so only its detail refetches — returning the **same** conversation id, so the `ConversationComposer` (keyed by conversation id, holding its draft/mode/attachments in local `useState`) is not remounted. A refetch that changes surrounding data therefore cannot reset a half-typed reply, and focus stays on the textarea. A regression test types a reply, focuses the body, forces an event-driven re-render, and asserts both the body value and `document.activeElement` are preserved. A per-conversation version high-watermark also drops stale/out-of-order signals so they can't churn the cache.

## What the UAT script covers

`22-UAT.md` is a deterministic, executable acceptance script for the whole operator inbox (22-01..05) with two orgs/users and fixtures for unread, attachments, unknown attribution, sync error, scheduled send, reminder, and policy denial. Sections: tenant isolation/auth; responsive stages at 1440×900 / 1024×768 / 390×844; every async state (loading/empty/error/success for list + thread); URL/filter round-trip; keyboard navigation + focus restoration + accessible labels + light/dark contrast + live regions; operator actions + optimistic rollback + bounded bulk; server-authoritative suppression (cancel/confirm/two-confirm/public-domain refusal); the reply/reply-all/forward composer + snippets + attachments + schedule + recoverable policy denial; near-real-time convergence + simulated SSE disconnect → polling fallback → recovery; durable scheduling with **process-restart-before-due single-dispatch** recovery; and native/SMTP/Outlook reply smoke. Every **AUTO** row is mapped to its passing vitest case; **MANUAL** rows (deployed app/browser) and **provider-gated** rows (§11, no deployed credentials/Storage here) are recorded explicitly and NOT marked pass from unit tests alone.

## Provider matrix

Unchanged from 22-04 (this plan adds no new send path): reply/reply-all/forward ride the Phase 19 shared `composeOutreachMime` dispatcher, byte-identical across `native`, `smtp` (IMAP/SMTP), and `outlook` (Graph — Bcc refused by Graph, a documented non-parity). Provider smoke is **BLOCKED (provider-gated)** in this environment (no deployed credentials / Supabase Storage); the send path is the same policy-gated dispatcher verified in Phases 18–21 and exercised by the DB executor test.

## Final gate counts

- `npm run test`: **692 passed / 692** (50 files), run to completion. +18 over the 22-04 baseline of 674: +10 server (`inbox-events.test.ts`) and +8 client (5 SSE hook, 1 composer/focus preservation, 2 degraded-sync marker).
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings, full project).
- `tsc -p tsconfig.json --noEmit` (client): PASS. `tsc -p tsconfig.server.json --noEmit` (server): PASS.
- No new migration (042 remains the latest, confirmed at execution start). No production DB / Storage touched. `vitest.config.ts` unchanged.
- The materializer/ingest DB suites still pass with the additive `organizationId` field + post-commit publish (best-effort, injectable seam).

## Task Commits

1. **Task 1 — org-scoped SSE event bus + endpoint + ingestion fanout (TDD)** — `9e462c5` (feat)
2. **Task 2 — single authenticated stream, reconcile + bounded polling fallback (TDD)** — `9a4cf82` (feat)
3. **Task 3 — executable Unified Inbox UAT script** — `fbdf3de` (docs)

## Deviations from Plan

### Within-latitude architecture resolutions

**1. [Within latitude] The single stream is hosted in OutreachLayout, not the page**
- **Why:** Locked #9 mandates exactly ONE stream. Hosting it at the outreach shell (`InboxRealtimeProvider` in `OutreachLayout`) keeps the unread badge live across the whole outreach app with one connection; the inbox page reads status read-only via `useInboxRealtimeStatus()`. Exactly matches the plan's `files_modified` (OutreachLayout + UnifiedInboxPage + InboxSyncStatus).
- **Consequence:** the hook invalidates the detail *namespace* (not a specific id) so it does not need the page's active conversation — only the open thread refetches, so it still never polls every thread.

**2. [Rule 2 - Correctness] MaterializeResult gained `organizationId`**
- **Found during:** Task 1 (wiring post-commit publication).
- **Issue:** Publishing an org-scoped signal from the materializer needs the owning org; `MaterializeResult` exposed `conversationId` but not `organizationId`.
- **Fix:** Additive `organizationId` on the result (available as `event.organization_id`); the injected job seam stays optional so a publish is skipped when absent. Ingest/materialize DB suites still green.

**3. [Within latitude] InboxSyncStatus + InboxFilterRail extended (not just InboxSyncStatus)**
- The realtime status flows page → filter rail → sync footer, so `InboxFilterRail` gained two pass-through props (`realtimeStatus`, `realtimeStale`). Presentational-component convention (22-02/03) preserved; both remain prop-driven.

**Total deviations:** 3 (2 within-latitude structure, 1 additive correctness field). No scope creep; all serve locked #9's one-stream/no-bodies/safe-degradation contract.

## Known Stubs

None that block the plan's goal. Multi-process SSE fanout is intentionally not implemented (single-container production; the bounded polling fallback is the documented safety net). Real attachment upload/download and provider reply smoke remain deployment-runtime verifications (no Supabase Storage / provider credentials in this environment) — the UAT records them as MANUAL / BLOCKED (provider-gated), never passed from unit tests. No hardcoded empty values flow to rendering as fake data.

## Self-Check: PASSED

- Files verified present: `inbox-events.ts`, `inbox-events.test.ts`, `useUnifiedInboxEvents.ts`, `22-UAT.md` (all FOUND).
- Commits verified present: `9e462c5` (Task 1), `9a4cf82` (Task 2), `fbdf3de` (Task 3).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 692/692.

---
*Phase: 22-unified-inbox-operator-experience*
*Completed: 2026-07-16*
