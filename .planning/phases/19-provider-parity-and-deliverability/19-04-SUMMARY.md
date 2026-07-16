---
phase: 19-provider-parity-and-deliverability
plan: 04
subsystem: api
tags: [outreach, outlook, graph, delta, inbound, capability-gate, provider-parity, idempotency]

# Dependency graph
requires:
  - phase: 19-provider-parity-and-deliverability
    plan: 02
    provides: OutlookGraphError + refreshOrMarkExpired + compose-once MIME adapters, all reused unchanged
  - phase: 19-provider-parity-and-deliverability
    plan: 03
    provides: outreach_provider_events/cursors, single classifier, InboundSource/InboundEventStore ports
  - phase: 18-outreach-safety-and-execution-reliability
    provides: durable dispatcher, delivery policy gate, cross-tenant regression suite
provides:
  - Bounded resumable Graph delta reader (fetchOutlookInboxDelta) with 410 resync and Retry-After handling
  - Graph inbound source registered in ingestOutreachInbound — Outlook is no longer send-only
  - Outlook activation gate requiring linked mailbox + scopes + a real bounded inbound sync
  - recordCursorRetry port + SQL, persisting provider backoff without touching cursor position
  - Cross-provider parity suite over the three real adapters
affects: [21-unified-inbox, 22-operator-thread-ui, 23-ai-inbox-automation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A page is all-or-nothing: the cursor may only advance over messages read in full"
    - "Budgets are checked at page boundaries, never mid-page, so a page is never half-staged"
    - "A source never returns more than its budget, because the ingest cap truncates but still advances"
    - "Chain freshness is recorded on the cursor, not inferred from its shape or nullness"
    - "A throttle is a control signal to report, not a fault to throw"

key-files:
  created:
    - src/server/lib/__tests__/outlook-inbound.test.ts
    - src/server/lib/__tests__/provider-parity.test.ts
  modified:
    - src/server/lib/outlook.ts
    - src/server/lib/outreach-inbound.ts
    - src/server/lib/outreach-inbound-sources.ts
    - src/server/routes/outreach/email-accounts.ts
    - src/server/jobs/processReplies.ts
    - src/server/lib/__tests__/outreach-entrypoints.test.ts

key-decisions:
  - "Fresh-chain state is carried as a `fresh|` prefix on the opaque cursor: it cannot be inferred from `cursor === null` (a paused fresh chain resumes non-null) nor from the link shape (a paused resumed chain also carries a $skiptoken), and getting it wrong ingests an entire mailbox history on page 2 of a first-ever sync"
  - "The lookback bound is applied client-side rather than via $filter, because delta query parameter support could not be verified offline and a bound that silently stops being honoured is worse than one that costs a few dropped rows"
  - "Graph events key on the internet Message-ID (mid:), not the Graph id, which is folder-scoped and changes when a message moves — the same instability that made IMAP prefer Message-ID in 19-03"
  - "429/503 are reported as a result with retryAfter rather than thrown, so pages already read are still staged and the backoff can be recorded; every other error with nothing read throws"
  - "Send capability is asserted from the granted Mail.Send scope: Graph has no zero-send probe (a draft exercises Mail.ReadWrite), and the only call proving Mail.Send delivers real mail to a real recipient — the response states this gate explicitly"
  - "A throttled activation sync leaves the account pending (retryable); a rejected grant fails it. Neither can be send-only verified"
  - "Attachment metadata needs its own Graph call per message because delta cannot $expand; the lookup count is a budget dimension checked at page boundaries"

patterns-established:
  - "Parity is asserted over the real adapters with only the wire faked, because every regression this phase fixed was a provider branch quietly doing less while all existing tests passed"
  - "Byte-identity is asserted where one buffer reaches three transports (19-02); header/body parity where three composes happen (19-04)"

requirements-completed: [PROV-02, PROV-04, PROV-05]

# Metrics
duration: 32min
completed: 2026-07-16
---

# Phase 19 Plan 04: Outlook Inbound Parity and the Activation Gate Summary

**Outlook could send campaigns but could not hear a single answer: nothing ever read a Graph mailbox, and the verify endpoint marked such accounts `verified` without making one network call — so an Outlook-assigned lead could hard-bounce and keep receiving the sequence forever. Outlook now reads its inbox through a bounded resumable delta cursor, and an account cannot be activated until that read is proven to work.**

## What Changed

### The bug

Two independent halves of the same hole:

1. **`ingestOutreachInbound` never selected Outlook accounts.** 19-03 made ingestion provider-neutral and staged native + IMAP, but the Graph poller did not exist. An Outlook account was only ever scanned if it happened to also carry IMAP credentials.
2. **The verify route could not fail.** The entire Outlook branch was:

```ts
if (account.provider === 'outlook') {
    const [updatedAccount] = await db.update(emailAccounts)
        .set({ status: 'verified', verifiedAt: new Date(), lastError: null, ... })
    return res.json({ ..., verified: true })
}
```

No scope check, no token check, no mailbox check, no network call. `verified` meant "an operator clicked the button". 19-02's summary flagged exactly this risk in advance: *"an Outlook account that is send-only will look healthier than it is until 19-03/19-04 land the inbound gate."*

Together: Outlook sent bulk mail, and every reply and every DSN it received was invisible. The address was never suppressed, the sequence never stopped, and the campaign's reply stats silently under-counted — all decided by which inbox the round-robin assigned.

### Task 1 — the bounded delta reader (TDD)

`fetchOutlookInboxDelta` in `outlook.ts` walks `/me/mailFolders/inbox/messages/delta` under four invariants, in the order they matter:

| # | Invariant | Why it is not optional |
|---|---|---|
| 1 | A page is all-or-nothing | The returned cursor still points *at* a page that failed, so the next run re-reads it. Re-reading is free (events dedupe); skipping is unrecoverable. |
| 2 | Budgets checked between pages | Events, pages, wall clock and attachment lookups each stop the chain at a page boundary — never mid-page, which would half-stage it. |
| 3 | Never return more than `maxEvents` | `ingestInboundPage` truncates an oversized page **but still advances the cursor**. A source that overshoots therefore loses mail silently. An overshooting page is deferred instead. |
| 4 | A failure never downgrades the cursor | Nothing read ⇒ the caller's own cursor comes back unchanged. |

Three details worth knowing:

- **`internetMessageHeaders` is mandatory in `$select`.** In-Reply-To and References have no first-class field on a Graph message. Without them every Graph reply looks unthreaded, the shared classifier stages it as `'other'`, and the reply consumer never queries it — the feature would look implemented and do nothing.
- **Fresh-chain state is recorded, not inferred.** The lookback bound must apply to a first-ever sync and *not* to a resumed one (if the poller was down for two weeks, the mail it missed is old but unprocessed — dropping it loses exactly the bounces the outage delayed). "Fresh" cannot be inferred from `cursor === null`, because a fresh chain paused at a nextLink resumes non-null; nor from the link shape, because a paused *resumed* chain also carries a `$skiptoken`. So the reader marks the cursor (`fresh|<link>`) and a test asserts the bound survives pagination.
- **A throttle is reported, not thrown.** 429/503 return the pages already read plus a `retryAfter`, so work is not discarded and the backoff can be persisted.

Graph events key on the internet Message-ID (`mid:`), not the Graph id — a Graph id is folder-scoped and changes when a message moves, so keying on it would re-ingest the same mail as a new event and duplicate the side effect. Same reasoning that made 19-03 prefer Message-ID over IMAP UIDs.

### Task 2 — the activation gate

> **Correction (GAP-1, 19-REVIEW).** This plan's declared truth read *"a verified Outlook
> outreach account has proven read, write, and send capability"*. That over-claims. Only
> **read** is proven — by a real bounded sync that must succeed. **Write and send are
> asserted from the granted OAuth scopes** and are never exercised, because Graph has no
> zero-send probe (this plan pre-authorised that fallback). The code was always honest —
> `OUTLOOK_CAPABILITY_GATE` says exactly this and is returned to the API caller as `gate` —
> so the defect was in the wording, not the behaviour. The safety property that actually
> matters is unchanged and IS proven: **an account is never verified send-only.** The plan's
> `must_haves` truth has been corrected to match.

`evaluateOutlookOutreachCapability` (db/HTTP-free, so the decision table is unit-testable) now requires, in order: a linked mailbox that resolves **inside the account's own organization**, a mailbox that owns the account address, an active grant, `Mail.Read` + `Mail.ReadWrite` + `Mail.Send` actually granted, and a real bounded inbox sync that leaves a durable cursor behind.

**On send capability**, the plan's fallback applies and is stated rather than papered over: Graph offers no zero-send probe. Creating a draft exercises `Mail.ReadWrite`, not `Mail.Send`, and the only call that proves `Mail.Send` delivers real mail to a real recipient — sending a live "test" email from an outreach inbox during verification is the behaviour this phase exists to prevent. So send capability is asserted from the granted scope, read capability is proven by a real sync, and the response carries the gate text so nobody reads `verified` as "we sent a test email".

A throttled sync leaves the account **pending** (retryable without re-consenting); a rejected grant **fails** it. Neither path can produce a send-only verified account. Stored errors are sanitized codes (`outlook_missing_scopes`, …), never raw Graph text, which can carry mailbox names and tenant ids.

> **Correction (W-1, 19-REVIEW).** The throttle sentence above was aspirational when written.
> The gate treated "the probe did not throw" as proof of a read, but `fetchOutlookInboxDelta`
> deliberately *returns* on a 429/503 rather than throwing, so a first-page throttle produced
> `pagesFetched === 0`, an ordinary-looking empty ingest, and `verified: true` — while
> advertising a sync that never happened. The probe now reports `pagesFetched`/`retryAfter`
> (both were already available at the call site and discarded), and the gate refuses to
> verify without evidence of a real read. The sentence is now true.

### Task 3 — parity, asserted on the real adapters (TDD)

19-03 had already made the reply/bounce consumers provider-agnostic and populated `last_reply_text`, so the substance here is the **proof**: `provider-parity.test.ts` runs the three real adapters with only the wire and the repository faked, because every regression this phase fixed shared one shape — *a provider branch quietly doing less than the others while every existing test still passed*.

It asserts, per provider: compliance headers and threading; Message-ID normalization (bracketed on the wire, unbracketed in the ledger — reply matching compares the unbracketed form); every policy denial blocking before anything reaches the wire or starts an attempt; one claim / one attempt / one finalize; a replayed idempotency key sending and counting nothing; a DSN quoting our own id classifying as a bounce; and one side effect per event across replays.

The one genuine gap it exposed: **Graph returns exactly one body**, and anything composed in Outlook arrives as HTML with no text alternative. `normalizeReplyText`'s HTML-to-text fallback is what stops an Outlook reply reaching the agentic decider as an empty string while an SMTP reply to the same campaign works fine. It was implemented but untested and unexported; it is now both.

## Verification Results

| Gate | Result |
|---|---|
| `npm run test` | **315 passed** (19 files) — was 211 at 19-03 |
| `npx vitest run --project postgres` | **24 passed** (5 files) — Phase 18 cross-tenant regressions intact |
| `npx tsc --noEmit -p tsconfig.server.json` | pass |
| `npx tsc --noEmit -p tsconfig.json` (client) | pass |
| `npm run build` | pass (client + server) |
| `npm run lint` | pass, 0 warnings |

New tests: **38** in `outlook-inbound.test.ts` (RED at `2ade047`, GREEN at `7b6062b`, gate added at `8c3f83d`), **64** in `provider-parity.test.ts` (RED at `dfdd994`, GREEN at `2e44693`), **+2** structural guards in `outreach-entrypoints.test.ts`.

No migration was written or applied: 039 already created every column this plan writes (`delta_cursor`, `last_error`, `retry_at`). Production was never touched.

**The manual Outlook sandbox gate in the plan was NOT executed** — it needs a real Microsoft tenant and mailbox, which this environment does not have. Every Graph interaction is covered by mocked-transport tests against the real reader; first contact with live Graph remains unproven. See "Notes for Later Plans".

> **OPERATOR PREREQUISITE — OUTSTANDING (GAP-1, 19-REVIEW).** This is not a nice-to-have
> that automated coverage can retire. Plan 19-04's own `<verification>` block mandates it,
> and the **entire Graph surface — delta reader, 410 resync, throttle handling, MIME send,
> capability gate — is verified against mocked `fetch` only.** No real Microsoft tenant has
> ever been contacted by this code. A mock cannot tell us that Graph accepts our MIME, that
> the scopes we request are the scopes Microsoft grants, or that a real DSN arrives shaped
> the way the classifier expects. **Run the sandbox gate before activating any Outlook
> outreach account in production.** The checklist is in "Notes for Later Plans".

## Success Criteria

1. **Outlook is no longer send-only and cannot be verified without inbound capability** — the Graph source is registered in `ingestOutreachInbound`, and the verify route refuses activation on a missing mailbox, a cross-tenant mailbox, an address mismatch, an inactive grant, missing scopes, or a failed initial sync. Two structural guards keep both properties from silently regressing.
2. **Full reply text reaches follow-up context from every provider** — asserted on the real `normalizeReplyText` across all three body shapes, including Outlook's HTML-only case, and bounded at 20k.
3. **DSNs and replies are bounded, resumable and idempotent across native, IMAP and Graph** — the delta reader resumes from a durable cursor under four invariants; the parity suite asserts dedupe and once-only side effects for all three providers.
4. **Manual and agentic sends have the same policy, counters, headers and attempt ledger as campaign sends** — 27 policy×provider cases assert denial before the wire, plus one-claim/one-attempt/one-finalize per provider.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — Bug] The lookback bound would have died on page 2 of every first-ever sync**
- **Found during:** Task 1 design
- **Issue:** The obvious implementation treats `cursor === null` as "fresh chain" and applies the lookback there. But a fresh chain that pauses at a nextLink (which the event budget guarantees on any real mailbox) resumes with a non-null cursor — so page 1 of a first-ever sync would be bounded and pages 2..N would ingest the mailbox's entire history. The bound would have appeared to work in any single-page test.
- **Fix:** Freshness is recorded on the cursor itself (`fresh|` prefix, opaque to every other reader) and retires only when the chain reaches its deltaLink. A test pauses a fresh chain and asserts the bound still applies after resuming.
- **Commit:** `7b6062b`

