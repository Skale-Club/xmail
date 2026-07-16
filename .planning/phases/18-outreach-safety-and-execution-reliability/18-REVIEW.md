---
status: issues_found
phase: 18
depth: standard
files_reviewed: 29
findings:
  critical: 3
  warning: 4
  info: 0
  total: 7
---

# Phase 18 Code Review

## Scope

Reviewed the source files changed from `cf9d938^` through `98b27e6`, excluding `.planning/**` and `package-lock.json`, against plans 18-01 through 18-04 and SAFE-01 through SAFE-06. The focused 68 unit tests, production build, and lint all pass; the findings below are concurrency and integration paths not exercised by those tests.

## Critical Findings

### CR-01 — Reply and bounce Message-ID matching crosses account and tenant boundaries

**Files/lines:** `src/server/jobs/processReplies.ts:482-499`, `src/server/jobs/processReplies.ts:574-588`, `src/server/jobs/processBounces.ts:216-231`, `src/server/jobs/processBounces.ts:420-428`

**Evidence:** `matchReplyToOutreach` receives the inbox `accountId`, but its In-Reply-To and References branches call `findOutreachEmailByMessageId` without passing that account. The lookup filters only by `outreach_emails.message_id`. Bounce matching has the same problem and additionally performs a global partial `LIKE` lookup before the account-scoped recipient fallback.

**Impact:** An inbound message processed in organization A can reference a Message-ID issued by organization B and mutate B's outreach row, campaign lead, lead, campaign/account counters, and suppression state. The application DB role bypasses RLS, so there is no database safety net. This violates tenant isolation and can stop or corrupt another tenant's campaign.

**Correction:** Require `emailAccountId` in both Message-ID helpers and filter by exact normalized Message-ID plus the current account. Resolve and verify the account's organization before any mutation. For DSNs, avoid global substring matching; use an exact provider/original Message-ID where possible and keep recipient matching account-scoped. Add cross-organization reply and bounce integration tests.

### CR-02 — A late send completion can overwrite a reply, bounce, or unsubscribe and resume outreach

**Files/lines:** `src/server/jobs/processOutreachSequences.ts:137-154`, `src/server/jobs/processOutreachSequences.ts:328-334`, `src/server/jobs/processReplies.ts:607-623`, `src/server/jobs/processBounces.ts:256-267`

**Evidence:** The scheduler hydrates a nonterminal lead, performs provider I/O, then unconditionally writes `campaign_leads.status = 'contacted'`. It also writes `leads.status = 'contacted'` based on the stale pre-send snapshot. Reply and bounce jobs use different advisory locks and can set terminal state while that provider call is in flight.

**Impact:** A real reply/bounce/unsubscribe arriving during delivery can be reverted to `contacted`, leaving `next_scheduled_at` populated and allowing a later sequence email after the recipient has replied or become suppressed. This breaks SAFE-05 and creates compliance/deliverability risk.

**Correction:** Advance progress with a compare-and-set update constrained to the expected campaign-lead step and nonterminal status. Never replace an already-terminal status. Update the lead with a SQL `CASE` that preserves every terminal state, and clear scheduling when the conditional advance loses to a terminal event. Add a database race test that interleaves reply/bounce mutation between dispatch and finalize.

### CR-03 — Daily, warm-up, and spacing limits are check-then-send rather than atomically reserved

**Files/lines:** `src/server/lib/outreach-delivery-policy.ts:244-261`, `src/server/lib/outreach-dispatch.ts:481-505`, `src/server/jobs/processOutreachSequences.ts:336-343`, `src/server/jobs/processFollowUps.ts:194-196`, `src/server/routes/outreach/send-message.ts:75-77`

**Evidence:** Both policy checks read `current_daily_sent` and `last_sent_at`, but the durable claim reserves only a message idempotency key. Account counters are incremented after provider acceptance in separate statements. Campaign, follow-up, and manual sends use separate locks or no lock, so multiple distinct dispatches can all pass the same account snapshot before any increment is visible. A crash after `finalizeSent` also leaves the accepted message permanently absent from the quota counter because duplicate recovery intentionally does not increment it.

**Impact:** Concurrent manual/agentic/campaign traffic or a process crash can exceed daily/warm-up limits and minimum spacing, defeating the shared safety policy introduced by SAFE-01/SAFE-03.

