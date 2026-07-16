---
phase: 21
phase_name: unified-inbox-foundation
status: passed
score: "5/5 requirements (UIF-01..05); 43/43 declared must-haves"
verified_at: "2026-07-16T16:05:00Z"
verifier: gsd-verifier
---

# Phase 21 Verification — Unified Inbox Foundation

## Verdict

**Passed.** The implementation satisfies the Phase 21 goal and `UIF-01` through `UIF-05`. This verdict rests on direct source inspection and fresh, twice-run verification gates, not on the plan summaries.

Deduplicated, org-scoped conversation/message/participant/read-state tables exist and are enforced in the database by composite `(id, organization_id)` foreign keys; a leased materialization lifecycle turns Phase 19 staged events into immutable normalized messages in one transaction with DB-enforced idempotency that is fully disjoint from Phase 19's `processed_at`; attribution matches scoped Message-ID/References first and a bounded address heuristic last, never crossing an organization; native/IMAP/Outlook stage equivalent metadata-only fields through one shared adapter boundary; outbound sends materialize best-effort after durable sent-state; a restart-safe anti-join backfill closes crash windows without resending; and four tenant-first read endpoints expose an opaque filter-bound keyset cursor with per-user idempotent read state and existence-safe cross-tenant 404s.

Every requirement is backed by product code AND executing `.db`/unit tests — none rests on inference or documentation alone.

Two operational notes (correctly flagged, non-blocking, mirroring the Phase 18 stance): migrations 038→041 remain a manual production apply, and the Phase 21 code paths are designed to be dormant/self-healing until that apply happens.

## Fresh verification evidence

| Check | Result |
|---|---|
| Full suite, run 1 | `npm run test` — **44 files, 519 tests passed**, exit 0 (47.5s) |
| Full suite, run 2 (determinism) | `npm run test` — **44 files, 519 tests passed**, exit 0 (48.2s) — byte-identical pass/fail to run 1 |
| Phase 21 suites within the run | 9 suites, **94 tests**: `schema.db`(18), `normalize`(17), `ingest.db`(11), `materializeUnifiedInbox.db`(6), `providers.db`(5), `outbound.db`(7), `backfillUnifiedInbox.db`(5), `cursor`(7), `unified-inbox.db`(18) — all green in both runs |
| Production build | `npm run build` — exit 0; Vite client built + `tsc -p tsconfig.server.json` server built |
| Lint | `npm run lint` — exit 0, **zero warnings** (`--max-warnings 0`) |
| Client typecheck | `tsc --noEmit -p tsconfig.json` — exit 0 |
| Server typecheck | `tsc --noEmit -p tsconfig.server.json` — exit 0 |
| Migration 041 on disposable harness | `schema.db.test.ts:48-53` applies 039 then **041 twice** (idempotency) via the Phase 18 guarded harness URL; 18/18 assertions pass |
| Migration 041 NOT in prod / not auto-applied | `.github/workflows/*.yml` contain **no** `psql`/migration/`db:push`/`drizzle-kit` step (empty grep); `STATE.md:45` explicitly flags 038–041 as "written + tested… but NOT applied to production… manual deploy step, in ascending order" |
| Schema mirror ↔ 041 | `schema.ts:1603-1652,1715-1931` mirrors every table/column/lifecycle field; `schema.db.test.ts:631-693` asserts the mirror contains each 041 identifier and that exactly **one** `outreach_provider_cursors` pgTable exists (no forked cursor system) |
| Anti-pattern scan | No `TODO/FIXME/placeholder/not implemented/stub` in any Phase 21 production file |

Determinism, itself a Phase 21 deliverable, holds: two full runs produced identical green results. The postgres project runs against a per-run Testcontainers database (`xmail_test_*`) with `max_connections=300`, root-level `fileParallelism:false`, and each `.db` suite self-applying the migrations its seed depends on.

## Requirement matrix

