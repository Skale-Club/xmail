# Phase 21 — Unified Inbox Foundation

## Outcome

Persist complete, deduplicated outreach conversations from native mail, IMAP, and Microsoft Graph, attribute them to outreach entities, and expose organization-scoped read APIs with stable cursor pagination and per-user unread state.

## Scope

This phase owns requirements `UIF-01` through `UIF-05`. It creates the data and API contracts consumed by the operator UI in Phase 22 and by AI assistance in Phase 23.

## Locked domain model

### Tables

- `outreach_conversations`: organization-owned thread summary and attribution (`email_account_id`, optional lead/campaign/campaign_lead), normalized subject, status, last-message metadata, timestamps.
- `outreach_conversation_messages`: immutable normalized message records, direction/provider ids, RFC Message-ID threading fields, addresses, full text/html bodies, safe headers, attachment metadata, timestamps, and optional links to `outreach_emails`.
- `outreach_conversation_participants`: normalized addresses/names/roles per conversation.
- `outreach_provider_events` and `outreach_provider_cursors` are introduced by Phase 19 as the durable, idempotent provider staging/cursor layer. Phase 21 consumes/extends those contracts instead of creating a parallel poller.
- `outreach_conversation_reads`: per-user last-read timestamp/message state; absence means unread when the conversation has an incoming message.

Every tenant-scoped table carries `organization_id` even when it can be reached through another table. All unique constraints and indexes start with tenant/account scope where applicable.

### Identity and idempotency

- Provider-native immutable ids are primary dedupe keys: native `mail_messages.id`, IMAP `(account, folder/uidValidity, uid)`, Graph message id plus mailbox.
- RFC `Message-ID` is used for threading/attribution but is not globally unique and is not the sole ingestion idempotency key.
- Inserts and conversation summary updates occur in one transaction. Reprocessing an event yields the existing message and no repeated reply counters, notifications, or follow-up scheduling.
- Provider-event materialization has its own lifecycle (`materialization_status`, lease, attempts, error, `materialized_at`, normalized-message link). It is independent from Phase 19's `processed_at`, which records classification/domain-side-effect processing and must never be reused as a materialization claim.
- All addresses and Message-ID tokens are normalized in one shared module before lookup.
- Successful outbound `outreach_emails` are materialized with `source_key = outreach-email:<id>`. The sole best-effort hook lives in `src/server/lib/outreach-dispatch.ts`, immediately after durable sent-state persistence; entrypoints never call materialization directly. A bounded `NOT EXISTS` backfill closes any crash window without resending mail.

### Threading and attribution

- First match `In-Reply-To` and every `References` token to normalized conversation/outreach message ids.
- Next match the provider thread/conversation id where trustworthy.
- Finally allow a bounded address heuristic: same organization/account, known lead address, recent outbound message, configurable lookback, newest match. Record the match strategy and confidence.
- Ambiguous address matches create an unattributed conversation; they never attach across organizations.
- Auto-replies and DSNs are classified before human-reply side effects. Bounce processing owns DSNs.

### Ingestion providers

- Native ingress reuses already parsed `mail_messages` but records a durable source id and full bodies.
- IMAP fetches full raw messages only for a bounded UID batch after the persisted cursor, parses with `mailparser`, and stores attachment metadata (not arbitrary attachment bytes in Postgres).
- Outlook uses Microsoft Graph delta queries and persists the delta link/cursor. It requests the fields/body/header data required by the normalizer and handles expired delta cursors with a bounded resync.
- Provider failures update cursor/error state and do not advance past an unpersisted message.

### API contract

- `GET /api/outreach/unified-inbox/conversations` — opaque cursor, max 100, filters for unread/status/campaign/account and bounded keyword search.
- `GET /api/outreach/unified-inbox/conversations/:id` — full ordered thread plus attribution/participants.
- `GET /api/outreach/unified-inbox/unread-count` — organization-scoped count for current user.
- `PATCH /api/outreach/unified-inbox/conversations/:id/read-state` — `{ read: boolean }`, idempotent.
- Phase 21 is read-side only apart from read state. Reply/forward/actions are Phase 22.

### Authorization

- Every route uses the canonical Phase 20 outreach access helper before any tenant data query.
- Organization viewers may list/read and manage only their own read state; members/admins have the same read access.
- Background jobs derive organization scope from the `email_accounts` row and include it in every query/update.
- RLS is added as defense-in-depth, but JavaScript scoping remains mandatory because the application DB role bypasses RLS.

### Database workflow

- Phase 21 reserves migration `041_unified_inbox_foundation.sql`; the executor must inspect migrations and renumber immediately before creating it.
- SQL is hand-written, sequential, and source of truth. Mirror types/indexes in `src/db/schema.ts`.
- Never use `drizzle-kit generate`, `npm run db:generate`, or `db:push`.
- Automated migration verification must run only through the Phase 18 protected PostgreSQL harness, passing its guarded test URL explicitly; tests must never read or fall back to application `DATABASE_URL`. Manual production rollout uses PowerShell: `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/NNN_unified_inbox_foundation.sql`.

## Operational boundaries

- Per tick and per account: bounded messages, bounded lookback, advisory lock/lease, structured counters for scanned/inserted/duplicate/unmatched/error.
- Bodies are stored, but logs never include message bodies, recipient lists, credentials, tokens, or attachment content.
- Existing `mail_messages` and `outreach_emails` remain sources; this phase does not replace the general webmail model.

## Out of scope

- Labels, archive/bulk actions, composer, scheduled replies, reminders, macros, attachment upload/download (Phase 22).
- AI draft/autonomous actions (Phase 23).
- Full-text search infrastructure beyond bounded PostgreSQL search needed for the MVP API.
