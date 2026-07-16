---
phase: 21-unified-inbox-foundation
plan: 02
subsystem: api
tags: [outreach, unified-inbox, materializer, attribution, idempotency, lease, postgres, tdd]

# Dependency graph
requires:
  - phase: 21-unified-inbox-foundation (plan 01)
    provides: "Migration 041 — outreach_conversations/messages/participants/reads + provider-event materialization lifecycle columns; provider-neutral contracts in unified-inbox/types.ts"
  - phase: 19-provider-parity-and-deliverability
    provides: "outreach_provider_events durable staging + classification, the FOR UPDATE SKIP LOCKED inbound claim, and the DSN->auto-reply->reply classification order"
  - phase: 20-outreach-product-and-api-consistency
    provides: "canonical outreach access helper conventions (organization scoping)"
provides:
  - "materializeProviderEvent — one transactional, idempotent event->conversation materializer (src/server/lib/unified-inbox/ingest.ts)"
  - "attributeConversation — tenant/account-scoped thread + outreach attribution with match strategy/confidence (src/server/lib/unified-inbox/attribute.ts)"
  - "normalize.ts — one shared module for addresses, Message-ID/References tokens, subject roots, source keys, thread keys, previews, safe headers"
  - "materializeUnifiedInbox — bounded, leased staging consumer job scheduled every 5 min (src/server/jobs/materializeUnifiedInbox.ts)"
  - "processReplies durable reply-context reconciliation from the persisted normalized message"
affects: [21-03-read-api, 21-04-read-api, 22-unified-inbox-ux, 23-guarded-ai]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two independent lifecycles on one staging row: Phase 19 processed_at (classification side effects) vs Phase 21 materialization_status/lease/attempts (durable message) — never cross-claimed"
    - "DB-enforced idempotency: unique (organization_id, email_account_id, source_key) message key + FOR UPDATE event lock + 'materialized' short-circuit make replay/concurrent-claim produce one message"
    - "Attribution precedence In-Reply-To -> References(root-first) -> trustworthy provider thread -> bounded address heuristic; ambiguous (>1 campaign_lead) stays unattributed; never cross-org"
    - "Reference-root thread_key (rfc:<root>) converges every reply in a chain; lead:<id> for header-less address-heuristic threads; gen:<uuid> for truly unthreaded mail"
    - "Materialization enrichment of reply context is resilient (try/catch fallback to staged event bodies) so the reply job never breaks if migration 041 is absent"

key-files:
  created:
    - src/server/lib/unified-inbox/normalize.ts
    - src/server/lib/unified-inbox/attribute.ts
    - src/server/lib/unified-inbox/ingest.ts
    - src/server/jobs/materializeUnifiedInbox.ts
    - src/server/lib/unified-inbox/__tests__/normalize.test.ts
    - src/server/lib/unified-inbox/__tests__/ingest.db.test.ts
    - src/server/jobs/__tests__/materializeUnifiedInbox.db.test.ts
  modified:
    - src/server/jobs/processReplies.ts
    - src/server/jobs/index.ts

key-decisions:
  - "Two independent consumers of outreach_provider_events: processReplies keeps its processed_at classification lifecycle unchanged; the new materializeUnifiedInbox job drives the disjoint materialization_status lifecycle. The materializer never reads/writes/claims processed_at."
  - "Idempotency is DB-enforced, not hoped: source_key unique + FOR UPDATE + 'materialized' short-circuit. Even a stale-lease double-claim or concurrent materialize yields one message and one set of side effects."
  - "Ambiguous address heuristic = a lead enrolled in more than one campaign with recent outbound (leads are unique per (org,email), so a shared address never resolves two leads). Ambiguity stays unattributed rather than guessing a campaign."
  - "processReplies integration is a read-only ENRICHMENT (resolveReplyContextText) with a resilient fallback, not a materialization trigger — avoids nested-transaction/lease coupling with the withNextPendingEvent row lock and avoids breaking replies if 041 is not yet applied in prod."
  - "Materialization claim is org-wide in production (matching the Phase 19 classification queue); an optional organizationId scope was added for targeted reprocessing and to isolate the shared test database."

patterns-established:
  - "Every attribution query is scoped by BOTH organization_id AND email_account_id; the composite (id, organization_id) FKs from 041 are the DB backstop."
  - "New .db suites that leave rows with processed_at NULL must clean up (afterAll) because Phase 19's classification consumers claim org-wide."

requirements-completed: [UIF-02, UIF-03, UIF-05]

# Metrics
duration: 35min
completed: 2026-07-16
---

# Phase 21 Plan 02: Unified Inbox Materializer Summary

**One provider-neutral transaction turns each staged Phase 19 provider event into a deduplicated, attributed, immutable conversation message via a leased lifecycle that is completely independent of Phase 19's `processed_at` — replay, concurrent claim, and stale-lease recovery all resolve to one message and one side effect.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-16T12:04:47Z
- **Completed:** 2026-07-16T12:39:42Z
- **Tasks:** 3 (TDD)
- **Files:** 9 (7 created, 2 modified)

