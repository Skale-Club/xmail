---
phase: 21-unified-inbox-foundation
plan: 01
subsystem: database
tags: [postgres, drizzle, migration, unified-inbox, outreach, rls, testcontainers, tdd]

# Dependency graph
requires:
  - phase: 19-provider-parity-and-deliverability
    provides: outreach_provider_events + outreach_provider_cursors (durable idempotent provider staging/cursor layer, migration 039)
  - phase: 20-outreach-product-and-api-consistency
    provides: canonical outreach access helper (src/server/lib/outreach-access.ts)
provides:
  - "Migration 041: four org-scoped Unified Inbox tables (outreach_conversations, outreach_conversation_messages, outreach_conversation_participants, outreach_conversation_reads)"
  - "Provider-event materialization lifecycle (status/lease/attempts/error/materialized_at/conversation_message_id) added to outreach_provider_events, independent of processed_at"
  - "Drizzle mirror + inferred types in src/db/schema.ts matching the SQL byte-for-byte on identifiers"
  - "Provider-neutral conversation/message/read-state contracts in src/server/lib/unified-inbox/types.ts"
affects: [21-02-ingestion, 21-03-read-api, 21-04-read-api, 22-unified-inbox-ux, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Composite (id, organization_id) FK tenant binding (extends the Phase 19/039 pattern to every new child table)"
    - "campaign_lead bound to its campaign via composite (campaign_lead_id, campaign_id) FK + a requires-campaign CHECK, because campaign_leads has no organization_id"
    - "source_key dedupe (organization_id, email_account_id, source_key); RFC Message-ID indexed but deliberately non-unique"
    - "Separate leased compare-and-swap materialization lifecycle that never reuses the classification claim (processed_at)"
    - "Schema-owned enum unions re-exported by the contracts module and bound with `satisfies` so SQL/TS drift fails to compile"

key-files:
  created:
    - supabase/migrations/041_unified_inbox_foundation.sql
    - src/server/lib/unified-inbox/types.ts
    - src/server/lib/unified-inbox/__tests__/schema.db.test.ts
  modified:
    - src/db/schema.ts

key-decisions:
  - "Materialization lifecycle is a dedicated column set (materialization_status/lease/attempts/error/materialized_at/conversation_message_id) that is NEVER processed_at; a partial claim index over pending|processing supports the CAS queue."
  - "Dedupe key is the provider-native source_key, not the RFC Message-ID; duplicate Message-IDs across distinct source keys are explicitly allowed and indexable."
  - "campaign_lead cross-tenant safety is enforced through its campaign (composite (campaign_lead_id, campaign_id) FK) since campaign_leads carries no organization_id."
  - "message.classification is NOT NULL DEFAULT 'other' (reuses the Phase 19 classification vocab); outbound messages carry 'other'."
  - "Thread order index uses COALESCE(received_at, sent_at, created_at) in SQL; the Drizzle 0.30.4 mirror lists plain columns (index().on() does not accept SQL expressions in this version)."

patterns-established:
  - "Every tenant-scoped table carries organization_id and every unique/index starts with tenant (or tenant+account) scope."
  - "New foundation tables ship empty; no historical mail backfill in the migration (a bounded restartable backfill is a later plan)."

requirements-completed: [UIF-01]

# Metrics
duration: 35min
completed: 2026-07-16
---

# Phase 21 Plan 01: Unified Inbox Foundation Summary

**Migration 041 lands four organization-scoped, deduplicated conversation tables plus a leased materialization lifecycle on the Phase 19 provider events — all tenant-bound by composite FKs and mirrored drift-free in Drizzle.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-16T06:58:00Z (approx)
- **Completed:** 2026-07-16T07:33:00Z (approx)
- **Tasks:** 3 (TDD)
- **Files modified:** 4 (3 created, 1 modified) + deferred-items.md

## Accomplishments

- **Four foundation tables** (`outreach_conversations`, `outreach_conversation_messages`, `outreach_conversation_participants`, `outreach_conversation_reads`), each with a non-null `organization_id` and composite-FK tenant binding — never reachable-through-another-table only.
- **Immutable normalized messages** with direction/provider ids, RFC Message-ID threading fields (`internet_message_id`, `in_reply_to`, `message_references`), address JSONB, full text/html bodies, safe headers, attachment metadata, and a `source_key` dedupe identity.
- **Provider-event materialization lifecycle** added to `outreach_provider_events`, fully independent from Phase 19 `processed_at`, with a partial compare-and-swap claim index and a one-event-to-one-message unique link.
- **Drizzle mirror + provider-neutral contracts** kept in lockstep with the SQL and proven by an 18-test disposable-database suite (`schema.db.test.ts`).

## Table / column / index inventory

### `outreach_conversations`
- Columns: `id`, `organization_id`, `email_account_id`, `lead_id?`, `campaign_id?`, `campaign_lead_id?`, `provider_thread_id?`, `thread_key`, `normalized_subject?`, `status` (default `open`), `last_message_id?`, `last_message_at?`, `last_inbound_at?`, `last_outbound_at?`, `latest_message_preview?`, `created_at`, `updated_at`.
- Uniques: `outreach_conversations_thread_key_unique (organization_id, email_account_id, thread_key)`; `outreach_conversations_id_organization_unique (id, organization_id)`.
- Indexes: `idx_outreach_conversations_list (organization_id, last_message_at DESC, id DESC)`, `_account`, `_status`, partial `_unread (organization_id, last_inbound_at DESC)`, partial `_lead`, partial `_campaign`.
- Checks: `status_check (open|closed)`, `thread_key_check` (non-blank), `campaign_lead_requires_campaign`.
- Composite FKs: account/org, lead/org, campaign/org, `(campaign_lead_id, campaign_id)`, and the deferred `last_message_id/org` self-reference (added after the messages table to break the creation cycle).

### `outreach_conversation_messages` (immutable)
- Columns: `id`, `organization_id`, `conversation_id`, `email_account_id`, `outreach_email_id?`, `direction`, `provider`, `provider_message_id?`, `provider_thread_id?`, `source_key`, `internet_message_id?`, `in_reply_to?`, `message_references?`, `subject?`, `from_address?`, `from_name?`, `to/cc/bcc/reply_to_addresses` (jsonb `[]`), `plain_body?`, `html_body?`, `headers` (jsonb `{}`), `attachments` (jsonb `[]`), `has_attachments`, `classification` (default `other`), `match_strategy?`, `match_confidence?`, `sent_at?`, `received_at?`, `created_at`.
- Uniques: **`outreach_conversation_messages_source_key_unique (organization_id, email_account_id, source_key)`** (the dedupe key); `_id_organization_unique (id, organization_id)`.
- Indexes: `idx_..._thread (organization_id, conversation_id, COALESCE(received_at, sent_at, created_at), id)`, partial `_internet_message_id`, partial `_in_reply_to`, partial `_outreach_email` (backfill anti-join).
- Checks: `direction_check`, `provider_check`, `classification_check`, `source_key_check` (non-blank), `match_strategy_check`.

### `outreach_conversation_participants`
- Columns: `id`, `organization_id`, `conversation_id`, `address`, `name?`, `role`, `created_at`.
- Unique: `outreach_conversation_participants_unique (organization_id, conversation_id, address, role)`; index `_address (organization_id, address)`.
- Checks: `role_check (from|to|cc|bcc|reply_to)`, `address_check`.

### `outreach_conversation_reads`
- Columns: `id`, `organization_id`, `conversation_id`, `user_id`, `last_read_message_id?`, `last_read_at`, `created_at`, `updated_at`.
- Unique: `outreach_conversation_reads_unique (organization_id, conversation_id, user_id)`; index `_user (organization_id, user_id)`.
- FKs: org, conversation/org, `user_id → users`, `last_read_message_id/org`.

### `outreach_provider_events` extension (migration 041)
- New columns: `materialization_status` (default `pending`), `materialization_lease_token?`, `materialization_lease_expires_at?`, `materialization_attempts` (default 0), `materialization_error?`, `materialized_at?`, `conversation_message_id?`.
- Unique: partial `outreach_provider_events_materialized_message_unique (conversation_message_id)`.
- Index: partial `idx_outreach_provider_events_materialization_claim (materialization_status, received_at) WHERE materialization_status IN ('pending','processing')`.
- Checks: `materialization_status_check`, `materialization_lease_check`, `materialization_attempts_check (>=0)`, `materialized_requires_message`.

### Tenant-binding prerequisites added (composite-FK targets)
`leads_id_organization_unique`, `campaigns_id_organization_unique`, `outreach_emails_id_organization_unique`, `campaign_leads_id_campaign_unique`, plus a guarded ensure of `email_accounts_id_organization_unique` (originally from 039).

## How materialization stays separate from `processed_at`

Phase 19 `processed_at` records reply/bounce **classification** side-effects; the Phase 21 lifecycle records whether the staged event has become a conversation **message**. They live in disjoint columns, and the claim query keys only on `materialization_status` (`pending` OR stale `processing`), never on `processed_at`. The DB test proves both directions: an event with `processed_at` set is still materialization-claimable, and an event flipped to `materialized` (with a linked message) can keep `processed_at = NULL`. Materialized rows must carry both `materialized_at` and a `conversation_message_id` (`materialized_requires_message` CHECK), and the lease compare-and-swap yields exactly one winner while an expired lease is reclaimable and increments attempts; `failed` is a terminal state excluded from the claim.

## How dedupe prevents duplicate messages

The dedupe identity is the immutable provider-native `source_key` (e.g. `native:<uuid>`, `imap:<uidvalidity>:<uid>`, `outlook:<id>`, `outreach-email:<uuid>`), enforced by the unique `(organization_id, email_account_id, source_key)` index. Provider replay resolves to the same `source_key` and conflicts on insert. RFC `Message-ID` is stored and indexed for threading but is **not** unique — the test inserts two messages sharing one `internet_message_id` under different source keys and both persist. One provider event also maps to at most one normalized message via the partial unique `materialized_message` link.

## RLS caveat

RLS is enabled on all four new tables with `SELECT` org-membership policies (`is_org_member(organization_id) OR is_platform_admin()`) as defense-in-depth only. The application connects with the `DATABASE_URL` role, which **bypasses RLS**; tenant isolation is enforced in JS (`src/server/lib/access.ts` + the Phase 20 outreach access helper) and by the composite FKs. Writes (including read-state upserts) go through the server role, so no end-user INSERT/UPDATE policy is added.

## Phase 19 staging linkage

Phase 21 **consumes and extends** the Phase 19 contract rather than forking it: `outreach_provider_cursors` is untouched (a mirror test asserts exactly one `pgTable('outreach_provider_cursors')` declaration), and `outreach_provider_events` gains only additive, safe-default columns — verified by re-running the existing 039 provider-event, claim, retry, and native-tenancy DB suites (21/21 pass). A normalized message links back to its event by `source_key`; the event links forward by `conversation_message_id`.

## Task Commits

1. **Task 1: failing schema tests + provider-neutral contracts** - `4daea67` (test)
2. **Task 2: hand-authored foundation migration 041** - `6ef5649` (feat)
3. **Task 3: Drizzle mirror + types refinement + mirror test** - `78a28db` (feat)

_TDD: RED (`4daea67`) → GREEN migration (`6ef5649`) → GREEN mirror (`78a28db`)._

## Files Created/Modified

- `supabase/migrations/041_unified_inbox_foundation.sql` - Four foundation tables, composite tenant FKs, dedupe/thread/attribution/unread indexes, provider-event materialization lifecycle, defense-in-depth RLS. Idempotent (re-runnable).
- `src/db/schema.ts` - Drizzle mirror: materialization lifecycle on `outreachProviderEvents`; four new pgTables, relations, and inferred types.
- `src/server/lib/unified-inbox/types.ts` - Provider-neutral conversation/message/read-state contracts; runtime value lists bound to schema unions via `satisfies`.
- `src/server/lib/unified-inbox/__tests__/schema.db.test.ts` - 18 disposable-database assertions (org scope, tenant-leading indexes, dedupe, non-unique RFC id, cross-tenant FK rejection, materialization lifecycle, drift mirror).

## Decisions Made

See `key-decisions` frontmatter. Notably: materialization lifecycle is a distinct column set (never `processed_at`); `source_key` is the dedupe key (RFC Message-ID stays non-unique); campaign_lead tenant safety flows through its campaign; the thread-order index uses a COALESCE expression in SQL while the Drizzle 0.30.4 mirror lists plain columns.

## Deviations from Plan

**None** in the sense of unplanned scope changes — the plan was executed as written. Two design resolutions worth recording (both within the plan's stated latitude of "composite tenant FKs OR trigger checks" and the SQL-vs-Drizzle mirror split):

1. **campaign_lead tenant binding via composite `(campaign_lead_id, campaign_id)` FK + requires-campaign CHECK**, because `campaign_leads` has no `organization_id`. The plan's explicit hard cross-tenant list (account/lead/campaign/user state) is DB-enforced; campaign_lead is additionally protected transitively through its (org-bound) campaign.
2. **Thread-order index expression lives only in SQL.** `drizzle-orm@0.30.4`'s `index().on()` rejects `sql` expressions, so the mirror lists `(organization_id, conversation_id, received_at, id)` with a comment; the applied SQL keeps `COALESCE(received_at, sent_at, created_at)`. The mirror is type-level only and never applies constraints.

## Issues Encountered

- **Pre-existing Phase 19 db-test flake under full postgres load (out of scope).** The `npm run test` gate is stable at **439 passed / 1 failed**; the single failure is Phase 19's `outreach-inbound-claim.db.test.ts` concurrent-worker test hitting `deadlock detected` in `seedEvents`. Proven independent of this plan: running the postgres project with the Phase 21 file **excluded** (so migration 041 is never applied) reproduces the same deadlocks/timeouts across several Phase 19 suites, and the Phase 21 suite itself passes 18/18 deterministically in isolation and inside the full run. Root cause is shared-disposable-DB contention among the deliberately-concurrent Phase 19 suites (the reason `vitest.config.ts` already sets `fileParallelism: false`). Logged to `deferred-items.md` (DEF-21-A) for a future Phase 19 test-hardening task; not fixed here per the scope boundary.

## Deferred Issues

- **DEF-21-A** — see `.planning/phases/21-unified-inbox-foundation/deferred-items.md`.

## User Setup Required

None for this plan's automated verification. **Production rollout note:** migration 041 is written and tested against the disposable Postgres harness but is NOT applied to production. Manual apply (in order, after 038/039/040):

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/041_unified_inbox_foundation.sql
```

## Next Phase Readiness

- Data foundation is ready for **21-02 ingestion** (`ingestOutreachMessage` consuming `outreach_provider_events` via the materialization lifecycle, plus outbound `outreach_emails` materialization).
- Read APIs (**21-03/04**) can build the conversation list (tenant-leading `idx_outreach_conversations_list`), thread detail (thread index), unread count (read-state + `last_inbound_at`), and keyset cursor over `(last_message_at, id)`.
- No production migration is applied yet; keep 038→039→040→041 as an ordered manual deploy step.

## Self-Check: PASSED

- Files verified present: `041_unified_inbox_foundation.sql`, `types.ts`, `schema.db.test.ts`, `schema.ts`, `21-01-SUMMARY.md`, `deferred-items.md`.
- Commits verified present: `4daea67` (test), `6ef5649` (migration), `78a28db` (mirror).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 439 passed / 1 pre-existing unrelated flake (DEF-21-A). Plan's own suite: 18/18 PASS.

---
*Phase: 21-unified-inbox-foundation*
*Completed: 2026-07-16*