| Requirement | Status | Evidence |
|---|---|---|
| `UIF-01` — durable, tenant-safe conversation/message/participant/read-state + provider lifecycle tables | PASS | Four org-scoped tables with `organization_id NOT NULL` at `supabase/migrations/041_unified_inbox_foundation.sql:119,285,475,532`. Cross-tenant links blocked in the DB via composite `(id, organization_id)` FKs: account/org `041:170`, lead/org `041:183`, campaign/org `041:196`, campaign_lead→campaign `041:213`, message→conversation/org `041:355`, reads→conversation/org `041:561`, last-message self-ref `041:465`. Dedupe on the provider-native `source_key` (unique `(organization_id, email_account_id, source_key)` `041:436`), while RFC `internet_message_id` is indexed but **deliberately non-unique** `041:445`. Materialization lifecycle is a **disjoint** column set (`materialization_status/lease/attempts/error/materialized_at/conversation_message_id`) `041:607-620` with a claim index keyed only on `materialization_status` `041:674`; `processed_at` is never referenced by it. Tenant-leading indexes for list/thread/attribution/unread/source-id `041:253-280,436-456,594-599`. Provider staging stays the single boundary: 041 only ALTERs `outreach_provider_events` and adds no second cursor table (`schema.db.test.ts:688`). 18 schema `.db` assertions pass. |
| `UIF-02` — native/IMAP/Outlook persist full normalized messages idempotently (bodies, headers, attachment metadata, direction) | PASS | One provider-neutral transaction: `materializeProviderEvent` (`ingest.ts:163-370`) locks the event `FOR UPDATE` (`ingest.ts:172`), normalizes once via the shared module, inserts the immutable message with `ON CONFLICT (organization_id, email_account_id, source_key) DO NOTHING` (`ingest.ts:289`), and short-circuits an already-`materialized` event (`ingest.ts:188-202`) — replay and concurrent claim both yield one message. Three provider adapters produce the same `NormalizedInboundMessage` and are the live staging path (`outreach-inbound-sources.ts:113,215,290`): native row, raw-MIME ParsedMail (`imap.ts`, full `SAFE_HEADER_ALLOW_LIST`), Graph delta (`outlook.ts`). Attachments are metadata-only descriptors — `imap.ts:79-89` / `outlook.ts:78-88` map only `providerId/name/mimeType/size/inline/contentId`, never `content`/bytes. Direction is set at materialization (`ingest.ts:281` inbound; `outbound.ts:238` outbound). Suites: `ingest.db`(11), `providers.db`(5), `materializeUnifiedInbox.db`(6). |
| `UIF-03` — attribution to org/account/lead/campaign/outreach-email via Message-ID/References + bounded heuristic | PASS | `attributeConversation` (`attribute.ts:81-230`) resolves in order: In-Reply-To → References(root-first) → trustworthy provider thread (native/outlook only, `attribute.ts:54,149`) → bounded address heuristic (`attribute.ts:176-211`, default 30-day lookback, newest) → unattributed. Every lookup is scoped by **both** `organization_id` and `email_account_id` (`attribute.ts:102-104,127-129,184-186`); the heuristic joins `leads.organization_id = outreach_emails.organization_id` (`attribute.ts:183`). Ambiguous (>1 distinct `campaign_lead`) stays unattributed rather than guessed (`attribute.ts:195-196`). Strategy + confidence persisted on every message (`ingest.ts:287`). Classification is carried from the Phase-19 event (`ingest.ts:281,287`); the materializer never re-invokes reply/bounce/auto-reply counters, notifications, or follow-ups (`ingest.ts:9-11`), so DSN/auto-reply classification (owned by ingestion order) precedes any human-reply side effect. Cross-org isolation asserted in `ingest.db.test.ts`. |
| `UIF-04` — org-scoped list/detail/filters/search/unread + read/unread with cursor pagination | PASS | Four locked routes at `unified-inbox.ts:71,119,134,158` mounted at `/api/outreach/unified-inbox` (`outreach/index.ts:35`). List is bodiless, `limit` 1–100 default 25 (`unified-inbox.ts:36`), ordered `last_message_at DESC, id DESC` with a keyset predicate (`queries.ts:248-252,273`), unread/status/campaign/account filters + escaped bounded ILIKE search (`queries.ts:169-185,234-242`). Detail returns the full thread ordered by `COALESCE(received_at, sent_at, created_at)` then id (`queries.ts:374-377`). Unread-count is per-user org-scoped (`queries.ts:411-420`). Read-state PATCH is idempotent — `GREATEST` watermark upsert on the unique `(org, conversation, user)` key, mark-unread deletes only the caller's row (`queries.ts:450-486`). Cursor is opaque base64url `{v,f,t,i}` carrying no raw filters, **filter-bound** by a SHA-256 fingerprint recomputed from the current request (`cursor.ts:77-135`) → replay under any changed filter/search/org throws → route 400 (`unified-inbox.ts:107`). Suites: `cursor`(7), `unified-inbox.db`(18). |
| `UIF-05` — jobs/APIs/DB access enforce tenant boundaries and expose cursors/errors without leaking content | PASS | Every route calls `authorizeOrganization` → `requireOutreachRead` BEFORE any data query (`unified-inbox.ts:54-68,73,121,136,160`); a cross-tenant id returns a **404 identical to a missing id** (org-first WHERE, `queries.ts:335-338`), a non-member gets 403 pre-query (`outreach-access.ts:91-95`). Viewers get read + own-read-state: `requireOutreachRead` grants any org member regardless of role (`outreach-access.ts:41-55,91`), read-state mutation is scoped to `userId` (`queries.ts:479-486`). Background jobs derive org scope from `email_accounts`: the materializer re-validates account↔org before any lookup (`ingest.ts:205-210`), outbound re-validates it (`outbound.ts:130-136`), and all attribution/backfill queries are org+account scoped. Operational surface is sanitized — `getAccountSyncStatus` exposes only `emailAccountId/provider/lastSuccessAt/degraded/errorCategory` (coarse `categorizeSyncError`), never delta cursors/UID state/lease tokens/raw error text (`queries.ts:505-544`). Logs across ingest/job/backfill carry ids/counters only, never bodies/addresses/credentials. |

