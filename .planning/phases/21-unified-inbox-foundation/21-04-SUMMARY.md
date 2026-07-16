---
phase: 21-unified-inbox-foundation
plan: 04
subsystem: api
tags: [outreach, unified-inbox, read-api, keyset-cursor, pagination, rbac, tenant-isolation, tdd, postgres]

# Dependency graph
requires:
  - phase: 21-unified-inbox-foundation (plan 01)
    provides: "Migration 041 conversation tables (outreach_conversations/messages/participants/reads) + tenant-leading list/thread/unread indexes; provider-neutral contracts in unified-inbox/types.ts"
  - phase: 21-unified-inbox-foundation (plan 02)
    provides: "materializer that populates conversations/messages/participants and the per-message summary columns (last_message_at/last_inbound_at/last_message_id/latest_message_preview) the read API projects"
  - phase: 21-unified-inbox-foundation (plan 03)
    provides: "provider adapters + outbound materialization + backfill that make the read tables non-empty in production"
  - phase: 20-outreach-product-and-api-consistency
    provides: "canonical outreach access helper (requireOutreachRead / checkOutreachAccess) — the sole tenant boundary this API authorizes against"
  - phase: 19-provider-parity-and-deliverability
    provides: "outreach_provider_cursors (last_success_at/last_error/last_error_at/retry_at) consumed for the sanitized sync-status summary"
provides:
  - "GET /api/outreach/unified-inbox/conversations — opaque filter-bound keyset cursor (max 100), unread/status/campaign/account filters + bounded escaped keyword search, lightweight bodiless projection"
  - "GET /api/outreach/unified-inbox/conversations/:id — full ordered thread + attribution + participants (existence-safe 404)"
  - "GET /api/outreach/unified-inbox/unread-count — per-user org-scoped unread count"
  - "PATCH /api/outreach/unified-inbox/conversations/:id/read-state — { read } per-user idempotent mutation"
  - "cursor.ts — validated, opaque, filter-fingerprint-bound keyset cursor codec (encodeConversationCursor/decodeConversationCursor)"
  - "queries.ts — tenant-first list/detail/unread projections + idempotent read-state upsert + sanitized per-account sync status"
