---
phase: 19-provider-parity-and-deliverability
plan: 02
subsystem: api
tags: [outreach, mime, outlook, graph, deliverability, list-unsubscribe, threading, provider-parity]

# Dependency graph
requires:
  - phase: 18-outreach-safety-and-execution-reliability
    provides: Durable dispatcher with stable Message-ID minting, policy gate, and normalizeProviderFailure classification
  - phase: 19-provider-parity-and-deliverability
    plan: 01
    provides: smtp-security.ts shared TLS resolver (buildSmtpTransportOptions), reused unchanged
provides:
  - Single compose-once MIME contract (composeOutreachMime) shared by SMTP, native, and Outlook
  - Provider adapter interface with normalized accepted/messageId/providerId/failure outcome
  - Outlook Graph MIME send (sendMimeMessageWithOutlook) preserving unsubscribe + threading headers
  - OutlookGraphError carrying HTTP status for shared transient/terminal classification
  - toDispatchResult bridge from provider outcome to dispatcher result union
affects: [19-03, 19-04, 21-unified-inbox, 22-operator-thread-ui, 23-ai-inbox-automation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Compose once, transmit verbatim: every provider receives the identical raw buffer, no re-composition"
    - "The precomposed Message-ID always wins over a transport-invented one"
    - "Provider adapters report outcomes; they never write dispatch/attempt state"
    - "Header presence is asserted against composed bytes before an opaque provider accepts them"

key-files:
  created:
    - src/server/lib/outreach-provider.ts
    - src/server/lib/__tests__/outreach-provider.test.ts
  modified:
    - src/server/lib/outlook.ts
    - src/server/lib/outreach-sender.ts
    - src/server/lib/outreach-dispatch-provider.ts
    - src/server/jobs/processFollowUps.ts
    - src/server/lib/__tests__/outreach-entrypoints.test.ts

key-decisions:
  - "Outlook outreach uses Graph MIME sendMail (base64 body, Content-Type: text/plain); the JSON message shape is retired for outreach because it cannot carry List-Unsubscribe and returns no Message-ID"
  - "Bcc is composed into the SMTP envelope only, never into the message headers — nodemailer's stream composer always writes a Bcc header and only its SMTP transport strips it, so shipping those bytes to Graph would disclose blind recipients"
  - "The precomposed stable Message-ID is returned by every adapter; a transport-invented id is never propagated, because reply/bounce matching keys off the id the dispatcher already persisted"
  - "Graph 401 triggers exactly one refresh-and-retry; a second 401 is terminal so a revoked grant cannot loop"
  - "Adapter outcome (`accepted`) and dispatcher result (`success`) stay distinct shapes, bridged by toDispatchResult in one place"
  - "Agentic follow-ups carry a one-click unsubscribe (campaign traffic); manual transactional sends deliberately do not"
  - "routes/messages.ts and routes/outlook.ts keep the JSON sendMessageWithOutlook — webmail/admin sends are outside PROV-03's outreach scope"

patterns-established:
  - "One compose contract, three adapters: outreach-provider.ts is the only place account.provider is branched on"
  - "Provider errors carry a status code so one classifier maps both SMTP response codes and Graph HTTP statuses"

requirements-completed: [PROV-03, PROV-05]

# Metrics
duration: 18min
completed: 2026-07-16
---

# Phase 19 Plan 02: Provider Parity — Compose-Once MIME Summary

**Outreach is now composed exactly once as MIME and transmitted byte-identically by SMTP, the native relay, and Outlook Graph — so an Outlook inbox no longer silently strips List-Unsubscribe, loses its Message-ID, or breaks threading.**

## What Changed

### The bug

Each provider built its own message. SMTP handed nodemailer a subject/html/text/headers object. The native path re-composed that object into MIME. Outlook took a third path entirely — Graph's JSON `message` shape — which has nowhere to put `List-Unsubscribe`, silently discarded the caller's `messageId`, and returned nothing to correlate on. The code said so out loud:

```
// NOTE: sendMessageWithOutlook does not currently accept arbitrary headers (Graph API
// limits header customization). List-Unsubscribe via Outlook is a known P1 limitation
```

The consequences were not cosmetic. An Outlook-assigned lead received a bulk marketing email with no one-click opt-out (Gmail/Yahoo bulk-sender non-compliance), and `sendOutreachEmail` returned `messageId: undefined` for that branch — so `outreach_emails.message_id` was NULL and **no reply or bounce from an Outlook send could ever be matched back to its campaign lead**. `sendThreadedReply` didn't support Outlook at all. Which inbox the round-robin happened to assign decided whether the recipient's experience and our attempt history were correct.

### Task 1 — `src/server/lib/outreach-provider.ts` (TDD)

One compose contract, three adapters:

```
composeOutreachMime(input) -> { raw, messageId, envelope, content }
       |                             |                    |
     SMTP                         native               Outlook
  raw + envelope              relay(raw) + file     Graph MIME send
```

Every adapter receives the *same* `raw` buffer and returns the *same* precomposed `messageId`. A test asserts all three buffers are `.equals()`-identical and each still carries `List-Unsubscribe`, `List-Unsubscribe-Post`, and the stable `Message-ID`.

Details worth knowing:

- **`readMimeHeader` unfolds RFC 5322 continuation lines.** Not optional: nodemailer folds a long `List-Unsubscribe` across lines, so `raw.includes('List-Unsubscribe: <https://...')` reports "missing" on exactly the messages that matter. A test asserts the header really is folded before asserting the reader handles it.
- **Bcc never enters the message.** Verified empirically: nodemailer's stream composer writes a `Bcc:` header regardless of `keepBcc`/`hideBcc`; only its SMTP transport strips it. Since we ship the composed bytes to three providers, composing bcc would have leaked every blind recipient. The envelope is set explicitly instead.
- **`From` uses nodemailer's address object**, replacing `"${fromName}" <${email}>`, which produced a malformed header for any display name containing a quote and no RFC 2047 encoding for non-ASCII.
- **`createSmtpTransporter` moved here** and still resolves TLS solely through 19-01's `buildSmtpTransportOptions` — no duplication of the port/flag rule.

### Task 2 — Graph MIME send and dispatcher wiring

`sendMimeMessageWithOutlook` posts base64 RFC 5322 bytes with `Content-Type: text/plain` to `/me/sendMail`, keeping token refresh, the 20s timeout, and mailbox status bookkeeping. It rejects >4 MB locally as `413` (terminal — it will not shrink on retry), refuses a from-address the mailbox does not own, and throws `OutlookGraphError` carrying the HTTP status so the *existing* `normalizeProviderFailure` maps 429/5xx → transient-retryable and 4xx → terminal with no new classifier.

`outreach-sender.ts` now owns content only; `outreach-dispatch-provider.ts` has no `account.provider` branch left. Structural tests lock both.

## Verification Results

| Gate | Result |
|---|---|
| `npm run test` | **173 passed** (15 files) — was 131 at 19-01 |
| `npx tsc --noEmit -p tsconfig.server.json` | pass |
| `npx tsc --noEmit -p tsconfig.json` (client) | pass |
| `npm run build` | pass (client + server) |
| `npm run lint` | pass, 0 warnings |

New tests: **39** in `outreach-provider.test.ts` (RED-committed at `d9350ae`, GREEN at `046602a`), **+3** structural guards in `outreach-entrypoints.test.ts`.

The plan's manual gate — decoding the Graph MIME body — was executed against the real `sendMimeMessageWithOutlook` with a mocked `fetch`:

```
List-Unsubscribe: <https://app.example.com/o/u/tok>,
 <mailto:unsubscribe@example.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
In-Reply-To: <inbound@prospect.com>
References: <root@example.com> <inbound@prospect.com>
From: Seller Person <seller@example.com>
Message-ID: <xmail-deadbeef@outreach.local>
Content-Type: multipart/alternative; ...
```

Every one of those lines is something the JSON shape dropped.

## Success Criteria

1. **Provider choice does not change compliance headers or attempt history** — one composer; a test asserts byte-identical buffers across all three adapters and identical returned ids.
2. **Threaded Outlook replies preserve In-Reply-To/References** — composed for every provider; `references` is now forwarded from the frozen claim through the dispatch boundary.
3. **Dispatcher retry policy receives normalized provider outcomes** — Graph statuses flow through the existing `normalizeProviderFailure`; a 429 produces `retry_scheduled`, a 400 `failed`.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — Bug] Bcc would have leaked to all recipients**
- **Found during:** Task 1
- **Issue:** The plan asked to compose "From/To/Cc/Bcc". Probing nodemailer showed its stream composer always emits a `Bcc:` header (`keepBcc`/`hideBcc` have no effect there — only the SMTP transport strips it). Composing bcc and shipping those bytes to Graph/native would have disclosed every blind recipient.
- **Fix:** Bcc goes to the envelope only; a test asserts it is absent from `raw` but present in `envelope.to`.
- **Commit:** `046602a`

