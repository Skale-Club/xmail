---
phase: 19
phase_name: provider-parity-and-deliverability
fixed_at: "2026-07-16T07:35:00Z"
review: 19-REVIEW.md
range: 601bc3e..HEAD
status: fixes_complete
findings_addressed: 3 critical, 5 warnings, 1 gap
deviations: 1 (C-2 mechanism), 1 partial (W-5)
---

# Phase 19 Review — Fix Report

Every finding in `19-REVIEW.md` was real. None was refuted. Each fix has a test that fails
first against the specific scenario the review describes, committed separately from the fix.

Gates at completion: **353/353 tests** (was 315), build, lint 0 warnings, both `tsc --noEmit`
projects. Production DB never touched; DB tests run only against the disposable Testcontainers
postgres.

| Finding | Status | Reproducing test |
|---|---|---|
| C-1 port 25 cleartext AUTH | fixed | `smtp-security.test.ts` — "TLS guarantee for authenticated submission" |
| C-2 claimed events lost on crash | fixed (deviation: mechanism) | `outreach-inbound-claim.db.test.ts` (6) |
| C-3 native inbound, no org check | fixed (+ Rule 2: verify path) | `outreach-inbound-native-tenancy.db.test.ts` (4) |
| W-1 Outlook verifies on a throttle | fixed (+ misleading test corrected) | `outlook-inbound.test.ts` (3 new) |
| W-2 terminal state clobbered | fixed | `outreach-terminal-state.db.test.ts` (5) |
| W-3 bcc dropped on Outlook | fixed | `outreach-provider.test.ts` (2 new) |
| W-4 Message-ID on `.local` | fixed | `outreach-dispatch.test.ts` (4 new) |
| W-5 retry_at / lease unused | **partial** — retry_at fixed, cursor lease deferred | `outreach-inbound-retry.db.test.ts` (5) |
| GAP-1 PROV-02 over-claim | fixed (wording + operator prerequisite) | n/a (documentation) |

Plus one finding the review did not make, surfaced by W-2's test: **`markAsReplied` threw on
every matched reply against a real database.** See "Found while fixing".

---

## C-1 — Port 25 submitted credentials with no TLS guarantee

**Fixed.** `resolveSmtpSecurity` takes `authenticated` (default `true` — every caller in the
repo resolves a stored outreach inbox). The presence of AUTH, not the port number, now decides:

- 25 + authenticated → `starttls_required`
- 25 + `authenticated: false` (MX relay) → `starttls_opportunistic`, unchanged — there are no
  credentials to expose and refusing would drop mail to peers that genuinely have no TLS

`buildSmtpTransportOptions` states `authenticated: true` at the point it attaches `auth`, and
asserts `guaranteesTls()` before doing so. That assertion is unreachable by construction; it is
there because this is the one place credentials and transport options meet, and a future
resolver change should trip over it rather than around it.

**Coherence preserved as instructed.** The resolver stays pure and total. The 422-vs-normalize
split is untouched: canonical `secure` for port 25 is still `false`, so a stored `secure=true`
is still the only thing that can contradict, still normalized with a warning rather than
rejected. `isStandardSmtpPort(25)` still returns true. `smtp-security.ts` still has **zero
imports**, so the browser-purity invariant the review flagged is intact.

**Test:** parametrized over 25/465/587/2525/null/undefined — every transport carrying `auth`
must satisfy `secure || requireTLS`. RED on port 25: *"port 25 would submit AUTH over a
connection an attacker can keep in cleartext"*.

## C-2 — Claimed inbound events were lost on crash

**Fixed — with a deviation from the prescribed mechanism. Please read this section.**

### The instruction rested on a factual error

> "Migration 039 ALREADY provisions `lease_token uuid` and `lease_expires_at timestamp`
> (`:76-77`, CHECK at `:129`) … **Use the lease the migration already has — do NOT write a new
> migration.**"