affects: [22-unified-inbox-ux, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Opaque keyset cursor = base64url envelope carrying (last_message_at::text, id) + a SHA-256 fingerprint of the canonical filter set; decode recomputes the fingerprint from the CURRENT request filters and rejects any mismatch, so a cursor cannot be replayed under a different filter/search/organization"
    - "Lossless keyset timestamp: the cursor stores last_message_at::text (microsecond precision) and the next-page predicate casts it back with ::timestamp, so ties at now()-microsecond granularity still paginate deterministically under (last_message_at DESC, id DESC)"
    - "Existence-safe cross-tenant reads: every route authorizes organizationId FIRST (requireOutreachRead), then scopes the id query to that org — an id in another tenant returns the SAME 404 as a missing id (no 403-vs-404 existence leak); a non-member of the org gets 403 before any data query"
    - "Per-user read state: unread = last_inbound_at IS NOT NULL AND NOT EXISTS(read row with last_read_at >= last_inbound_at for this user); mark-read upserts the user's row with a GREATEST watermark (idempotent no-op on repeat), mark-unread deletes only that user's row"
    - "Bodiless list projection + on-demand hydrate: list selects summary/preview/attribution/participants/unread only (never plain_body/html_body/credentials); the single-conversation detail is the only endpoint that returns full bodies and the stored safe-header subset"

key-files:
  created:
    - src/server/lib/unified-inbox/cursor.ts
    - src/server/lib/unified-inbox/queries.ts
    - src/server/routes/outreach/unified-inbox.ts
    - src/server/lib/unified-inbox/__tests__/cursor.test.ts
    - src/server/routes/outreach/__tests__/unified-inbox.db.test.ts
  modified:
    - src/server/routes/outreach/index.ts

key-decisions:
  - "Cursor is filter-bound but NOT a capability token: tenant authorization stays in requireOutreachRead + the org-scoped WHERE clause. The fingerprint only guarantees a cursor is used with the query that produced it; a truncated SHA-256 is sufficient because a collision only weakens cross-filter replay, never tenant isolation."
  - "Detail/read-state require ?organizationId and authorize it BEFORE the id lookup (option A), rather than looking the row up first and authorizing its org (option B, used by leads.ts). Option A is the only one that satisfies the plan's 'org A cannot distinguish missing from org B conversation' — option B leaks existence via 403-vs-404."
  - "read=true sets last_read_at to the conversation's last_message_at (watermark), not now(): marking read twice with unchanged conversation state is a true no-op, and a later inbound (last_inbound_at > watermark) correctly flips the conversation back to unread."
  - "Sanitized sync-status is embedded in the list response (keeping the locked 4-endpoint contract) and exposes only emailAccountId/provider/lastSuccessAt/degraded/errorCategory — NEVER delta_cursor, uid state, lease tokens, or raw error text (categorizeSyncError maps raw errors to a coarse label)."
  - "queries.ts uses the shared drizzle db (relative import) so the route .db test's process.env.DATABASE_URL swap takes effect, matching the established leads-query.db.test pattern; raw SQL fragments reference the unquoted lowercase table/column names of the default (unaliased) drizzle FROM."

patterns-established:
  - "New route .db suites apply 038/039/041 in beforeAll and DELETE their own conversation/message/participant/read/cursor rows in afterAll (shared disposable DB persists between suites)."
  - "Keyset list pagination for reorder-prone collections: order (sortKey DESC, id DESC), cursor carries a lossless sortKey text + id, predicate is (sortKey < :ts OR (sortKey = :ts AND id < :id))."

requirements-completed: [UIF-04, UIF-05]

# Metrics
duration: 17min
completed: 2026-07-16
---

# Phase 21 Plan 04: Unified Inbox Read API Summary

**The four locked Unified Inbox read endpoints ship as a tenant-first, bodiless-list / full-detail contract behind an opaque keyset cursor that is cryptographically bound to its filter set, with per-user idempotent read state and cross-tenant reads that return an existence-safe 404 — 519/519 tests green.**

## Performance

- **Duration:** ~17 min
- **Started:** 2026-07-16T15:13:56Z
- **Completed:** 2026-07-16T15:30:18Z
- **Tasks:** 3 (TDD)
- **Files:** 6 (5 created, 1 modified)

## API contract as built

All under `/api/outreach/unified-inbox`, mounted inside the outreach router (JWT/service auth + rate limits inherited). Every route requires `?organizationId=<uuid>` and authorizes it via `requireOutreachRead` before touching data.

| Endpoint | Method | Query / body | Success shape |
| --- | --- | --- | --- |
| `/conversations` | GET | `organizationId`, `limit`(1–100, def 25), `cursor?`, `unread?`(true/false), `status?`(open/closed), `campaignId?`, `emailAccountId?`, `search?`(≤200) | `{ conversations: ConversationListItem[], nextCursor, hasMore, count, syncStatus }` |
| `/conversations/:id` | GET | `organizationId` | `{ conversation, participants[], messages[] }` (full ordered thread + bodies) |
| `/unread-count` | GET | `organizationId` | `{ unreadCount }` |
| `/conversations/:id/read-state` | PATCH | `organizationId`, body `{ read: boolean }` | `{ conversationId, read, unread }` |

- **`ConversationListItem`** (bodiless): `id, emailAccountId, leadId, campaignId, campaignLeadId, status, subject, preview, lastMessageAt, lastInboundAt, lastOutboundAt, unread, participants[]`. No message bodies.
- **Detail message DTO**: `id, direction, provider, subject, internetMessageId, inReplyTo, fromAddress, fromName, to/cc/bccAddresses, plainBody, htmlBody, headers (stored safe subset), attachments (metadata), hasAttachments, classification, matchStrategy, sentAt, receivedAt, createdAt`.
- **`syncStatus[]`**: `{ emailAccountId, provider, lastSuccessAt, degraded, errorCategory }` — sanitized; no provider cursor tokens/credentials.
- **Status codes**: 401 (no user) → 400 (missing/invalid organizationId or bad filter/limit/cursor-shape) → 403 (not an org member) → 404 (unknown or cross-tenant id) → 400 (filter-mismatched/malformed cursor).

## How the cursor is opaque + filter-bound + stable

- **Opaque**: wire form is `base64url(JSON{ v, f, t, i })`. The payload carries only a version, a filter **fingerprint** (hash), the lossless `last_message_at` text (`t`), and the tie-breaker `id` (`i`). Raw filter values (organization id, search text, etc.) never appear even after decoding — a cursor test asserts the organization id is absent from the decoded bytes and that the token is strict URL-safe base64 (no padding).
- **Filter-bound**: `f = sha256(canonical([organizationId, unread, status, campaignId, emailAccountId, search]))` truncated to 22 chars. `decodeConversationCursor` recomputes the fingerprint from the **current** request's filters and throws `ConversationCursorError` on mismatch → the route returns 400. Changing any filter, the search term, or the organization invalidates the cursor (proven per-field in the unit test and end-to-end in the route test).
- **Stable / keyset (not offset)**: ordering is `last_message_at DESC, id DESC`; the next-page predicate is `(last_message_at < :t::timestamp OR (last_message_at = :t::timestamp AND id < :i::uuid))`. `t` is stored as `last_message_at::text` (microsecond precision) and cast back with `::timestamp`, so even conversations whose `last_message_at` is a `now()` microsecond value paginate without drift. The route test walks all 15 org-A conversations (six sharing one 12:00 timestamp) with `limit=2` across 8 pages and asserts the exact expected order with zero duplicates or gaps.

## How read-state stays per-user and idempotent

- **Unread definition (per user)**: a conversation is unread for user U iff `last_inbound_at IS NOT NULL AND NOT EXISTS(read row for U with last_read_at >= last_inbound_at)`. A **stale** read (last_read_at before a newer inbound) correctly still counts as unread — proven by `CONV_STALE`.
- **Mark read**: upsert U's row on the unique `(organization_id, conversation_id, user_id)` key with `last_read_at = GREATEST(existing, conversation.last_message_at)`. Marking read twice is a no-op (watermark never moves backward, exactly one row) — the test asserts the unread count is unchanged and the read-row count stays 1.
- **Mark unread**: delete only U's row (idempotent; deleting nothing is a no-op).
- **Per-user isolation**: OWNER_A marking `CONV_TOP` read drops OWNER_A's count (14→13) while USER2_A's count stays 15; USER2 sees `CONV_READ` as unread while OWNER (who read it) sees it read.

## How every route enforces tenant scope (no existence leak)

`authorizeOrganization()` runs first on all four routes: 401 if unauthenticated, 400 if `organizationId` missing/invalid, then `requireOutreachRead(organizationId)` (403 for a non-member, before any query). Only then does the handler run an org-scoped query. Consequences proven by tests:

- A non-member (OWNER_A against ORG_B, and an org-less OUTSIDER) gets **403** on list/detail/unread/read-state — before any data is read.
- An org-A member requesting an org-B conversation id **under org-A scope** gets **404**, byte-identical to a genuinely missing id (`crossTenant` and `missing` both 404; org B's subject never appears in the body).
- ORG_B admin lists only `CONV_B` and is 403 on ORG_A.
- Secrets never serialize: the seeded SMTP password and Graph delta-cursor sentinels appear in **no** list or detail response body.

## Final gate counts

- `npm run test`: **519 passed / 519** (44 files), run TWICE deterministically. +25 over the 21-03 baseline of 494 (7 `cursor.test.ts` unit + 18 `unified-inbox.db.test.ts` route).
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings).
- `tsc -p tsconfig.server.json --noEmit`: PASS. `tsc -p tsconfig.json --noEmit` (client): PASS.
- No new migration (schema is from 041). No production DB touched.

## Task Commits

1. **Task 1 — failing cursor + route contract/isolation suites (RED):** `3e27c29` (test)
2. **Task 2 — keyset cursor codec + tenant-first read projections (GREEN):** `b50c54e` (feat)
3. **Task 3 — mount the four routes under outreach auth (GREEN):** `2922bc9` (feat)

_TDD: RED (`3e27c29`) → GREEN codec/queries (`b50c54e`) → GREEN routes (`2922bc9`)._

## Files Created/Modified

- `src/server/lib/unified-inbox/cursor.ts` — opaque base64url keyset cursor bound to a SHA-256 filter fingerprint; strict validation (URL-safe base64, version, field types, fingerprint match) with `ConversationCursorError`.
- `src/server/lib/unified-inbox/queries.ts` — org-scoped list (keyset + escaped bounded search + per-user unread flag, bodiless), full-thread detail hydrate, unread count, idempotent per-user read-state upsert/delete, and sanitized per-account sync status.
- `src/server/routes/outreach/unified-inbox.ts` — the four locked endpoints; org authorization before any query; existence-safe 404; Zod-validated filters/body; cursor errors → 400.
- `src/server/routes/outreach/index.ts` — mounts the router at `/unified-inbox`.
- `src/server/lib/unified-inbox/__tests__/cursor.test.ts` — 7 unit assertions (round-trip, opacity/URL-safety, tie stability, per-field filter rejection, malformed/tampered/version/type rejection).
- `src/server/routes/outreach/__tests__/unified-inbox.db.test.ts` — 18 route assertions over a shared disposable Postgres (list order/filters/bounded search/no-bodies/no-secrets, keyset walk across ties, filter-bound + malformed cursor 400, full-thread detail, existence-safe 404, per-user idempotent read state + unread counts, viewer access, cross-tenant 403).

## Decisions Made

See `key-decisions` frontmatter. Notably: filter-bound (not capability) cursor with a lossless microsecond-precision keyset timestamp; authorize-org-before-id-lookup to make cross-tenant detail a 404 (not a 403 existence leak); read watermark = conversation's last_message_at for true idempotency; sync-status embedded in the list response (keeps the locked 4-endpoint contract) with hard sanitization.

## Deviations from Plan

**None — plan executed exactly as written.** Two design resolutions within the plan's stated latitude:

1. **Detail/read-state require `?organizationId` and authorize it before the id lookup.** The plan says "return 404 for inaccessible conversation ids" and "never leak existence"; the only implementation that makes a cross-tenant id indistinguishable from a missing one is to authorize the org first and scope the id query to it (a lookup-then-authorize approach would return 403 for an existing-but-forbidden id, leaking existence). Documented as the primary isolation pattern.
2. **Sync-status is embedded in the list response rather than a 5th endpoint.** The plan asks for a "safe per-account sync status summary where useful" while 21-CONTEXT locks exactly four endpoints; embedding a sanitized `syncStatus` array in the list payload honors both. It exposes no cursor tokens/credentials/raw error text.

## Issues Encountered

- **Self-inflicted (fixed before any RED run): malformed test UUIDs.** The first draft of the route test built ids with a 10-hex final group (invalid UUID) and interpolated a partial-id prefix followed by literal digits inside a `sql` template (would have produced invalid SQL). Both were corrected to a `U(n)` helper that pads to a legal 12-hex final group and binds each id as a single `::uuid` parameter, before the suite was ever committed. No functional deviation.
- **DEF-21-A** (pre-existing Phase 19 concurrent-claim db flake under full postgres load) did NOT manifest in either full run this plan (519/519 twice). Still tracked in `deferred-items.md`.

## User Setup Required

None for this plan's automated verification. Production still requires the accumulated manual migration apply (038→039→040→041 in order) before these read tables carry data; no new migration was introduced.

## Next Phase Readiness

- **Phase 22 (Unified Inbox UX)** has a stable, documented read contract: bodiless list with opaque `nextCursor`/`hasMore` + `syncStatus`, full-thread detail hydrate, per-user unread count, and an idempotent read-state toggle. All DTOs are explicit TypeScript shapes in `queries.ts`.
- Reply/forward/actions remain Phase 22 (this plan is read-side only apart from read state).
- No production migration is applied yet; keep 038→039→040→041 as an ordered manual deploy step.

## Self-Check: PASSED

- Files verified present: `cursor.ts`, `queries.ts`, `unified-inbox.ts`, `cursor.test.ts`, `unified-inbox.db.test.ts` (all FOUND); `outreach/index.ts` modified.
- Commits verified present: `3e27c29` (test), `b50c54e` (feat), `2922bc9` (feat).
- Gates: client `tsc` PASS, server `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 519/519 (twice).

---
*Phase: 21-unified-inbox-foundation*
*Completed: 2026-07-16*