**2. [Rule 1 — Bug] Adapter/dispatcher shape mismatch routed delivered mail into the failure branch**
- **Found during:** Task 2 (caught by the RED test, not by inspection)
- **Issue:** The plan specifies the adapter returns `accepted`; the dispatcher's `ProviderDispatchResult` uses `success`. Passing an adapter result straight to the dispatcher made `success` undefined → falsy → failure branch → crash on `failure.classification`. A 429 test passed *for the wrong reason* under the same bug.
- **Fix:** Added `toDispatchResult` as the single bridge, used by the dispatch boundary and the tests.
- **Commit:** `046602a`

**3. [Rule 1 — Bug] Hand-built `From` broke on quotes and non-ASCII**
- **Found during:** Task 1
- **Issue:** `"${fromName}" <${email}>` emits a malformed header for `José "Zé" Silva` and never RFC 2047-encodes.
- **Fix:** nodemailer address object; test locks it.
- **Commit:** `046602a`

**4. [Rule 1 — Bug] `readMimeHeader` returned a leading space on folded headers**
- **Found during:** Task 1 GREEN (RED test caught it)
- **Fix:** Do not prepend a separator when the first line of a folded value is empty.
- **Commit:** `046602a`

### Additions (Rule 2 — missing critical functionality)

**5. Threaded replies dropped the References chain**
- **Issue:** `createThreadedDispatchProvider` never forwarded `input.references`, and `sendThreadedReply` had no such parameter — it set `References` to the parent id alone. The dispatcher already froze `message_references` on the claim; it was simply unused. Success criterion 2 ("Threaded Outlook replies preserve In-Reply-To/References") is not satisfiable without this.
- **Fix:** Added `references` to `ThreadedReplyParams`, forwarded it at the boundary, and de-duplicate the parent when it is already in the chain (the exact shape `processFollowUps` sends).
- **Commit:** `9b3a0c5`