Those columns are real, and unused, exactly as the review says. But they are on
**`outreach_provider_cursors`** — the per-account *ingest* cursor — not on
`outreach_provider_events`. Lines 76-77 fall inside `CREATE TABLE ... outreach_provider_cursors`,
and the CHECK at :129 is `outreach_provider_cursors_lease_check`. `schema.ts` mirrors this:
`outreachProviderCursors` has `leaseToken`/`leaseExpiresAt` (`:1515-1516`);
`outreachProviderEvents` (`:1547-1590`) has only `processed_at`, `processing_error`,
`created_at`, `updated_at`.

A per-account cursor lease cannot express a per-event claim. So the prescribed fix — reuse
039's lease for event claiming — was not available, and the review's own W-5 confirms the
cursor lease is intended for ingest single-flight, a different job.

That left two options: write migration 040 to add lease columns to the events table
(explicitly forbidden), or find a lease that already exists. I took the second.

### What was implemented: the row lock is the lease

`claimPending` + `recordProcessingError` are gone from the port, replaced by
`withNextPendingEvent(classification, handle)`, which:

1. leases the oldest pending event with `FOR UPDATE SKIP LOCKED`, inside a transaction
2. runs `handle` **while still holding that lease**
3. writes `processed_at` in the **same transaction**, only after the side effect resolved

A crash rolls the transaction back and the event is still pending on the next tick. No new
migration, and no reaper: **Postgres releases the lock the instant the connection dies**, which
is precisely the failure mode here (blue-green rollout SIGKILLs the container on every push to
main). A column lease would additionally need a reaper, a clock, an expiry guess, and would
leave a smaller version of the same window. This is the stronger primitive, not a workaround.

Every invariant the instruction listed is satisfied:

| Required | How |
|---|---|
| Claim = take a lease | the row lock, held across the side effect |
| `processed_at` only after the side effect succeeds | same transaction, written last |
| Recover expired leases on a later tick | automatic — lock dies with the connection |
| Two workers never get the same event | `SKIP LOCKED` + `processed_at IS NULL` under the lock |
| A reply consumer never claims a bounce row | the `classification` predicate, unchanged |

**Per event, not per batch:** a batch-wide lease held across 200 side effects would be one long
transaction whose failure re-runs all 200. Per event, a crash costs at most the one in flight.