## Declared must-have verification

### Plan 21-01 (schema / migration 041)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Conversation/message/participant/read-state rows explicitly org-scoped | PASS | `organization_id NOT NULL` on all four tables `041:121,287,477,534`; composite tenant FKs enumerated above. |
| Truth | Phase 19 staging/cursors remain the single ingestion boundary | PASS | 041 only extends `outreach_provider_events` (`041:607-676`); no new cursor table; mirror test asserts exactly one `outreach_provider_cursors` pgTable (`schema.db.test.ts:688`). |
| Truth | Materialization claims independent from `processed_at` | PASS | Disjoint columns `041:607-620`; claim index on `materialization_status` only `041:674`; `materialized_requires_message` CHECK `041:646`. |
| Truth | Replay + duplicate RFC Message-IDs cannot create duplicate normalized messages | PASS | Unique `(org, account, source_key)` `041:436`; `internet_message_id` non-unique `041:445`; asserted in `schema.db.test.ts`. |
| Truth | Tenant-leading indexes support list/thread/attribution/unread/source-id | PASS | `041:253-280,436-456,594-599`. |
| Artifact | `supabase/migrations/041_unified_inbox_foundation.sql` | PASS | 712-line hand-written, idempotent (`IF NOT EXISTS`, guarded constraints); applied twice to disposable Postgres. |
| Artifact | `src/db/schema.ts` mirror | PASS | Tables/columns/lifecycle at `schema.ts:1603-1652,1715-1931`; mirror-alignment test `schema.db.test.ts:631`. |
| Artifact | `src/server/lib/unified-inbox/types.ts` | PASS | Provider-neutral contracts present; enum unions bound with `satisfies`. |
| Key link | `messages.source_key` → provider event identity | PASS | `buildSourceKey` (`normalize.ts:153`) + unique key `041:436`; event↔message 1:1 partial unique `041:666`. |
| Key link | `materialization_status` → `conversation_message_id` CAS lifecycle | PASS | `041:607-676`; completed only after message commit (`ingest.ts:343-353`). |
| Key link | `outreach_conversation_reads` → users + conversations per-org | PASS | FKs `041:561,575,588`; unique `(org, conversation, user)` `041:594`. |

