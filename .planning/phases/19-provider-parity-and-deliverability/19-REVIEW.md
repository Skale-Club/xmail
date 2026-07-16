---
phase: 19
phase_name: provider-parity-and-deliverability
reviewed_at: "2026-07-16T06:30:00Z"
reviewers: 3 (correctness/concurrency, deliverability/security, requirements verification)
range: 98f3afd..601bc3e
status: fixes_required
findings: 3 critical, 5 warnings, 1 gap
---

# Phase 19 Code Review

Three independent adversarial reviewers over `git diff 98f3afd..601bc3e` (21 commits, ~8000 insertions).
Each finding below survived an explicit refutation attempt. Gates were green at review time
(315/315 tests, build, lint 0 warnings, both `tsc --noEmit` projects) — every finding is a
correctness/security defect the suite does not catch.

## CRITICAL

### C-1 — Port 25 submits SMTP credentials with no TLS guarantee

`src/server/lib/smtp-security.ts:107-117`

Port 25 resolves to `starttls_opportunistic` (`secure:false, requireTLS:false`) while
`buildSmtpTransportOptions` unconditionally attaches `auth`. An on-path attacker strips
`250-STARTTLS` from the EHLO response; nodemailer has no `requireTLS` to object, proceeds in
cleartext, and sends `AUTH LOGIN` with the decrypted mailbox password.

**Phase 19 regression, not pre-existing:** before this resolver, port 25 + `secure:true` attempted
an implicit-TLS handshake that *failed* — no send, no exposure. Phase 19 turns a hard failure into
a successful cleartext auth, and `canonicalSmtpSecure` makes `requireTLS:false` the canonical
stored state for port 25.

Internally inconsistent: the module's own comment says an *unknown* port gets required STARTTLS as
"the safe reading", yet port 25 — a known port — gets weaker treatment while authenticating.

### C-2 — Claimed inbound events are marked processed before the side effect, with no reaper

`src/server/lib/outreach-inbound.ts:601` (`claimPending`), `:459-486` (`consumeClassifiedEvents`)

`claimPending` commits `processed_at = now()` for the whole batch as a standalone autocommit
statement; `consumeClassifiedEvents` then loops calling `handle()`. The claim is durable before any
side effect exists and nothing un-claims a row.

A bounce tick claims 200 events and commits `processed_at` for all 200. The container is SIGKILLed
3 events in — routine, since `build-deploy.yml` blue-green rollout stops `xmail` on every push to
main. On restart `claimPending` filters `processed_at IS NULL`, so the other 197 are invisible
forever: `markAsBounced` never runs, leads stay `sent`, no suppression row is written, and every
hard-bounced address keeps receiving its sequence. No `processing_error` is recorded either, so the
operator query the code names at `:480` returns nothing. Silent at-most-once delivery of exactly
what migration 039's rationale calls unrecoverable.

`recordProcessingError` has the same hole for transient handler failures: it stamps an error on a
row already marked processed, so it is never retried.

**Migration 039 already provisions `lease_token` and `lease_expires_at` (`:76-77`, CHECK at `:129`)
— created, mirrored in schema.ts, and never read or written.** The fix is to use the lease the
migration already has. No new migration required.

### C-3 — Native inbound source resolves its mailbox with no organization check

`src/server/lib/outreach-inbound-sources.ts:75-78`

`createNativeInboundSource` calls `getNativeMailboxByEmail(account.email)`, which matches on
`email` + `isNative` only — no org predicate. The Outlook sibling at `:610-623` explicitly
re-checks `outlookMailboxes.organizationId`, with a comment naming this exact risk. The native path
never re-checks the membership its create-time gate relied on.

bob@skale.club is a member of Org A and Org B. Org A creates a native outreach account for bob
(gate passes). Bob is later removed from Org A — `DELETE /:id/members/:userId` removes only the
`organization_users` row; the `email_accounts` row survives, still `verified`. Every tick,
bob's **entire personal INBOX**, including `classification='other'` mail with full
`text_body`/`html_body` (039 retains bodies for Phase 21), is staged under `organization_id = Org A`,
whose RLS SELECT policy is `is_org_member(organization_id)`.

Phase 19 escalates this: the pre-19 native scan was equally unscoped but only persisted
`last_reply_text` for *matched* replies. It now durably copies every message body of a person's
private mailbox into a table an ex-org can read.

## WARNING

### W-1 — An Outlook account reaches `verified` on a Graph throttle

`src/server/lib/outlook.ts:293`, `src/server/routes/outreach/email-accounts.ts:765`