**Consumption is now at-least-once rather than at-most-once**, and the module contract says so.
Re-applying a bounce is idempotent (and W-2's CAS makes the counters idempotent too); losing one
is not — which is 039's own stated rationale.

**`recordProcessingError` was the other half of the bug** and is gone as a standalone operation.
It stamped an error onto a row the claim had already marked processed, so the event was never
retried. A failure now *commits* the error while leaving `processed_at` NULL — committed, not
rolled back, so the error survives while the event stays pending. The claim skips it for
`PROCESSING_RETRY_BACKOFF_MINUTES` (15), so a poison event costs one attempt per window instead
of heading every batch forever. Retrying beats dead-lettering here for the reason 039 gives:
skipping a bounce is unrecoverable, re-reading is cheap.

**Tests** (`outreach-inbound-claim.db.test.ts`, real Postgres — an in-memory fake cannot fail the
way a database does). RED was 3 failed / 3 passed:

- an independent connection (= what a restarted container inherits) must not see `processed_at`
  committed while the handler is still running → *"expected 2026-07-16T…Z to be null"*
- while event 1 is handled, events 2-5 must still be pending → **`expected [] to deeply equal
  ['batch-1' … 'batch-5']`** — the whole batch was committed as processed while only the first
  had run. This is the 197-lost-bounces scenario in miniature.
- a failed handler must leave the event retryable → *"expected 2026-07-16T…Z to be null"*
- the three passing tests pin what the fix must preserve: exclusion, classification isolation,
  and backoff.

## C-3 — Native inbound source had no organization check

**Fixed.** `createNativeInboundSource` now resolves through `getNativeMailboxForOrganization`,
which requires the mailbox owner to still be a member of the account's organization — mirroring
the Graph sibling's `outlook_mailboxes.organization_id` re-check. An account whose owner has left
resolves to no source and is skipped with a warning, instead of staging that person's entire
private INBOX (bodies retained by 039 for Phase 21) under an organization they no longer belong
to.

Membership is revocable, so a check that only ran at create time is not a check.
`getNativeMailboxByEmail` remains for the create path — which checks membership separately to
give a distinct error — and now documents that recurring readers must not use it.

**Rule 2 — same hole, one level up.** `POST /:id/verify` re-validated that the user and mailbox
still existed but *not* the membership, so an operator could re-verify an ex-member's account to
a green tick. The review frames C-3 as *"the native path never re-checks the membership its
create-time gate relied on"*, and this is that same path, so it is fixed with the same resolver.

**Tests** (`outreach-inbound-native-tenancy.db.test.ts`): bob@ in Org A and Org B, native
outreach account in Org A, then removed from Org A exactly as `DELETE /:id/members/:userId` does
(membership row deleted, verified `email_accounts` row untouched). RED: *"expected
{ provider: 'native', … } to be null"* — the source was still handed out. A positive control
asserts a real member's mailbox still reads, so the guard cannot pass by breaking everything.

## W-1 — Outlook reached `verified` on a Graph throttle

**Fixed.** `probeInbound` returns `OutlookInboundProbe { pagesFetched, retryAfter }` — both were
already available at the call site and discarded by `.then(() => undefined)` — and the gate
refuses to verify when `pagesFetched` is 0. A throttle or outage now lands on the existing
`outlook_inbound_sync_failed → pending` branch, which was written for exactly this and was
unreachable for a first-page throttle. A page read *alongside* a Retry-After still verifies: the
read is proven. `pagesFetched` is plumbed through `InboundSourcePage`/`IngestResult`; native and
IMAP query directly and throw on failure, so absence means one page.

**The misleading test is corrected**, as instructed. It stubbed `probeInbound` to *throw* on 429
— which no production path can produce; two tests in the same file assert the real collaborator
*returns* a result carrying `retryAfter`. It contradicted the wiring it claimed to cover, so it
passed while the gate was broken. It now models what actually happens: the probe resolves.

**RED:** both a throttle (`pagesFetched: 0, retryAfter: <date>`) and a Graph outage
(`pagesFetched: 0, retryAfter: null` — 503 need not carry Retry-After) reached `verified: true`.

## W-2 — Concurrent reply/bounce clobbered terminal state

**Fixed**, reusing Phase 18's contracts rather than inventing new ones. Every guard is now a
`CASE` the database evaluates against the current row — never a read-then-write.

- **`markAsReplied`** had no CAS on `campaign_leads.status`, and its `leads.status` guard listed
  `('replied','interested','not_interested')` — omitting `bounced`/`unsubscribed`. Both guards
  now derive from `TERMINAL_CAMPAIGN_LEAD_STATUSES`, so a status added to the exhaustive map
  cannot be forgotten in either.
- **`markAsBounced`** now clears `nextFollowUpAt`. `processFollowUps` selects on it alone, so
  leaving it set mailed an address that had just bounced.
- **The "already bounced" early return** was a read-then-write with nothing in between; two DSNs
  both passed it and double-counted. Replaced by a CAS (`status <> 'bounced'`) whose `RETURNING`
  gates every counter. `markAsBounced` reports whether it transitioned, so both callers
  (`handleBounceEvent`, `processBounceFromWebhook`) drop their racy pre-checks.

**Phase 18's rule applied in both directions:** a terminal status is never reverted, so whichever
outcome lands first wins and the other is recorded as bookkeeping (`last_reply_text`,
`totalReplies`, `totalBounces` still land). That also makes the outcome independent of which job
wins the tick, which is the actual complaint.

**One addition to the Phase 18 contract**, kept inside the existing exhaustive map rather than
beside it: `CAMPAIGN_LEAD_PROGRESS` gains `deliverable`, distinct from `terminal`. `replied` ends
the sequence but an agentic follow-up to a live human is the point; `bounced`/`unsubscribed` mean
never mail again. The review's own reasoning demands the distinction: suppression only covers
*hard* bounces, a soft bounce writes no row, and `outreach-delivery-policy.ts` never consults
`campaign_leads.status`.

**Tests** (`outreach-terminal-state.db.test.ts`) use a **soft** bounce deliberately — the review's
dangerous case, where no suppression row exists to save us. Ordering is explicit, not raced: the
defect is the missing CAS, and a test depending on scheduler luck would be worth nothing. RED,
proven per-defect with the Date fix applied alone so it does not mask them:

- `expected 'replied' to be 'bounced'` — reply revived a bounced lead
- `expected 'replied' to be 'unsubscribed'`
- `expected 2026-07-16T…Z to be null` — follow-up not cleared on bounce
- `expected 2 to be 1` — double-counted bounces
- positive control passed throughout

## W-3 — Bcc silently dropped on Outlook

**Fixed, failing closed.** The Graph adapter returns terminal `outlook_bcc_unsupported` when
`content.bcc` is non-empty. Graph's MIME `sendMail` takes no envelope and derives recipients from
the headers; the composer deliberately omits Bcc; so a blind recipient existed nowhere Graph
could see it — 202 accepted, never delivered, while SMTP and native deliver the same bytes via
RCPT TO.

**The no-Bcc-header composition is preserved exactly**, as instructed. Adding a Bcc header would
trade a silent non-delivery for a silent disclosure of every blind recipient to every other
recipient — strictly worse. Latent today (no caller sets bcc); this is the guard for the moment
one does.

## W-4 — Message-ID used the mDNS-reserved `.local`

**Fixed.** `createStableOutreachMessageId(organizationId, idempotencyKey, fromAddress)` publishes
`<xmail-${digest}@${sender domain}>`.

**Phase 18 idempotency untouched, as cautioned.** The digest is still
`sha256(organizationId, idempotencyKey)` and still lives in the **local part**, so a retry
recomputes the same id. Asserted directly: the local part is identical across two different
sender domains, and differs across idempotency keys.

**Reply/bounce matching verified end to end, as cautioned.** The dispatcher stores the id
unbracketed (`:632`) and the matcher strips brackets and `LOWER()`s; the domain is lowercased at
mint so the stored value and the composed header stay byte-identical. `provider-parity.test.ts`
derives its stored form from the composed header and still matches replies and bounces — those
tests pass unchanged.

`From` is always `account.email`, so deriving the domain from the same value keeps the two
aligned by construction. The address comes from the policy snapshot the dispatcher already loaded
(`AccountPolicySnapshot` gains `email`; the loader's column list was not selecting it). Minting
moved **inside** the existing `try`: it is now fallible for an account with no usable domain, and
that must become a normalized provider failure that releases the lease rather than an exception
that strands the claim. Throwing beats falling back — a bogus Message-ID is not a better outcome
than a failed dispatch. Already-sent messages keep their stored ids; only new sends change.

## W-5 — `retry_at` and the ingest lease written but never honoured

**Partially fixed. The two halves are independent, and C-2 addressed neither** — my C-2 fix uses
row locks, so it never touched the cursor lease. Correcting the brief's expectation here.

**Fixed: `retry_at`.** It was small and safe, so I did it. `loadIngestableAccounts` skips any
account whose cursor carries a future `retry_at`. Self-healing by construction — `saveCursor`
clears `retry_at` on every success, so a stuck value can only delay one account until the
timestamp it already carries. Asserted, together with the two cases that must NOT be skipped: no
backoff, and **no cursor row at all**, which is every account's first tick. RED (with the selector
present but the predicate absent): *"expected ['backed-off@example.test', 'due@example.test'] to
deeply equal ['due@example.test']"*.

**Deferred: the cursor lease / double ingest.** `processReplies` (*/15) and `processBounces`
(*/30) take different advisory locks and both call `ingestOutreachInbound`, so on every colliding
tick each account is ingested twice — doubling provider API calls and Graph throttle exposure.
Fixing it needs the cursor lease to be an **upsert**-lease (a new account has no cursor row yet,
so a plain conditional UPDATE would match nothing and skip it forever), plus release-on-completion
interacting with `saveCursor`'s error/retry clearing. That is not the small, safe change
`retry_at` was, so per the brief it is left and recorded here rather than expanding scope.

Mitigating meanwhile: ingestion is idempotent (`ON CONFLICT DO NOTHING`), so the cost is API
calls, not duplicate events — and honouring `retry_at` now removes the worst case, where a
throttled account was re-hammered on the very next tick.

## GAP-1 — PROV-02 over-claimed proven send capability

**Fixed in wording, in both documents.** `19-04-PLAN.md`'s `must_haves` truth now reads: read
capability **proven** by a real bounded sync; write/send **asserted** from the granted
Mail.ReadWrite/Mail.Send scopes; never verified send-only. `19-04-SUMMARY.md` carries the same
correction at the activation-gate section. The code was always honest
(`OUTLOOK_CAPABILITY_GATE`, returned to the caller as `gate`), so this is the plan catching up to
it — not a behaviour change. The safety property that matters is unchanged and is proven.

**The real-tenant sandbox run is recorded as an outstanding operator prerequisite** in both
documents, as instructed. 19-04's own `<verification>` block mandates it and it was never run:
the entire Graph surface — delta reader, 410 resync, throttle handling, MIME send, capability
gate — is verified against mocked `fetch` only, and no real Microsoft tenant has ever been
contacted by this code. Automated coverage cannot retire it: a mock cannot tell us that Graph
accepts our MIME, that the scopes we request are the scopes Microsoft grants, or that a real DSN
arrives shaped the way the classifier expects.

The summary's claim that *"a throttled sync leaves the account pending"* was aspirational when
written; W-1's fix makes it true, and that is noted there too.

---

## Found while fixing: `markAsReplied` threw on every matched reply

Not in the review. Surfaced by W-2's DB test and isolated against real Postgres.

`markAsReplied` bound a raw `Date` inside a drizzle `sql` template:

```ts
nextFollowUpAt: sql`CASE WHEN EXISTS (…) THEN ${now} ELSE NULL END`   // now: Date
```

Drizzle converts `Date → string` only for **direct column assignments**. Inside a raw `sql`
fragment the value reaches postgres-js as an untyped parameter and throws:

> TypeError: The "string" argument must be of type string or an instance of Buffer or
> ArrayBuffer. Received an instance of Date

Isolated empirically against the disposable container:

| Shape | Result |
|---|---|
| `set({ ts: date })` | works |
| ``set({ ts: sql`CASE … THEN ${date} … END` })`` | **throws** |
| ``set({ ts: sql`CASE … THEN ${date.toISOString()}::timestamp … END` })`` | works |
| raw postgres-js tagged template with a Date | works |

So **every matched reply threw**, on every provider, since this shipped. The throw was swallowed
by the consumer's error path, so replies were silently not recorded. Nothing caught it because
every existing test of these jobs mocks `db` — this is exactly the class of defect the review
notes the suite cannot see, and it took a real database to find.

Fixed as part of W-2 (the CASE was being rewritten anyway). Added `sqlTimestamp()` with the
explanation, because the bug **reproduced itself immediately** in W-5's new `retry_at`
predicate — TypeScript cannot see it (`sql` accepts anything), so the idiom needed a named home
rather than a comment.

## Test-infrastructure changes

Three cross-file interference failures appeared once these DB suites existed. All were test
issues, not code issues, and are fixed structurally rather than papered over:

- **Migration applies serialized** behind an advisory lock in `postgres-harness.ts`. Our
  `IF NOT EXISTS` / `DO $$ IF NOT EXISTS $$` guards are idempotent applied serially but race when
  two suites interleave: both see "not exists", both `ADD CONSTRAINT`, the loser fails. Production
  applies migrations serially by hand, so this is purely a vitest-parallelism artefact.
- **The postgres project runs one file at a time** (`fileParallelism: false`). These suites share
  one database and drive jobs that are global by design — `processFollowUps` selects every due
  `campaign_lead`, and the inbound claim selects across organizations (deliberately; the review's
  Refuted section confirms scoping happens per handler). In parallel they consume each other's
  queued rows.
- **Baseline schema extended** with the migrations the Drizzle snapshot predates and the current
  outreach contract needs: `012` (email_accounts.provider, outlook_mailbox_id, nullable smtp_*),
  `015` (mailboxes.is_native), `018` (skip_tls_verify), `025` (folder uid tracking), `033`
  (mailbox_provider). Drizzle selects every mapped column, so a missing one fails the read.

Known limitation, unchanged: the test baseline's `suppressions` table still carries the snapshot's
`server_id` shape rather than production's `organization_id` — no migration converts it (the
"mutually exclusive server-vs-organization schemas" the harness documents). The W-2 tests use a
soft bounce, which is the review's dangerous case anyway and does not touch that table. The
hard-bounce suppression insert remains covered only by mocked tests.