### Plan 21-02 (materializer / attribution / job)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | One provider-neutral transaction materializes staged events | PASS | `ingest.ts:163-370` single `sql.begin`. |
| Truth | Claims use Phase 21 lifecycle, never overload `processed_at` | PASS | Job claim keys on `materialization_status` (`materializeUnifiedInbox.ts:90-111`); update touches only `materialization_*` (`ingest.ts:343-353`). |
| Truth | Replay/concurrent consumption creates no duplicate or side effect | PASS | `FOR UPDATE` + `materialized` short-circuit + `ON CONFLICT DO NOTHING`; `ingest.db`/`materializeUnifiedInbox.db` prove same id, one participant/summary write. |
| Truth | Header/reference match first, bounded address heuristic last | PASS | `attribute.ts:95-211` tiered order; heuristic gated to lookback + single-lead. |
| Truth | DSN/auto-reply classified before human-reply effects | PASS | Classification carried from event; materializer invokes no reply side effects (`ingest.ts:9-11`). |
| Artifact | `ingest.ts` (`materializeProviderEvent`) | PASS | Exported, exercised end-to-end. |
| Artifact | `attribute.ts` | PASS | Org+account scoped attribution with strategy/confidence. |
| Artifact | `materializeUnifiedInbox.ts` | PASS | Bounded leased consumer; poison→`failed` after `MATERIALIZE_MAX_ATTEMPTS`; scheduled (`jobs/index.ts:139`). |
| Key link | job → `outreach_provider_events` CAS claim | PASS | `materializeUnifiedInbox.ts:90-111` `FOR UPDATE SKIP LOCKED`. |
| Key link | `ingest.ts` → `outreach_conversation_messages` unique source-key before side effects | PASS | `ingest.ts:271-338` (insert → participants/summary only when `inserted`). |

### Plan 21-03 (provider parity / outbound / backfill)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Native/IMAP/Outlook staged events carry equivalent normalized fields | PASS | Shared `NormalizedInboundMessage` via `providers/{native,imap,outlook}.ts`; `providers.db`(5) asserts equal ids/subject/from + one converged conversation + shared safe-header set. |
| Truth | Attachments metadata-only; no binary in Postgres | PASS | `imap.ts:79-89` / `outlook.ts:78-88` descriptor-only; `providers.db` asserts fixture blob bytes absent. |
| Truth | Cursor recovery bounded/resumable, never past an unpersisted event | PASS | Reuses Phase 19 cursor leases (adapters feed `ingestOutreachInbound`); recovery cases covered in `providers.db`. |
| Truth | Historical replies backfill restart-safely without duplicate effects | PASS | `backfillUnifiedInbox.ts` anti-join + `(sent_at,id)`/`(received_at,id)` keyset; `backfillUnifiedInbox.db`(5) "interrupted twice → same counts". |
| Truth | Every sent `outreach_email` → one outbound message `outreach-email:<id>` | PASS | `outbound.ts:39,110,222-242` unique source-key; `outbound.db`(7). |
| Truth | Inbound reply joins a live/backfilled outbound message's conversation | PASS | `outbound.ts:184-190` roots `rfc:<message-id>`; attribution tier-1 reuse; `outbound.db` + `backfill.db` assert 1 conversation / 2 messages. |
| Artifact | `providers/imap.ts` | PASS | Raw-MIME→event adapter with full allow-list. |
| Artifact | `providers/outlook.ts` | PASS | Graph delta→event adapter. |
| Artifact | `backfillUnifiedInbox.ts` | PASS | Bounded anti-join backfill, outbound-before-inbound, operator-invoked lock. |
| Artifact | `outbound.ts` (`materializeOutboundEmail`) | PASS | Idempotent; only durable `status='sent' && sent_at` (`outbound.ts:106`); never mutates the email. |
| Key link | adapters → `outreach_provider_events` equivalent fields | PASS | `outreach-inbound-sources.ts:113,215,290`. |
| Key link | backfill → `materializeProviderEvent` (reuse live path) | PASS | `backfillUnifiedInbox.ts:199-201`. |
| Key link | `outreach-dispatch.ts` → `outbound.ts` post-dispatch hook | PASS | `outreach-dispatch.ts:688-707` after `finalizeSent`, best-effort try/catch; `claim.rowId` is the `outreach_emails.id` (`outreach-dispatch.ts:500`). |

