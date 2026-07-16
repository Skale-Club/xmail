---
status: issues_found
phase: 18
depth: standard
iteration: 2
files_reviewed: 31
findings:
  critical: 0
  warning: 3
  info: 0
  total: 3
---

# Phase 18 Code Review — Iteration 2

## Scope

Re-reviewed the Phase 18 implementation plus fixes `41bf478` through `412d273`, checking each of the seven previous findings against current source and tests. The fixes close the critical tenant, state-regression, quota, retry-classification, and frozen-payload defects. Three integration issues remain around completion/follow-up coordination and post-send bookkeeping.

## Resolution of Previous Findings

| Previous finding | Result | Evidence |
|---|---|---|
| CR-01 reply/bounce tenant scope | Resolved | Exact Message-ID matching now requires the active account; reply matching joins account and outreach organization, bounce matching also requires organization. Two-tenant PostgreSQL tests pass. |
| CR-02 terminal state overwrite | Resolved | Campaign-lead advancement compares the expected step and excludes all terminal statuses; lead promotion compares `status = 'new'`. |
| CR-03 shared account capacity | Resolved | `startDispatch` atomically reserves the account row, applies daily/warm-up/spacing conditions, and accepted/failure finalization counts or releases capacity idempotently. Daily and spacing contention tests pass. |
| WR-01 unknown timeout retry | Resolved | Phase-sensitive socket failures require an explicit pre-DATA SMTP command; missing phase is ambiguous/held. |
| WR-02 retry payload/tracking drift | Resolved | Claim returns the stored payload, including tracking/threading/A-B data, and provider dispatch uses it on retries. |
| WR-03 campaign completion race | Partially resolved | The select/update gap is gone, but enrollment is not serialized with the conditional update; see WR2-02. |
| WR-04 agentic reply context | Partially resolved | Message-ID and bounded body are persisted with scheduling, but campaign completion can cancel the scheduled follow-up; see WR2-03. |

## Warning Findings

### WR2-01 — Losing the terminal-state CAS suppresses bookkeeping for an email that was sent

**File/lines:** `src/server/jobs/processOutreachSequences.ts:340-369`

**Evidence:** After `dispatchOutreachMessage` returns `sent`, a failed progress CAS immediately executes `continue`. The dispatcher has already persisted `sent`, retained daily capacity, and incremented account `total_sent`, but the branch skips `result.sent`, the Xphere `sent` event, campaign `leads_contacted`, and the in-tick account spacing state.

**Impact:** The safety fix correctly preserves reply/bounce/unsubscribe status, but a real accepted send racing with that event is missing from campaign/operator analytics and event integrations. The same tick can also attempt another row for that account; the database reservation still blocks it, but the scheduler's local accounting becomes inconsistent.

**Correction:** Separate terminal progress preservation from fresh-send bookkeeping. Always perform idempotent sent-side effects for `dispatchResult.status === 'sent'`; only skip the campaign-lead status/step mutation. Persist campaign/event side effects from the durable ledger or an outbox so crash and race recovery cannot double-count. Add a test where provider finalization succeeds and the campaign-lead CAS returns zero rows.

### WR2-02 — A single conditional completion statement does not serialize concurrent or later enrollment

**Files/lines:** `src/server/jobs/processOutreachSequences.ts:425-454`, `src/server/routes/outreach/campaigns.ts:1080-1192`

**Evidence:** Completion now uses one `UPDATE ... NOT EXISTS`, which removes the prior application-level select/update window. Under PostgreSQL READ COMMITTED, however, the statement evaluates one MVCC snapshot and does not see a `campaign_leads` insert that commits after that snapshot. The enrollment route takes no shared campaign lock and does not reject a `completed` campaign; it can also add leads after completion normally.

**Impact:** A campaign can still become or remain `completed` while containing a nonterminal newly enrolled lead. Because due-work selection requires `campaign.status = 'active'`, that lead never runs.

**Correction:** Define and enforce enrollment lifecycle semantics. Serialize enrollment and completion on the same campaign row/advisory lock, rechecking terminal progress after acquiring it; reject enrollment into completed campaigns or atomically reactivate them with a defined policy. Add a PostgreSQL concurrency test, not a source-string assertion.

### WR2-03 — Terminal campaign completion can cancel a persisted agentic follow-up

**Files/lines:** `src/server/jobs/processReplies.ts:637-648`, `src/server/jobs/processOutreachSequences.ts:425-454`, `src/server/jobs/processFollowUps.ts:36-62`

**Evidence:** Reply ingestion now correctly stores `last_reply_message_id`, `last_reply_text`, and `next_follow_up_at`. The same mutation sets campaign-lead status to terminal `replied`. `markCompletedCampaigns` ignores pending agentic follow-up state, so when all campaign leads are terminal it marks the campaign completed. `processFollowUps` then requires `campaign.status === 'active'` and clears the persisted schedule.

**Impact:** Single-lead campaigns, or campaigns where all remaining leads replied, can lose their agentic response before it reaches the dispatcher. The cron schedules make this likely: completion runs every five minutes while follow-ups run every ten.

**Correction:** Make completion and agentic lifecycle semantics explicit: either exclude leads with pending agentic work from campaign completion, or allow opted-in agentic follow-ups to execute for completed sequence campaigns while still honoring pause/kill controls. Add an integration test covering reply ingestion, completion tick, and follow-up tick in order.

## Verification Evidence

- `npm run test` — PASS, 11 files / 91 tests, including migration rerun, quota/spacing contention, and two-tenant inbound matching.
- `npm run build` — PASS for Vite client and TypeScript server.
- `npm run lint` — PASS with zero warnings.
- Migration 038 and the Drizzle mirror include the same threading/capacity columns and reservation constraint; the disposable harness remains explicitly guarded and applies migration 038 twice.
- No product source, migration, test, or commit was changed by this re-review.