## Out of scope — noted, not fixed

Unchanged from the review's own list, confirmed still present:

- `mailboxes.ts:490` — `rejectUnauthorized: false` on the webmail IMAP path.
- `native-send.ts:60-69` — `relayMessage` uses `secure:false` with no `requireTLS` and bypasses
  `smtp-security.ts`, so the native adapter is not covered by PROV-01's "TLS semantics live in one
  place" claim. **Same class as C-1**, pre-existing, and C-1's fix does not reach it.
- `mail-sync.ts:521` — same latent TLS bug on the webmail path.

Nothing in the review's **Refuted** section was re-litigated.

## Commits

| Commit | |
|---|---|
| `e5b712c` | test(19): reproduce C-1 cleartext AUTH on port 25 |
| `2e20cdf` | fix(19): require STARTTLS whenever SMTP credentials are submitted |
| `6b37cae` | test(19): reproduce C-2 loss of claimed inbound events on crash |
| `a218033` | fix(19): hold the inbound claim across the side effect |
| `c973a23` | test(19): reproduce C-3 native inbound reading an ex-member's mailbox |
| `a0db7ee` | fix(19): scope the native inbound mailbox to the account's organization |
| `3cc3dc6` | test(19): reproduce W-1 Outlook verifying on a Graph throttle |
| `408e8ed` | fix(19): require evidence of a real read before verifying Outlook |
| `8a2cc87` | fix(19): never revert a terminal lead status, and stop binding a Date in raw SQL |
| `6a2a0ca` | test(19): reproduce W-3 bcc silently dropped on the Outlook path |
| `730ac1b` | fix(19): refuse a bcc on Outlook rather than dropping it silently |
| `af44975` | test(19): reproduce W-4 Message-ID on the mDNS-reserved .local TLD |
| `2deda95` | fix(19): mint the Message-ID on the sender's real domain |
| `0a9d9e0` | docs(19): state what the Outlook gate actually proves (GAP-1) |
| `8cbf648` | fix(19): honour the provider's Retry-After in the ingest loop (W-5, partial) |

## Gates

| Gate | Result |
|---|---|
| `npm run test` | **353 passed** (23 files) — was 315/19 |
| `npm run build` | pass (client + server) |
| `npm run lint` | pass, 0 warnings |
| `npx tsc --noEmit -p tsconfig.server.json` | pass |
| `npx tsc --noEmit -p tsconfig.json` (client) | pass |

New tests: **38** across 4 new DB suites (`outreach-inbound-claim`, `outreach-inbound-native-tenancy`,
`outreach-terminal-state`, `outreach-inbound-retry`) and 4 existing unit suites.

Phase 18's cross-tenant regressions and its CAS/lease guarantees are intact — no Phase 18 test
was modified except to supply the new required `email` field on `AccountPolicySnapshot` fixtures.
No `drizzle-kit generate`/`db:push` was run; **no migration was written**; production was never
touched.