### Plan 21-04 (read API)

| Kind | Must-have | Status | Evidence |
|---|---|---|---|
| Truth | Authorized users list/filter/search + hydrate one ordered thread | PASS | `queries.ts:229-405`; `unified-inbox.db`(18). |
| Truth | Pagination opaque, stable, max-100, not reusable under a different filter set | PASS | `cursor.ts:77-135`; route 400 on mismatch (`unified-inbox.ts:107`). |
| Truth | Unread counts/read-state per user, mutations idempotent | PASS | `queries.ts:411-499`. |
| Truth | Every query starts from authorized org scope, no cross-tenant leak | PASS | `authorizeOrganization` first (`unified-inbox.ts:54-68`); org-first WHERE; 404==missing. |
| Artifact | `routes/outreach/unified-inbox.ts` | PASS | Four locked endpoints. |
| Artifact | `cursor.ts` (`encode/decodeConversationCursor`) | PASS | Opaque filter-bound keyset codec. |
| Artifact | `queries.ts` | PASS | Tenant-first list/detail/unread/read-state/sync-status. |
| Key link | route → `outreach-access.requireOutreachRead` before query | PASS | `unified-inbox.ts:65`. |
| Key link | list cursor → `(last_message_at,id)` keyset + fingerprint | PASS | `queries.ts:248-303` + `cursor.ts`. |

## Assessment of flagged deviations

| Item | Assessment |
|---|---|
| 21-02: `processReplies` implemented as read-only reply-context enrichment with fallback, not an inline materialization trigger | **Acceptable, and materialization is genuinely reachable.** The end-to-end path exists independently of the reply job: provider readers → adapters → `ingestOutreachInbound` (called by the scheduled `processReplies`/`processBounces` jobs, `processReplies.ts:168`, `processBounces.ts:360`) stage rows into `outreach_provider_events`; the dedicated `materializeUnifiedInbox` cron (`jobs/index.ts:139`, every 5 min) → `runMaterializerWithLock` → `materializeProviderEvent` consumes them. `resolveReplyContextText` (`processReplies.ts:104-140`) is a pure read with a resilient fallback to staged bodies, so an unapplied 041 in prod cannot break replies. Avoiding the inline trigger sidesteps a nested-transaction/lease deadlock against `withNextPendingEvent`. Sound. |
| 21-03: fixed clock-dependent time-bomb in `outlook-inbound.test.ts` | **Acceptable.** The fixture pinned `tokenExpiresAt` to a *simulated* NOW+1h while `getValidOutlookAccessToken` checks the *real* `Date.now()`; once wall-clock passed 13:00Z the token read as expired and every reader test spuriously hit the refresh path. The fix anchors expiry to real `Date.now()+60m` (`outlook-inbound.test.ts` diff). No test intent changed (refresh-path tests trigger via 401, not expiry). This is a legitimate determinism fix, exactly the kind Phase 21 targeted. |
| 21-04: `syncStatus` added to the list response beyond the locked 4 endpoints | **Acceptable within contract; no leak.** It is an embedded array on the existing list payload (not a 5th endpoint), and `getAccountSyncStatus` (`queries.ts:505-544`) emits only `emailAccountId/provider/lastSuccessAt/degraded/errorCategory` where `errorCategory` is a coarse label from `categorizeSyncError`. No cursor/delta tokens, UID state, lease tokens, credentials, or raw error text are serialized. |
| Determinism fix (a87ee0b): root `fileParallelism:false` + `max_connections=300` + notification-policy suite self-applying 038 | **Sound; exposed a latent test-coupling, hid no product issue.** The prior green depended on nondeterministic file order applying 038 elsewhere before the notification-policy seed wrote `outreach_emails.idempotency_key`; making the suite self-apply 024+038 (`outreach-notification-policy.db.test.ts` diff, idempotent under the shared advisory lock) removes that hidden cross-suite dependency. Serialization + connection headroom address shared-disposable-DB contention among deliberately org-wide job suites, not a product defect. Confirmed by two identical 519/519 runs. |
| Migrations 038–041 unapplied to production (manual psql step) | **Correctly flagged, not silently assumed applied.** No CI workflow applies migrations (empty grep over `.github/workflows/*.yml`); `STATE.md:45` and every 21-0x SUMMARY document the ascending manual apply. Non-blocking operational consequence: until applied, the outbound hook (best-effort, swallowed) and the 5-min materializer cron (`.catch`-wrapped) will no-op/log rather than break sends or replies — the reply-context read falls back. This is the same deferred-operational stance accepted for Phase 18. |