**2. [Rule 1 — Bug] An overshooting page would have been truncated *and* skipped**
- **Found during:** Task 1 design
- **Issue:** `ingestInboundPage` (19-03) does `page.messages.slice(0, pageSize)` and then `saveCursor(page.nextCursor)`. For native/IMAP this never bites — both sources self-limit — but a delta reader that accumulates across nextLinks can overshoot, and the truncated messages would be dropped while the cursor advanced past them.
- **Fix:** The Graph reader defers a page that would overshoot rather than returning it (invariant 3), and a test asserts it. The shared `slice` is left alone — see "Observations".
- **Commit:** `7b6062b`

**3. [Rule 1 — Bug] Scope matching would have failed every correctly-granted mailbox**
- **Found during:** Task 2
- **Issue:** Graph's token endpoint returns scopes either bare (`Mail.Read`) or fully qualified (`https://graph.microsoft.com/Mail.Read`), with no casing guarantee. A strict string compare against `['Mail.Read', ...]` would have denied activation to mailboxes that had granted everything — turning the safety gate into a permanent outage.
- **Fix:** `findMissingOutlookScopes` compares the last path segment case-insensitively; tests cover both shapes and a malformed list.
- **Commit:** `8c3f83d`

**4. [Rule 1 — Bug] A throttle would have discarded the pages already read**
- **Found during:** Task 1 GREEN (the RED test caught it)
- **Issue:** The first implementation threw on any non-OK status when no page had been read, including 429. That propagates out of `ingestInboundPage`, so the `retryAfter` never reaches the cursor row and a mid-chain throttle would discard completed pages.
- **Fix:** Throttles (429/503) are reported as a result with `retryAfter`; only a genuine error with nothing read throws.
- **Commit:** `7b6062b`