`evaluateOutlookOutreachCapability` treats "probe didn't throw" as proof of read capability, but
`fetchOutlookInboxDelta` deliberately **returns** on a throttle rather than throwing
(`if (isThrottled(response.status)) return paused(link, retryAfter)`). With `pagesFetched === 0`,
`paused()` degrades to `unchanged(retryAfter)`, ingestion completes normally, and the gate returns
`verified: true` — advertising `gate: "read capability is proven by a bounded initial inbox sync"`
when no sync happened. `isThrottled` also covers 503, so a Graph outage does the same. The
`outlook_inbound_sync_failed → pending` branch that exists precisely for this ("Microsoft was
unavailable or throttling") is unreachable for a first-page throttle.

**The test suite gives false confidence:** `outlook-inbound.test.ts:785` ("keeps the account pending
when the initial sync is only throttled") stubs `probeInbound` to *throw* on 429. The real
collaborator never throws on 429 — tests at `:358` and `:675` in the same file assert it returns a
result carrying `retryAfter`. The stub contradicts the production wiring.
`IngestResult.retryAfter`/`pagesFetched` are available at the call site and discarded by
`.then(() => undefined)`.

### W-2 — Concurrent reply/bounce consumers clobber each other's terminal state

`src/server/jobs/processReplies.ts:400,418`, `src/server/jobs/processBounces.ts:236-249,415`

`markAsReplied` sets `campaign_leads.status = 'replied'` with no CAS; its `leads.status` guard
preserves only `('replied','interested','not_interested')` — **not** `bounced`/`unsubscribed`.
`markAsBounced` clears `nextScheduledAt` but not `nextFollowUpAt`. The `status === 'bounced'` early
return is a non-atomic read-then-write. The two jobs take *different* advisory locks and run on the
same tick.

Lead X hard-bounces on step 2 while a human at the same address replied to step 1. If the reply
write lands last: `bounced → replied` on both rows, `nextFollowUpAt = now`, while
`campaigns.totalBounces` was already incremented — stats and lead state disagree and the lead reads
as engaged. Suppression still blocks a *hard*-bounce resend, but a **soft** bounce writes no
suppression row, `outreach-delivery-policy.ts` never checks `campaign_leads.status`, and
`processFollowUps` ships to a lead whose row says `bounced`.

Pre-existing code, but Phase 19 makes the combination routinely reachable: previously a DSN was
misrouted into the reply path (the bug 19-03 fixed), so reply-and-bounce for one lead rarely
coexisted. Now they are disjoint classifications applied in nondeterministic order by two
concurrently-scheduled jobs.

### W-3 — Bcc is silently dropped on the Outlook path

`src/server/lib/outreach-provider.ts:479-504`

The Graph adapter transmits `message.raw` but discards `message.envelope`. Graph MIME `sendMail`
derives recipients solely from MIME headers, and the composer deliberately omits the Bcc header
(correctly — see below). So a `bcc` recipient is delivered on SMTP (envelope → RCPT TO) and native,
but on Outlook is in neither headers nor envelope: accepted with 202, silently never delivered.
`findMissingMimeHeaders` doesn't catch it (Bcc isn't a required header).

Latent — no current caller sets `bcc` — but it breaks the "same bytes, same outcome, every
provider" contract the module asserts.

### W-4 — Message-ID uses the mDNS-reserved `.local` TLD

`src/server/lib/outreach-dispatch.ts:239`

`createStableOutreachMessageId` mints `<xmail-${digest}@outreach.local>`. `.local` is reserved for
mDNS (RFC 6762) and never resolves publicly, so every outreach message ships a Message-ID whose
domain neither matches `From` nor exists. Confirmed on composed bytes. Receiver-side filters score
Message-ID domain validity and From-domain correspondence on unsolicited bulk mail. Pre-existing on
SMTP/native, but Phase 19 extends it to Outlook — where Graph's JSON path previously produced a
valid tenant-aligned Message-ID — and codifies it as canonical for all three providers.

The digest is derived from `(organizationId, idempotencyKey)`; the local part carries identity, so
the domain can be swapped to the sender's real domain without disturbing Phase 18 idempotency or
reply matching.

### W-5 — `retry_at` and the ingest lease are written but never honoured

`retry_at` is persisted and indexed but `loadCursor` never selects it; ingestion visits every
account every tick, so Retry-After is bookkeeping only. Likewise `lease_token`/`lease_expires_at`
are provisioned and unused, so both jobs ingest every account each tick — doubling provider API
calls and Graph throttle exposure, which feeds W-1.

## GAP (verification)

### GAP-1 — PROV-02 over-claims proven send capability

19-04's declared truth says a verified Outlook account has "proven read, **write**, and **send**
capability." Read is genuinely proven (a real bounded sync gates activation). Write and send are
**asserted from the OAuth scope list**. The code is more honest than the plan —
`OUTLOOK_CAPABILITY_GATE` says so and returns it to the caller — and 19-04 pre-authorised the
fallback (Graph has no zero-send probe). The safety property that matters (*never verified
send-only*) **is** proven.

Compounding: 19-04's own `<verification>` block mandates a real-tenant sandbox gate that was never
run, so the whole Graph surface is verified only against mocked `fetch`.

Resolution: correct the wording to what is actually proven, and record the sandbox run as an
operator prerequisite. Not a defect — an over-claim.

## Refuted (recorded so they are not re-litigated)

- **Duplicate sends** — `stableMessageId` from `(organizationId, idempotencyKey)` threads into
  `composeOutreachMime`, so a retry reuses the same Message-ID; Phase 18 CAS/lease untouched.
  `toDispatchResult` correctly maps `accepted:true → success:true`.
- **Duplicate ingest / cursor past unprocessed work** — a slow worker can write a stale cursor, but
  every replay converges on `ON CONFLICT ... DO NOTHING`; `saveCursor` correctly follows staging.
- **Truncate-and-advance** — `messages.slice(0, pageSize)` would drop mail if a source overshot, but
  all three respect the bound (`top = Math.min(GRAPH_DELTA_PAGE_TOP, maxEvents)` closes the
  `syncOutlookInboundOnce` path). Latent only.
- **Cross-tenant leakage in the consumers** — `claimPending` is deliberately org-wide, but every
  handler scopes through `event.emailAccountId`; `loadCursor`/`recordCursorRetry` are unambiguous
  via the composite FK.
- **Bcc disclosure** — empirically confirmed: no `Bcc` header in the composed bytes, envelope
  carries recipients, and `raw` is what all three adapters transmit. 19-02's claim holds.
- **Header/RFC compliance** — verified on real composed output: RFC 8058 one-click, RFC 5322
  threading, RFC 2047 encoding, correct multipart/alternative. Header injection refuted
  (`replyToEmail` is email-validated; `trackingBaseUrl` is env).
- **DKIM/SPF/DMARC alignment** — `From` is always `account.email`; Graph path gated on
  `fromAddress === mailbox.email`; Graph MIME send does not break SMTP-path signing (disjoint
  transports).
- **Secrets** — no token, refresh token, password, or message body reaches a log or API response.
  `OutlookGraphError` carries status/request-id + a 500-char slice of Graph's *response* body only.
- **Unsubscribe integrity** — HMAC-signed, kind-scoped, 60-day TTL, constant-time compared;
  idempotent replay; no cross-tenant path; present on all campaign traffic including agentic
  follow-ups. `send-message.ts` correctly omits it (transactional).
- **Migration 039** — constraints, composite FKs and partial indexes sound and idempotent; TS mirror
  diffed programmatically 17/17 and 22/22 columns. Divergence is cosmetic only (partial predicates
  and one `DESC` absent from the mirror), harmless since SQL is source of truth.
- **Client→server import** (`smtp-security.ts`) — verified empirically safe: the module has zero
  imports; the client bundle contains no `nodemailer`/`drizzle-orm`/`imapflow`; `exclude` does not
  exclude *imported* files, so client tsc does typecheck it (`--listFiles`). Risk is that the
  invariant rests on a comment, not a lint rule.
- **`smtp-security.ts` purity** — total over its input domain; the 422-vs-normalize split is
  coherent.
- **Bracket normalization** — traced end-to-end (dispatcher stores unbracketed, matcher strips +
  `LOWER()`); consistent, so Outlook reply matching is not silently broken.
- **IMAP read-state** — verified in imapflow's own source that `source` fetch emits `BODY.PEEK[]`,
  so PROV-04's "doesn't consume read state" holds at the library level.

## Out of scope (tracked, not Phase 19)

- `src/server/routes/mail/mailboxes.ts:490` — `rejectUnauthorized: false` on the webmail IMAP path.
  Nothing in the Phase 19 diff disables cert validation.
- `src/server/lib/native-send.ts:60-69` — `relayMessage`'s transport uses `secure:false` with no
  `requireTLS` and bypasses `smtp-security.ts`, so the native adapter is not actually covered by
  PROV-01's "TLS semantics live in one place" claim. Same class as C-1, pre-existing.
- `mail_mailboxes` / `mail-sync.ts:521` — webmail path carries the same latent TLS bug. Confirmed
  live, correctly out of scope for outreach-only PROV-01.