## Accomplishments

- **`normalize.ts`** — the single module every provider funnels through before lookup or persistence: address casing/bracket stripping/display-name capture, Message-ID + multi-token References tokenization, reply/forward subject roots (EN/PT/ES), deterministic `source_key`, thread keys (`rfc:<root>` / `lead:<id>` / `gen:<uuid>`), body previews, and a safe-header allow-list that drops credential-bearing headers.
- **`attribute.ts`** — `attributeConversation` resolves In-Reply-To → References (root-first) → trustworthy provider thread → bounded address heuristic, all scoped by org **and** account, recording match strategy + confidence. Ambiguous address matches stay unattributed and never cross an organization.
- **`ingest.ts`** — `materializeProviderEvent` runs one transaction: lock the event, short-circuit if already materialized, validate account↔org, normalize once, attribute, find/create the conversation, dedupe-insert the immutable message, upsert participants, advance the conversation summary, then flip the event's own `materialization_status` to `materialized` with the message link — never touching `processed_at`.
- **`materializeUnifiedInbox.ts`** — a bounded, leased consumer using one compare-and-swap claim (`FOR UPDATE SKIP LOCKED`) over the Phase 21 materialization columns, with attempt bounding to `failed` for poison events, wired into the scheduler at 5-minute cadence behind a named advisory lock.
- **`processReplies.ts`** — reply context now derives from the durable normalized message when it exists, with a resilient fallback to the staged event bodies.

## How the materializer stays idempotent and separate from `processed_at`

**Separate lifecycles.** Phase 19's `processed_at` records reply/bounce **classification** side effects; the Phase 21 columns (`materialization_status/lease_token/lease_expires_at/attempts/error/materialized_at/conversation_message_id`) record whether the event has become a durable **message**. `materializeProviderEvent` and the job read/write/claim **only** the Phase 21 columns; `processReplies`/`processBounces` still own `processed_at`. A DB test asserts both directions (an event with `processed_at` set is still materialization-claimable; a materialized event keeps `processed_at` NULL), and the job test asserts every materialized event ends with `processed_at IS NULL`.

**DB-enforced idempotency (three overlapping guards):**
1. The immutable message carries a unique `(organization_id, email_account_id, source_key)` — `source_key = <provider>:<providerMessageId>`, the provider-native identity, never the RFC Message-ID. Any replay collapses onto one row via `ON CONFLICT DO NOTHING`.
2. `SELECT ... FOR UPDATE` on the event serializes concurrent materializations of the same event; the loser, once unblocked, sees `materialization_status = 'materialized'` and short-circuits to `duplicate` with the same `conversation_message_id`.
3. The one-event↔one-message partial unique index (`conversation_message_id`) from 041 makes the link 1:1.

Tests prove replay returns the same message id with `inserted:false`, two concurrent materializations insert exactly one message, and a stale-lease reclaim increments `attempts` and still yields one message.

## Attribution strategy order + confidence recording

Resolution stops at the first hit, each query scoped by org **and** account:
1. **In-Reply-To** → normalized `internet_message_id` of an existing conversation message (reuse its conversation), else an `outreach_emails.message_id` (attribute lead/campaign/campaign_lead, thread by reference root). `match_confidence = high`.
2. **References**, each token root-first, same two lookups. `high`.
3. **Trustworthy provider thread id** (native/Graph only; IMAP/'smtp' excluded) → existing conversation. `medium`.
4. **Bounded address heuristic** — same org+account, known lead address, outbound within a configurable lookback (default 30 days), newest. `low`, thread key `lead:<leadId>`.
5. **Unattributed** — `match_strategy = none`, confidence null, thread key from the reference root if any (so replies still converge) else a generated UUID.

Both `match_strategy` and `match_confidence` are persisted on every message for auditability.

## How cross-org attachment is prevented

- Every attribution lookup filters on `organization_id = <event.organization_id>` **and** `email_account_id = <event.email_account_id>`; the header/heuristic joins add `leads.organization_id = outreach_emails.organization_id`. A lead address shared across organizations (`alice@lead.test` in org A and org B) resolves only the receiving org's lead — a DB test asserts the conversation lands in org A and nothing is written under org B.
- Ambiguity is left unattributed rather than guessed: because `leads` is unique per `(organization_id, email)`, a shared address resolves one lead; the real ambiguity is a lead enrolled in more than one campaign (multiple distinct `campaign_lead_id`), which produces an unattributed (`none`) conversation.
- The materializer additionally re-validates that the event's `email_account_id` still belongs to its `organization_id` before any lookup, and migration 041's composite `(id, organization_id)` FKs are the database backstop.

## Reply-context integration (no Phase 19 regression)