**6. Agentic follow-ups carried no unsubscribe**
- **Issue:** The plan says threaded replies should include unsubscribe metadata "only when legally/product appropriate". An agentic follow-up is campaign traffic under the same bulk-sender rules as the first touch, but the threaded path had no way to express the header at all.
- **Fix:** `processFollowUps` now mints a one-click unsubscribe link for the campaign lead. Manual transactional sends (`/api/outreach/send-message`, documented in CLAUDE.md as one-to-one, not campaign traffic) deliberately still do not.
- **Commit:** `9b3a0c5`

**7. Graph 401 refresh-and-retry**
- **Issue:** The plan required testing "token refresh retry behavior", which did not exist — refresh was proactive-only, so a revoked/rotated token surfaced as a hard failure.
- **Fix:** One refresh-and-retry on 401; a second 401 is terminal. Factored `refreshOrMarkExpired` so both paths mark the mailbox expired on refresh failure.
- **Commit:** `046602a`

### Scope boundary (deliberately not done)

`routes/messages.ts` and `routes/outlook.ts` still call the JSON-shape `sendMessageWithOutlook`. Those are webmail/admin transactional sends, not outreach; PROV-03 is outreach-scoped. This mirrors 19-01's decision to leave the `mail_mailboxes` webmail path alone. `sendMessageWithOutlook` is therefore retained, not deleted.

## Notes for Later Plans

- **19-03/19-04 (Outlook inbound):** `OutlookGraphError` and the `refreshOrMarkExpired` helper are ready to reuse for Graph delta polling — classification and 401 handling should not be re-implemented.
- **PROV-02 gating:** locked decision 8 says Outlook activation requires a successful inbound sync. Outbound is now at parity, so an Outlook account that is send-only will look healthier than it is until 19-03/19-04 land the inbound gate. Worth verifying no operator can verify an Outlook inbox on outbound evidence alone.
- **Attachments:** `OutreachAttachmentInput` is plumbed through the composer (including `cid` for inline images) but no caller supplies attachments yet — Phase 22 owns that UI. The composer path is already tested for `hasAttachments` propagation to the native Sent copy.
- `providerId` (Graph `request-id`, SMTP queue response) is returned by the adapters but **not persisted** — `outreach_emails` has no column for it. It is diagnostic-only today; if provider-side correlation becomes useful for support, that needs a migration.

## Known Stubs

None.

## Self-Check: PASSED

- All 7 claimed created/modified files exist on disk.
- All 3 claimed commits (`d9350ae`, `046602a`, `9b3a0c5`) exist in git history.
- Quoted legacy comment verified against `git show 874d08d:src/server/lib/outreach-sender.ts`.
- Decoded Graph MIME header block reproduced from a live test run, not asserted from memory.