**Correction:** Reserve account capacity atomically in the same database transaction as claim/start (row lock or conditional account update), keyed to the dispatch row so commit/release is idempotent. Reconcile accepted ledger rows to counters after crash. Add real PostgreSQL tests with two different idempotency keys racing on the same account at limit-1 and inside the spacing interval.

## Warning Findings

### WR-01 — A timeout without SMTP phase evidence is classified as safe to retry

**File/lines:** `src/server/lib/outreach-dispatch.ts:79-96`

**Evidence:** `preDataCommand` is true when `command` is missing. Therefore an `ETIMEDOUT`, `ECONNRESET`, or `ESOCKET` error without a Nodemailer command is classified as rejected/pre-acceptance and retried automatically, even though the provider interface also fronts HTTP/Graph and native adapters.

**Impact:** If such an error occurs after the provider accepted the request, the retry can duplicate an email—the exact ambiguity the lease state machine is intended to quarantine.

**Correction:** Treat a missing phase/acceptance signal as `unknown`/`ambiguous`. Only classify these errors as retryable when the adapter positively identifies a pre-acceptance SMTP phase or returns an explicit negative HTTP/provider response. Add a test for `ETIMEDOUT` with no `command`.

### WR-02 — Campaign retries send a new tracking token while the ledger retains the old token

**Files/lines:** `src/server/jobs/processOutreachSequences.ts:264-293`, `src/server/lib/outreach-dispatch.ts:299-305`

**Evidence:** Every tick creates a timestamped `generateOutreachToken`, including retries. The conflict/retry branch leases the existing row but does not update or return its persisted `tracking_token`; the provider is built with the newly generated token. Open/click routes look up the exact persisted token.

**Impact:** After a retryable pre-acceptance failure, the accepted retry contains tracking URLs that cannot match `outreach_emails`, so opens/clicks silently disappear. The persisted body/audit record can also diverge from the content rendered by a sequence edited between attempts.

**Correction:** Freeze the complete provider payload (including tracking token and rendered bodies) on first claim and have the claim return that stored payload for every retry, or derive a deterministic token from the logical dispatch key. Add a fail-then-retry integration test that exercises the tracking endpoint with the token in the second attempt.

### WR-03 — Campaign completion is selected and updated in separate statements

**File/lines:** `src/server/jobs/processOutreachSequences.ts:406-436`

**Evidence:** `markCompletedCampaigns` first selects campaigns satisfying the terminal predicate, then updates those IDs using only `status = 'active'`. Lead enrollment is not protected by the outreach advisory lock and can insert a new pending campaign lead between the SELECT and UPDATE.

**Impact:** A campaign can be marked `completed` while it contains a newly enrolled nonterminal lead, violating SAFE-05 and preventing the scheduler from processing that lead.

**Correction:** Perform completion as one conditional `UPDATE ... WHERE EXISTS (...) AND NOT EXISTS (...) RETURNING`, or lock/recheck each campaign in a transaction. Add a PostgreSQL concurrency test that enrolls a lead between eligibility and completion.

### WR-04 — Reply ingestion schedules agentic work without persisting the reply ID or body it requires

**Files/lines:** `src/server/jobs/processReplies.ts:215-228`, `src/server/jobs/processReplies.ts:373-386`, `src/server/jobs/processReplies.ts:553-565`, `src/server/jobs/processFollowUps.ts:66-76`, `src/server/jobs/processFollowUps.ts:123-127`

**Evidence:** Reply processing calls `markAsReplied` and schedules `next_follow_up_at`, but never writes `last_reply_message_id` or `last_reply_text`. Repository-wide search shows no writer for either column. The follow-up processor then clears the schedule whenever `lastReplyMessageId` is absent; its AI context also receives a permanently null reply body.

**Impact:** Agentic follow-ups cannot reach the newly durable dispatcher for replies ingested by either native or IMAP paths, despite the Phase 18 entrypoint wiring. The current static entrypoint test only checks source strings and does not execute this flow.

**Correction:** Persist a normalized inbound Message-ID and bounded reply body atomically with reply status, fetching the body for matched IMAP messages. Make scheduling contingent on successful persistence and add an end-to-end reply-to-follow-up test.

## Verification Evidence

- `npm run test -- <five Phase 18 unit suites>` — PASS, 5 files / 68 tests.
- `npm run build` — PASS for Vite client and TypeScript server.
- `npm run lint` — PASS with zero warnings.
- No product source, migration, or test file was modified by this review.
