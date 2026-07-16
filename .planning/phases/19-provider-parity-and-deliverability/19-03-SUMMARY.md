---
phase: 19-provider-parity-and-deliverability
plan: 03
subsystem: api
tags: [outreach, inbound, dsn, bounce, reply, imap, cursor, idempotency, migration]

# Dependency graph
requires:
  - phase: 18-outreach-safety-and-execution-reliability
    provides: Testcontainers postgres harness, advisory cron locks, cross-tenant matching regression tests
  - phase: 19-provider-parity-and-deliverability
    plan: 02
    provides: Provider adapter vocabulary (OutreachProviderName) reused unchanged
provides:
  - Durable provider-neutral inbound staging (outreach_provider_events) keyed by (org, account, provider, provider_message_id)
  - Bounded resumable ingestion cursors (outreach_provider_cursors) replacing user read state
  - Single classifier ordered DSN/bounce -> auto-reply -> human reply -> other
  - Reply/bounce consumers reading disjoint durable classifications
  - Full text/html bodies + attachment metadata retained for Phase 21
affects: [19-04, 21-unified-inbox, 22-operator-thread-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Classify once at ingestion; consumers read the decision, never re-derive it"
    - "Progress lives in a cursor the pipeline owns, never in state the user can flip"
    - "Ports with in-memory fakes keep ingestion logic unit-testable without a database"
    - "Cursor advances only after every message in the page is durably staged"

key-files:
  created:
    - supabase/migrations/039_outreach_provider_events.sql
    - src/server/lib/outreach-inbound.ts
    - src/server/lib/outreach-inbound-sources.ts
    - src/server/lib/__tests__/outreach-inbound.test.ts
    - src/server/lib/__tests__/outreach-provider-events-migration.db.test.ts
  modified:
    - src/db/schema.ts
    - src/server/jobs/processReplies.ts
    - src/server/jobs/processBounces.ts
    - src/server/lib/__tests__/outreach-entrypoints.test.ts
    - src/test/postgres-harness.ts

key-decisions:
  - "provider/classification are text + CHECK, not the email_provider enum: its 'native' member arrived in migration 032, so typing to it would couple the table to enum evolution and break the test baseline"
  - "Composite (email_account_id, organization_id) FKs bind every event/cursor to the account's own tenant in the database, backing up access.ts rather than replacing it"
  - "IMAP provider_message_id prefers the internet Message-ID over uid coordinates, because uid:<validity>:<uid> is not stable across a UIDVALIDITY reset and would re-ingest the whole mailbox as new events"
  - "Native paging uses a row-value comparison over COALESCE(received_at, created_at) plus an id tie breaker; received_at is nullable and would otherwise be permanently un-ingestable"
  - "Classification is shape-based, with an ingestion-time from-address lookup so the existing tier-3 matcher is not silently dropped"
  - "Claim-then-process: a handler failure is recorded on the row and not retried, so a poison message cannot stall the queue (operator-visible via processing_error IS NOT NULL)"
  - "Both jobs call ingestion because either may win the tick; ingestion is cursor-driven and deduplicated so a double run stages nothing twice"
  - "RLS on the new tables is SELECT-only: rows are written exclusively by server-side jobs"

patterns-established:
  - "One classifier, two consumers: reply and bounce jobs read disjoint classifications and cannot race"
  - "The event store port has no read-flag surface, so read state cannot be reintroduced as a cursor"

requirements-completed: [PROV-04]

# Metrics
duration: 22min
completed: 2026-07-16
---

# Phase 19 Plan 03: Provider-Neutral Inbound Staging Summary

**A DSN can no longer be eaten as a reply: every inbound message is now staged as one durable event and classified exactly once (bounce before auto-reply before reply) before any side effect, with ingestion driven by a cursor the pipeline owns instead of the user's unread flags.**

## What Changed

### The bug

`processReplies` and `processBounces` both scanned the same INBOX, and both used **user-visible read state as their cursor**. The sequence that broke:

1. `processReplies` searched unread mail (`search({ seen: false })` / `isRead=false`).
2. It found a DSN. A DSN quotes the original message in `In-Reply-To`, so `matchReplyToOutreach` matched it by tier 1 — a bounce, matched as a reply.
3. It called `markAsReplied` and set `\Seen` / `isRead=true`.
4. `processBounces` ran. The native path only looks at unread mail, so **it never saw the bounce**.

Result: a hard bounce recorded as a reply, `campaign_leads.status='replied'` (sequence stopped as *engaged*), reply counters incremented on campaign/account/lead, and the address **never added to suppressions** — so the org kept mailing a dead address from every future campaign. The old code even documented the hole out loud:

```
* simplification and its one known edge case: a bounce message that the reply
* processor mis-marks as read first would be skipped here).
```

Read/unread was never a safe cursor: it belongs to the human and is mutable from any mail client. Separately, the IMAP bounce search had **no date, unseen, or cursor bound at all** — it re-scanned and re-parsed every matching DSN on every tick forever.

### Task 1 — migration 039 + schema mirror

Two hand-written tables (idempotent; applied twice by the test):

- **`outreach_provider_events`** — one row per inbound item, unique on `(organization_id, email_account_id, provider, provider_message_id)`. Carries internet Message-ID/In-Reply-To/References, the single `classification`, sender/recipients, subject, **full text/html bodies**, selected headers, and attachment metadata (id/name/type/size/inline/content-id — no binary blobs).
- **`outreach_provider_cursors`** — Graph delta link, IMAP `uid_validity`/`last_uid`, native `last_received_at`/`last_provider_message_id`, lease, and error/retry bookkeeping. Unique per `(org, account, provider)`.

Two decisions worth flagging:

- **`provider`/`classification` are `text` + CHECK, not the `email_provider` enum.** The enum's `'native'` member only arrived in migration 032, which the test baseline does not replay — typing these columns to it would couple the table to enum evolution and break against the disposable database. The CHECK documents the same domain.
- **Composite `(email_account_id, organization_id)` FKs.** An event cannot claim an account owned by another tenant even if application code passes a mismatched pair. This *backs up* `access.ts`; it does not replace it (the app role still bypasses RLS). A test asserts the cross-tenant insert is rejected by the database.

RLS is SELECT-only with the existing `is_org_member`/`is_platform_admin` pattern — these rows are written exclusively by server-side jobs, so no authenticated end user has business mutating them.

### Task 2 — one classifier, two consumers (TDD)

`src/server/lib/outreach-inbound.ts` — normalization, classification, ingestion, consumption, and the SQL store, behind ports so it unit-tests without a database. `outreach-inbound-sources.ts` holds the native/IMAP sources (kept separate so the core stays free of `imapflow`/`db`).

The classifier runs **DSN → auto-reply → human reply → other**, and the order is the whole point: a DSN legitimately carries `In-Reply-To` *and* often an "Automatic reply"-shaped subject, so any other order misroutes real bounces.

| Concern | Before | After |
|---|---|---|
| Native cursor | `isRead=false`, 7-day window | `(COALESCE(received_at, created_at), id)` row-value comparison |
| IMAP reply cursor | `seen:false`, 7 days, 500 UIDs | `UID > high-water` under a recorded UIDVALIDITY |
| IMAP bounce cursor | **none** — full rescan every tick | same UID cursor |
| Classification | re-derived in each job, reply first | once, at ingestion, DSN first |
| Read flags | mutated as a side effect | **never read, never written** |
| `last_reply_text` (external) | always null (headers-only fetch) | populated from staged bodies |

`processReplies` and `processBounces` no longer import `ImapFlow` at all; both shrank to consuming their own classification. The duplicated `BOUNCE_SENDERS`/`BOUNCE_SUBJECTS`/`isBounceEmail` copy was deleted from `processBounces` — two copies of "what is a bounce" is how the jobs disagreed in the first place.

## Verification Results

| Gate | Result |
|---|---|
| `npm run test` | **211 passed** (17 files) — was 173 at 19-02 |
| `npx tsc --noEmit -p tsconfig.server.json` | pass |
| `npx tsc --noEmit -p tsconfig.json` (client) | pass |
| `npm run build` | pass (client + server) |
| `npm run lint` | pass, 0 warnings |

New tests: **25** in `outreach-inbound.test.ts` (RED at `a3d21f7`, GREEN at `35c0c83`), **6** in `outreach-provider-events-migration.db.test.ts` (RED at `f80a872`, GREEN at `8598ce2`), **+3** structural guards in `outreach-entrypoints.test.ts`.

Phase 18's cross-tenant regression suite (`outreach-inbound-matching.db.test.ts`) still passes unchanged — reply/bounce matching cannot cross an account/organization boundary.

Migration 039 was validated **only** against the disposable Testcontainers postgres via the Phase 18 guarded harness (loopback + `test` name marker + refusal to reuse the app `DATABASE_URL`). It was never applied to production; that remains a manual operator step:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/039_outreach_provider_events.sql
```

## Success Criteria

1. **Provider cursor, not user unread state, controls ingestion** — cursor tables drive both sources; the store port has no read-flag surface, and a structural test asserts no `isRead`/`seen:false`/`\Seen` survives in the code (comments stripped before matching, so the guard is not vacuous — verified it still catches a real violation).
2. **Every inbound item has one durable event key and one classification** — unique key enforced in SQL and exercised behaviourally (`ON CONFLICT DO NOTHING` returns no row on re-ingest).
3. **Bounce/reply side effects are idempotent and bounded** — claim marks `processed_at` atomically (`FOR UPDATE SKIP LOCKED`); a repeated run claims 0. Pages default to 200 and are hard-capped at 500 *at ingest*, so a provider that ignores the request is still bounded.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — Bug] IMAP keying on `uid:<validity>:<uid>` would duplicate every side effect after a UIDVALIDITY reset**
- **Found during:** Task 2 design
- **Issue:** The plan requires IMAP to "reset safely" on UIDVALIDITY change. But if the provider key embeds the UID, a reset renumbers every message → every message re-ingests under a *new* key → the dedupe key does not protect it → duplicate replies/bounces on exactly the mail we just resynced. The reset would have caused the harm it was meant to prevent.
- **Fix:** `imapProviderMessageId` prefers the internet Message-ID (`mid:<id>`), which survives renumbering, and falls back to `uid:<validity>:<uid>` only when a message has no Message-ID. Tested across two different UIDVALIDITY values.
- **Commit:** `35c0c83`

**2. [Rule 1 — Bug] Native cursor would permanently skip rows with a null `received_at`**
- **Found during:** Task 2 wiring (caught by the server typecheck)
- **Issue:** `mail_messages.received_at` is nullable. A null sorts NULLS LAST in ASC and never satisfies a `>` cursor, so such a row would be un-ingestable forever. Writers populate it today (`parsed.date || new Date()`), so this is latent, not active — but the column permits it.
- **Fix:** Order and page on `COALESCE(received_at, created_at)` (`created_at` is NOT NULL), with the cursor value computed from the same expression.
- **Commit:** `ac45f11`

**3. [Rule 1 — Bug] `search({ uid: 'n:*' })` re-fetches the last message forever on an idle mailbox**
- **Found during:** Task 2
- **Issue:** IMAP's `n:*` range always returns the highest UID even when it is below `n`, so a naive `startUid:*` would re-fetch the newest message on every tick of an idle mailbox. `imapflow` also returns `false`, not `[]`, for an empty search.
- **Fix:** Search from `high-water + 1` and floor the results explicitly; handle the `false` return.
- **Commit:** `ac45f11`

### Additions (Rule 2 — missing critical functionality)

**4. Tier-3 from-address matching would have been silently dropped**
- **Issue:** The plan's classifier is shape-based, but `matchReplyToOutreach` has a *third* tier that matches a reply by sender address when the client stripped `In-Reply-To` (the reason that tier exists). A purely shape-based classifier stages those as `'other'`, the reply consumer never queries them, and a working matcher disappears without a single test failing.
- **Fix:** `classifyInboundMessage` accepts `hasKnownCorrespondent`, resolved at ingestion by a bounded 30-day lookup that mirrors the tier-3 query — and only consulted when the cheaper signals are absent.
- **Commit:** `35c0c83` / `ac45f11`

**5. Structural guards against reintroducing read-state cursors**
- **Issue:** The core invariant ("read state is not a cursor") is a property of *absence*; nothing stops a future edit from adding `isRead` back.
- **Fix:** 3 guards in `outreach-entrypoints.test.ts` (following 19-02's pattern): the jobs must not import `ImapFlow` or call `messageFlagsAdd`; no file in the inbound path may reference `isRead`/`seen: false`/`\Seen` **in code** (comments stripped first); and `processBounces` must not carry a second bounce heuristic.
- **Commit:** `ac45f11`

**6. `is_org_member`/`is_platform_admin` stubs in the test harness**
- **Issue:** Migration 039 attaches RLS policies referencing helpers defined in `020_consolidate_rls.sql`, which the test baseline deliberately does not replay — so the migration could not apply to the disposable database at all.
- **Fix:** `installRlsHelperStubs` in `postgres-harness.ts`, alongside the existing `auth.uid()`/`authenticated` stubs. They always return **false**: the tests assert policies were *attached*, never that they grant access — a stub that authorized rows would misrepresent where the real boundary lives.
- **Commit:** `f80a872`

### Deliberate scope boundary

- **Outlook/Graph delta ingestion is not wired here.** The cursor table carries `delta_cursor` and the classifier/store are provider-neutral, but `ingestOutreachInbound` only builds native and IMAP sources — 19-04 owns the Graph poller and the activation gate. Outlook accounts are unaffected by this plan (they were already excluded from both jobs unless they happened to have IMAP credentials).
- **`processBounceFromWebhook` is untouched.** It is a push path from external ESPs with no inbox scan and no race; staging it would add a hop for no safety gain.

## Notes for Later Plans

- **19-04 (Outlook inbound):** add a `createGraphInboundSource` returning `{ messages, nextCursor: { deltaCursor } }` and register it in `ingestOutreachInbound`. Classification, dedupe, cursor persistence, and both consumers are already provider-neutral — nothing else should need to change. Reuse `OutlookGraphError`/`refreshOrMarkExpired` from 19-02.
- **Phase 21 (unified inbox):** `classification='other'` rows are the preserved unmatched human mail, and every event retains full bodies + attachment metadata. `idx_outreach_provider_events_message_id` exists for threading. Consume these rows rather than re-polling.
- **Claim-then-process is a deliberate bounded choice.** A handler failure records `processing_error` and leaves the event claimed, so a poison message cannot stall the queue — but a transient DB blip during a handler drops that one side effect. Operators find them with `processing_error IS NOT NULL`. If replay matters later, an attempt counter + lease (the 038 pattern) is the natural upgrade.
- **`outreach_provider_events` grows unboundedly.** No retention policy exists yet. Phase 21/22 should decide a prune or archive window once conversation materialization defines how long the rows are needed.
- **Cursor lease columns are unused so far.** `lease_token`/`lease_expires_at` are staged for a future multi-worker ingestion; today the advisory cron locks provide single-flight.
- **Ingestion runs from both jobs.** Harmless (idempotent), but if a future refactor gives ingestion its own cron tick, remove both call sites rather than leaving one.

## Known Stubs

None. `delta_cursor` is unwritten until 19-04, which is the plan that owns Graph — it is an unused column, not a stub returning fake data.

## Self-Check: PASSED

- All 10 claimed created/modified files exist on disk.
- All 5 claimed commits (`f80a872`, `8598ce2`, `a3d21f7`, `35c0c83`, `ac45f11`) exist in git history.
- Quoted legacy comment verified against `git show 874d08d:src/server/jobs/processBounces.ts`.
- Test counts (211 total, 25 + 6 new files, +3 guards) reproduced from live runs, not asserted from memory.
- The comment-stripping structural guard was verified to catch a real violation rather than pass vacuously.