## Tenant-isolation audit

- Read routes authorize `organizationId` via `requireOutreachRead` before any query; cross-tenant conversation ids return 404 indistinguishable from missing (`unified-inbox.ts` + `queries.ts:335-338`), asserted in `unified-inbox.db.test.ts`.
- The materializer re-validates `email_accounts.organization_id === event.organization_id` before any lookup (`ingest.ts:205-210`) and throws otherwise; outbound does the same (`outbound.ts:130-136`).
- Attribution never crosses an organization: a lead address shared across orgs resolves only the receiving org's lead (org+account scoped joins, `attribute.ts:102-186`).
- Database backstop: composite `(id, organization_id)` FKs on every child table and attribution target (`041`), plus `campaign_lead→campaign` composite chaining to the org-bound campaign.

## Migration discipline

- 041 is a hand-written, sequential, idempotent SQL file; Drizzle is the TypeScript mirror only.
- No `drizzle-kit generate`, `db:generate`, or `db:push` was introduced (removed from `package.json` per prior phases; absent from this diff).
- Automated verification applies 041 only through the Phase 18 guarded disposable harness (explicit test URL), applied twice; production apply is an explicit operator prerequisite.

## Gaps

None found within Phase 21 scope. All five requirements and all 43 declared must-haves are backed by product code and executing tests.

## Human verification

None required to accept Phase 21. Live-provider ingestion (real IMAP UIDVALIDITY resets, Graph delta expiry against a live tenant), production migration application, and a real operator backfill run are explicitly deferred operational concerns, not unverified Phase 21 acceptance criteria. The equivalent behaviors are covered against disposable PostgreSQL.

---
_Verified: 2026-07-16T16:05:00Z_
_Verifier: Claude (gsd-verifier) — source inspection + fresh twice-run gates_

## Resolution addendum (2026-07-16, post review-fix)

The phase passed verification with no gaps. It also went through a full 3-lens code review
(`21-REVIEW.md`) — idempotency/concurrency, tenant-isolation/API, and requirements verification —
which found **0 critical**, 3 warnings, and 2 accepted design observations. All actionable warnings
were fixed and independently re-reviewed:

- **W-1 (cursor 400-not-500)** — a malformed keyset field in a fingerprint-valid cursor returned 500.
  Fixed by validating `t`/`i` shape in the codec. The re-review found the first fix used `Date.parse`,
  which accepts calendar-invalid dates (`2026-02-30`) that Postgres rejects — a residual (N-1) of the
  same defect. Closed with a strict validator (format regex + range gates + UTC calendar round-trip)
  that matches `timestamp::text` exactly while rejecting rolled-over dates. Real microsecond-precision
  cursors still decode.
- **W-2 (thread-split race)** — the cron materializer and the operator backfill used distinct advisory
  locks and could split a header-less-root non-outreach thread into two conversations if run
  concurrently. Fixed by pointing the backfill at the cron materializer's lock, making them mutually
  exclusive (one lock, deadlock-free). Campaign reply attribution was never affected. Re-review
  confirmed no in-tree caller depends on the old always-run behavior and skip-and-return is retry-safe.
- **O-1 (poison-event auto-recovery)** and **O-2 (inline outbound await)** — accepted as designed
  (poison-park is correct; inline await never delays the sent mail), documented, not changed.

**Fresh gates after fixes:** `npm run test` **527 passed (45 files)**, green and byte-identical on
repeat runs; build exit 0; lint 0 warnings; client and server `tsc --noEmit` both clean.

Phase 21 status remains **passed**, now with the review warnings resolved. The Unified Inbox
foundation (schema, provider-neutral materializer, cross-provider ingestion, outbound + backfill, and
the read API) is complete and safe to build the Phase 22 operator UX on top of.
