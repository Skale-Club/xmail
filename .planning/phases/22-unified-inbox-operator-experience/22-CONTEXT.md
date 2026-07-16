# Phase 22 Context — Unified Inbox Operator Experience

## Outcome

Deliver the operator-facing half of the Unified Inbox on top of Phase 21's durable conversation/message model. An authorized organization admin or member can work every outreach reply from one route without switching sender accounts: locate a conversation, read the complete normalized thread, reply through the correct provider, organize work, schedule a response, and see unread/new-reply state.

## Requirements

- UIX-01 — centralized conversation list and full thread across connected accounts.
- UIX-02 — URL-backed filters for unread/status/campaign/account/label plus bounded keyword search.
- UIX-03 — reply, reply-all, and forward with threading headers, attachments, and the shared send-policy gate.
- UIX-04 — read/unread, labels, archive, bounded bulk actions, and confirmed sender/domain suppression.
- UIX-05 — durable scheduled replies, reminders, snippets/macros, and attachments that survive restarts.
- UIX-06 — visible unread/new-reply notifications without polling every thread; sync failures degrade safely.

## Locked decisions

1. **This is an outreach workspace, not a skin over `/mail/inbox`.** Add `/outreach/unified-inbox` inside `OutreachLayout`. Keep `/outreach/inboxes` for sender-account management and label it clearly as sending accounts.
2. **One desktop workspace, staged mobile navigation.** Desktop is a three-region workspace: filter rail, conversation list, thread. Tablet collapses the filter rail. Mobile shows one stage at a time (list → thread → composer) with an explicit Back action; it must not squeeze three columns.
3. **The server owns query semantics.** Filter/search/cursor state is serialized in the URL and sent to Phase 21 APIs. The client does not download an organization mailbox and filter it in memory.
4. **Conversation mutations are tenant-scoped and idempotent.** Every request carries `organizationId`, resolves the authenticated user's organization membership server-side, and returns the updated conversation/version. Optimistic UI is allowed only with rollback.
5. **Replies are never sent directly from React.** Reply/reply-all/forward create a durable send command. The backend resolves recipients/thread headers/account and passes it through the shared send-policy gate created in the stabilization phases.
6. **Scheduling is durable.** Scheduled replies and reminders are database rows claimed by a long-running Node job under an advisory lock. Browser timers are forbidden.
7. **Attachments are bounded and server-validated.** Use multipart upload through the existing authenticated `fetchWithAuth` path; validate count, per-file size, aggregate size, MIME/extension, and ownership. Do not embed base64 blobs in JSON or conversation rows.
8. **Suppression is a destructive safety action.** Sender/domain blocklist actions require a confirmation dialog showing scope and consequences. Domain suppression must reject public/free-mail domains unless the operator explicitly chooses the supported safe scope.
9. **Near-real-time means one lightweight aggregate channel.** Use an organization-scoped SSE endpoint for unread count/conversation invalidation. Because bearer auth is required, the browser connects with authenticated `fetch`, consumes `Response.body` via `ReadableStream`, and closes with `AbortController`—never unauthenticated `EventSource`. Fall back to bounded list/unread polling with visible stale/sync-error status; never poll every thread.
10. **Existing components are reused selectively.** Reuse `OutreachLayout`, `Button`, `Input`, `Skeleton`, `ConfirmDialog`, `PaginationControls`, `EmailHtmlViewer`, and the useful rendering behavior from `EmailThreadView`. Do not couple the new workspace to `MailboxProvider`, mock mail data, or the personal-mail compose state.

## Phase 21 contract expected by this phase

Phase 21 publishes this organization-scoped contract:

- `GET /api/outreach/unified-inbox/conversations` — opaque `(lastMessageAt,id)` cursor list (max 100) with unread/status/campaign/account/search and preview/attribution/participants/read state, but no bodies.
- `GET /api/outreach/unified-inbox/conversations/:id` — chronological thread with normalized bodies and attachment metadata.
- `GET /api/outreach/unified-inbox/unread-count` — organization/user unread aggregate.
- `PATCH /api/outreach/unified-inbox/conversations/:id/read-state` — explicit per-user read/unread state (viewers may update their own state).
- Tables `outreach_conversations`, `outreach_conversation_messages`, `outreach_conversation_participants`, and `outreach_conversation_reads`; provider cursor/events are reused from Phase 19.

Before implementation, read Phase 21 summaries for exact DTO field names. Extend this router/model; do not create a parallel conversation API.

## Scope

### In scope

- Route/navigation, filterable list, thread reader, attribution panel.
- Read/unread, status/archive, labels, bulk operations, suppression confirmation.
- Reply/reply-all/forward, attachment upload/download, snippets, scheduled replies, reminders.
- New-reply/unread badge, sync health, keyboard/focus behavior, responsive states.
- Backend persistence/APIs/jobs that Phase 21 intentionally leaves for operator workflows.
- Automated route/service/component tests plus an executable responsive/accessibility UAT script.

### Out of scope

- AI-generated drafts and autonomous AI sending (Phase 23).
- Replacing the personal mailbox UI.
- Live collaborative editing or assignment/SLAs.
- Calendar scheduling, CRM pipeline management, or a full helpdesk ticket model.
- Provider ingestion/thread attribution already owned by Phase 21.

## Migration discipline

If operator tables/columns are not already delivered by Phase 21, start with provisional migration `042_unified_inbox_operator_workflows.sql`. **At execution start, list `supabase/migrations/*.sql`, confirm 042 is still the next free sequential integer, and rename all references if it is not before editing schema/code.** The migration includes tenant-owned `inbox_attachments` metadata and a private Supabase Storage bucket. Automated migration tests require an explicit `MIGRATION_TEST_DATABASE_URL`, refuse when it equals `DATABASE_URL` or the database name lacks a `_test` suffix, and never infer a target. The Windows manual runbook command is `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/042_unified_inbox_operator_workflows.sql` (using the revalidated filename). Never run Drizzle generation/db:push.

## Canonical route/access contract

Extend only `src/server/routes/outreach/unified-inbox.ts`, created by Phase 21. Do not create `inbox.ts` or a parallel router. Every request read uses `requireOutreachRead` and every mutation uses `requireOutreachWrite` from `src/server/lib/outreach-access.ts`; each underlying query/mutation also includes the verified `organizationId` predicate. Background workers have no request middleware, so their claim/update queries must carry organization scope from the claimed row and revalidate ownership before side effects.

## Verification boundary

The phase is not complete from screenshots alone. Verification must show:

- a seeded organization user can list and open only its own conversations;
- every URL filter round-trips and remains bounded/cursor-paginated;
- a reply is stored as a durable command/message and dispatches through the policy gate with correct `In-Reply-To`/`References`;
- restart recovery for scheduled replies/reminders;
- optimistic mutation rollback on 4xx/5xx;
- desktop, tablet, and mobile loading/empty/error/success states;
- keyboard navigation, focus restoration, accessible labels, and confirmation semantics.