### Additions (Rule 2 — missing critical functionality)

**5. `recordCursorRetry` on the event-store port**
- **Issue:** The plan requires "persist retry/error without discarding the prior good cursor", but the 19-03 port had no surface for it — `saveCursor` *clears* `last_error`/`retry_at` on success, so recording a backoff before it would be erased.
- **Fix:** Optional port method (optional so 19-03's own fake store still satisfies the interface) + SQL implementation writing only `last_error`/`last_error_at`/`retry_at`, called by `ingestInboundPage` *after* `saveCursor`. Uses columns migration 039 already created — no migration needed.
- **Commit:** `7b6062b`

**6. Structural guards against both halves of the regression**
- **Issue:** "Outlook is read" and "Outlook cannot self-verify" are properties of presence/absence that nothing prevents a future edit from undoing.
- **Fix:** Two guards in `outreach-entrypoints.test.ts` (19-02/19-03's pattern): the verify route must call `evaluateOutlookOutreachCapability` and `syncOutlookInboundOnce`; the sources module must build a Graph source and select `provider = 'outlook'`.
- **Commit:** `8c3f83d`

### Corrections to the plan's assumptions

**7. `createGraphInboundSource` lives in `outreach-inbound-sources.ts`, not `outreach-inbound.ts`**
- The plan's `files_modified` lists `outreach-inbound.ts` for the source. 19-03 deliberately split sources out so the classifier core stays free of `imapflow`/`db` imports, and its summary explicitly hands 19-04 the instruction to "add a `createGraphInboundSource` … and register it in `ingestOutreachInbound`" — which lives there. `outreach-inbound.ts` still changed, for the pieces that genuinely belong to the shared contract (`graphProviderMessageId`, the retry port, the `retryAfter` pass-through).

**8. Byte-identity is not assertable at the dispatcher level**
- The plan asks the parity suite to assert "matching headers". Byte equality across providers is already locked in 19-02, where **one** composed buffer reaches all three transports. It cannot be re-asserted end-to-end here: each provider composes its own message and Nodemailer mints a fresh random multipart boundary each time, so identical messages differ in bytes by design. This suite asserts everything a recipient or our matcher can observe (headers, content type, body presence) and says so in a comment, rather than deleting a test that looked reasonable.

### Deliberate scope boundary

- **`retry_at` is persisted but not yet honoured.** Ingestion still visits every verified account each tick, so a throttled Graph mailbox is retried on the next tick regardless of its `retryAfter`. The column is operator-visible and `idx_outreach_provider_cursors_due` exists for it, but no due-based reader consumes it (19-03 staged the same columns unused). Making ingestion due-aware is a small, self-contained change that belongs with a scheduler, not bolted onto this plan's last task.
- **`sendMessageWithOutlook` (the JSON shape) is still used by `routes/messages.ts` / `routes/outlook.ts`** — webmail/admin transactional sends, outside outreach scope, exactly as 19-02 left them.

## Observations (not fixed — outside this plan's scope)

- **`ingestInboundPage`'s truncate-and-advance is a latent trap for future sources.** `slice(0, pageSize)` followed by `saveCursor` silently loses mail from any source that returns more than its budget alongside a cursor covering the excess. No shipped source triggers it (all three self-bound, and the Graph reader defers rather than overshoot), and 19-03 has a test asserting the truncation as a deliberate cap against a provider that ignores the request. Changing it now would rewrite another plan's tested decision on a path nothing currently walks. Worth revisiting when a fourth source appears: the honest shapes are "throw on contract violation" (loud, no loss) or "cap, but never advance past what was staged".
- **A 410 resync walks the whole mailbox.** The lookback drops old *rows* but not the *pages* holding them, so a large mailbox catches up over several ticks after a delta expiry. Bounded and deduplicated, just not instant.

## Notes for Later Plans

- **The live-Graph gate is still open.** Everything here is proven against mocked transports and the real reader. The first real tenant should confirm, in order: the initial delta cursor persists (`SELECT delta_cursor FROM outreach_provider_cursors`), `internetMessageHeaders` actually arrives populated (the whole classifier depends on it), one reply and one generated DSN each produce exactly one `outreach_provider_events` row and one side effect, and a moved message does not re-ingest.
- **If Graph delta turns out to honour `$filter` on `receivedDateTime`**, the `fresh|` cursor marker can retire: a server-side bound propagates into nextLink/deltaLink automatically and the whole fresh-chain question disappears. Worth ten minutes with a live tenant.
- **Phase 21 (unified inbox):** Outlook events now flow into the same `outreach_provider_events` table with full bodies and attachment metadata, so conversation materialization gets Outlook for free. Note that Graph fills exactly one of `text_body`/`html_body`.
- **Attachment binaries are still deferred** — metadata only (id/name/type/size/inline/content-id). Phase 22 owns fetching bytes; the Graph attachment call is already isolated in `fetchGraphAttachmentMetadata`.
- **`REQUIRED_OUTLOOK_OUTREACH_SCOPES` and `OUTLOOK_SCOPES` must stay in sync.** The OAuth flow requests the latter; the gate demands the former. They agree today; a future scope addition to one without the other silently strands every existing mailbox at the gate.

## Known Stubs

None. Every code path added here reaches a real implementation; the one asserted-rather-than-probed capability (Mail.Send) is a documented Graph limitation stated in the API response, not a placeholder.

## Self-Check: PASSED

- All 8 claimed created/modified files exist on disk.
- All 5 claimed commits (`2ade047`, `7b6062b`, `8c3f83d`, `dfdd994`, `2e44693`) exist in git history.
- The quoted legacy verify branch was verified against `git show 874d08d:src/server/routes/outreach/email-accounts.ts`.
- Test counts (315 total, 24 postgres, 38 + 64 new) reproduced from live runs, not asserted from memory.
- The RED commits were confirmed failing before their GREEN counterparts, and the parity suite's RED was narrowed to the one genuine contract gap rather than left failing on incorrect fixtures.
- The unexecuted manual Graph gate is recorded as unproven rather than implied complete.
