---
phase: 21
phase_name: unified-inbox-foundation
reviewed_at: "2026-07-16T13:30:00Z"
reviewers: 3 (idempotency/concurrency, tenant-isolation/API, requirements verification)
range: 1e22f17..b71ab04
status: minor_fixes
findings: 0 critical, 3 warnings, 2 observations
---

# Phase 21 Code Review

Three independent reviewers over `git diff 1e22f17..HEAD` (19 commits, ~8000 insertions).
Fresh gates green twice, byte-identical (519 tests across node/jsdom/Testcontainers-postgres,
build, lint 0 warnings, both tsc projects). The requirements verifier PASSED (UIF-01..05, 43/43
must-haves, no gaps).

**No CRITICAL findings across any lens.** The materialization design is genuinely solid: dedup is
DB-enforced on the provider-native `source_key` (not the RFC Message-ID), the Phase 21
materialization lifecycle is cleanly decoupled from Phase 19's `processed_at`, crash/replay/
concurrency windows resolve on `FOR UPDATE` serialization plus unique constraints, the backfill is
restart-safe and never resends, the outbound hook is best-effort after durable sent-state, and the
read API is tenant-safe by construction (org scope before every query, existence-safe 404s, cursor
is not a capability, attribution doubly org+account scoped, no content/secret leakage, search
escaped). This is the cleanest phase gate of the milestone.

The findings below are quality hardening, not correctness failures the tests missed in a
consequential way.

## WARNING

### W-1 — Malformed cursor field returns 500 instead of 400

`src/server/lib/unified-inbox/cursor.ts:129`, surfaced at `src/server/routes/outreach/unified-inbox.ts` (~:248).
`decodeConversationCursor` validates the keyset fields (`t`, `i`) are strings but not that they are a
valid timestamp / UUID. A cursor whose filter fingerprint matches (the fingerprint is unkeyed, so a
caller can recompute it for their own filters) but whose `t`/`i` are malformed passes decode, then
Postgres throws on the `::timestamp`/`::uuid` cast → caught by the generic handler → `500`. Impact is
a self-inflicted 500 on the caller's own request — no cross-tenant read, no injection, no data in the
response. Fix: validate the `t`/`i` shape in the codec and raise `ConversationCursorError` so the
route maps it to `400`. Cheap and clearly correct.

### W-2 — Concurrent cron + backfill can split one header-less thread into two conversations

`src/server/lib/unified-inbox/attribute.ts` + `ingest.ts:242-267`.
The scheduled materializer (`materializeUnifiedInbox`, advisory lock
`outreach-unified-inbox-materializer`) and the operator backfill (`backfillUnifiedInbox`, DISTINCT
lock `outreach-unified-inbox-backfill`) can run at the same time. For a thread whose root message
carries no In-Reply-To/References (so its `thread_key` is a generated `gen:<uuid>`), if the two jobs
process the root E1 and its reply E2 in overlapping READ COMMITTED transactions, E2's tier-1a lookup
does not see E1's uncommitted message, so E2 derives `rfc:<E1-message-id>` while E1 derives
`gen:<uuid>` — two `thread_key`s, one logical thread becomes two conversations.

Bounded: nothing is lost, duplicated, or resent — only grouping. Requires an operator-run backfill
overlapping the cron job, and only bites a header-less-root NON-outreach thread. Campaign reply
attribution is unaffected: an inbound reply to an outbound send converges out-of-order via tier-1b's
`rfc:<referenceRoot>` key matching the outbound message's key. Fix: make the backfill and the cron
materializer mutually exclusive (share one advisory lock, or have the backfill also hold the
materializer lock) so they cannot process events concurrently. Low-risk and fully closes the race.

### W-3 — (from security lens, same as W-1 root) cursor fingerprint is unkeyed

Recorded under W-1: the fingerprint is forgeable by design (the cursor is not a trust boundary — org
scope is enforced independently in the WHERE clause), so this is not a security defect. Noted only so
it is not re-raised. No action beyond W-1.

## Observations (accepted design, documented — not fixing)

### O-1 — Poison events have no automatic recovery cadence

An event that exhausts `maxAttempts` is parked `materialization_status='failed'` and is only
re-attempted by the operator-invoked backfill, never by the cron job. Its message is absent from the
unified inbox until someone runs the backfill (visible via `materialization_status='failed'` +
`materialization_error`). This is the correct poison-park pattern — automatic retry of a genuinely
poison event would spin forever. Accept as designed; a future ops cadence (periodic backfill, or an
alert on `failed` count) belongs to Phase 22/23 operations, not here.

### O-2 — Outbound hook is awaited inline

`outreach-dispatch.ts:698` awaits `materializeOutbound` inline, so a slow materialization adds latency
to the dispatch *return* — never to the already-sent mail (the hook runs strictly after `finalizeSent`
commits). Not a data-integrity issue. Keeping it awaited gives backpressure and deterministic tests;
the latency is local-DB fast. Accept as-is.

## Clean categories (recorded so they are not re-litigated)

- Duplicate messages/conversations — DB-enforced dedup on `(org, account, source_key)` via
  `ON CONFLICT DO NOTHING` + SELECT-fallback; migration 039's provider-event unique index means no two
  events share a source_key; concurrent materializers serialize on the event `FOR UPDATE`.
- processed_at vs materialization lifecycle — every `processed_at` reference in Phase 21 code is a
  comment only; the job claims solely on `materialization_status`, the Phase 19 consumer solely on
  `classification AND processed_at IS NULL`. Decoupling is real and complete.
- Lease/attempt correctness — atomic claim, stale-lease reclaim, bounded attempts, terminal failure;
  no forever-claim, no infinite retry, message + `materialized` commit in one transaction.
- Backfill restart-safety — keyset advances before the try, NOT EXISTS anti-join on the unique key,
  bounded batches, never touches `outreach_emails`, outbound-before-inbound ordering correct.
- Outbound hook safety — strictly after `finalizeSent`, swallowing try/catch, async import cannot
  throw synchronously into the send path; cannot fail or resend the mail.
- Cursor keyset — correct at timestamp ties (unique-id tiebreak), lossless `::text` round-trip,
  NULL-`last_message_at` unreachable.
- Migration 041 — constraints/partial indexes/CHECKs correct and idempotent on re-apply; schema.ts
  mirror matches; DEFAULT 'pending' backfill of historical events is intended.
- Tenant isolation — org scope resolved (via `requireOutreachRead`) before every query on all four
  routes; every query leads with `organization_id`; existence-safe 404; read-state per-user and
  keyed by verified `x-user-id`; attribution doubly org+account scoped, refuses to guess on >1
  campaign_lead; no cross-org attach (composite FKs are the DB backstop).
- Content/secret privacy — list projection is subject/preview only; detail bodies go only to an
  authorized member; `syncStatus` never selects delta_cursor/UID/lease/credentials and coarsens raw
  error text; stored headers allow-list filtered; no bodies/addresses/tokens in any log.
- Search injection — ILIKE term escaped (`\ % _`) and bound-parameterized; sort hardcoded; filters
  are bound `eq()`.

## Fix scope for this phase

Fix W-1 (cursor 400) and W-2 (backfill/cron mutual exclusion). Leave O-1 and O-2 as documented
design decisions. Re-review the two fixes, then close.