`processReplies.handleReplyEvent` sources `lastReplyText` from the persisted normalized message (`resolveReplyContextText`, keyed by the event's `source_key`) and falls back to the staged event bodies. It is a strict **read-only enrichment**: it never re-invokes reply counters, notifications, or follow-up scheduling (those stay gated by Phase 19's `processed_at` + `wasAlreadyReplied`), and its lookup is wrapped so that a missing Unified Inbox table (migration 041 not yet applied in production) or any read error falls back silently — reply processing can never break.

## Final gate counts

- `npm run test`: **474 passed / 474** (39 files), run twice for determinism. +34 new tests (17 normalize + 11 ingest.db + 6 materializeUnifiedInbox.db).
- `npm run build`: PASS (client + server).
- `npm run lint`: PASS (0 warnings).
- `tsc -p tsconfig.server.json --noEmit`: PASS. `tsc -p tsconfig.json --noEmit` (client): PASS.
- No new migration (schema is from 041). No production DB touched.

## Task Commits

1. **Task 1 — failing suites (RED):** `6183d89` (test)
2. **Task 2 — normalize + attribute + ingest (GREEN):** `e055c4c` (feat)
3. **Task 3 — job + reply context + scheduler (GREEN):** `ac81138` (feat)
4. **Shared-DB test isolation fix:** `200927a` (fix)

_TDD: RED (`6183d89`) → GREEN materializer (`e055c4c`) → GREEN job (`ac81138`)._

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] Shared-disposable-DB cross-suite pollution via the org-wide materialization claim**
- **Found during:** Task 3 full-suite gate.
- **Issue:** Materialized events keep `processed_at` NULL by design; left in the shared test database they were claimable by Phase 19's org-wide classification consumers, which deterministically failed `outreach-inbound-claim.db.test.ts` (a second loop iteration onto a leftover `bounce` event let the hardcoded observer see the already-processed `crash-1`). Symmetrically, my job's global claim grabbed other suites' staged events.
- **Fix:** Added an optional `organizationId` scope to the materialization claim (unset = org-wide in production, as designed; set for the job test and available for targeted operational reprocessing), and `afterAll` cleanup in both new `.db` suites so they never pollute Phase 19's global queues.
- **Files modified:** `materializeUnifiedInbox.ts`, `materializeUnifiedInbox.db.test.ts`, `ingest.db.test.ts`. **Commit:** `200927a`.

**2. [Rule 3 - Blocking] `materializeUnifiedInbox.ts` was not importable without `DATABASE_URL`**
- **Found during:** Task 3 first job-test run.
- **Issue:** A top-level `cron-lock` import eagerly loaded `src/db` (throws `Missing DATABASE_URL`), breaking collection of the postgres-project test (which uses `XMAIL_TEST_DATABASE_URL`).
- **Fix:** Made the `cron-lock` import lazy inside `runMaterializerWithLock` (the materializer function already lazy-imports the query client only when no `sql` is injected). **Commit:** `ac81138`.

### Design resolutions within plan latitude

- **processReplies is a read-only reconciliation, not a materialization trigger.** The plan's "reconcile lastReplyText from the persisted normalized message" was implemented as an enrichment with a resilient fallback rather than having `processReplies` claim/drive materialization inline — this avoids a nested-transaction/lease deadlock against the `withNextPendingEvent` row lock and avoids a production break where migration 041 is not yet applied (038–041 are still pending manual apply per STATE.md).
- **Ambiguity redefined to the DB reality.** The plan's "two leads, same email" ambiguity is impossible under the existing `leads (organization_id, email)` unique constraint, so ambiguity is defined as one lead across multiple campaigns (multiple `campaign_lead_id`), which still yields an unattributed conversation.
- **Provider thread tier is present but dormant for inbound events**, since `outreach_provider_events` carries no `provider_thread_id`; the tier is wired for future/outbound use and passes `null` today.

## Known Stubs

None. Every module is wired: `materializeProviderEvent` and `attributeConversation` are exercised end-to-end by `ingest.db.test.ts`, the job by `materializeUnifiedInbox.db.test.ts`, and the job is scheduled in `jobs/index.ts`. Outbound `outreach_emails` materialization (the `outreach-dispatch.ts` hook + backfill described in RESEARCH/CONTEXT) is intentionally out of this plan's `files_modified` and belongs to a later plan; inbound reply attribution already matches against `outreach_emails.message_id`, so threading does not depend on outbound materialization existing yet.

## Self-Check: PASSED

- Files verified present: `normalize.ts`, `attribute.ts`, `ingest.ts`, `materializeUnifiedInbox.ts`, `normalize.test.ts`, `ingest.db.test.ts`, `materializeUnifiedInbox.db.test.ts` (all FOUND).
- Commits verified present: `6183d89` (test), `e055c4c` (feat), `ac81138` (feat), `200927a` (fix).
- Gates: server `tsc` PASS, client `tsc` PASS, `npm run lint` PASS (0 warnings), `npm run build` PASS, `npm run test` 474/474 (twice).

---
*Phase: 21-unified-inbox-foundation*
*Completed: 2026-07-16*
