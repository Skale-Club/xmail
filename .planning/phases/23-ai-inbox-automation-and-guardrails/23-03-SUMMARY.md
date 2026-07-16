---
phase: 23-ai-inbox-automation-and-guardrails
plan: 03
subsystem: outreach-inbox-ai-automation
tags: [ai, outreach, autonomous, safety, leases, audit, policy-gate, tenant-isolation, fail-closed]

# Dependency graph
requires:
  - phase: 23-ai-inbox-automation-and-guardrails
    plan: 01
    provides: migration 043 (outreach_ai_settings default-off, campaigns.ai_autonomous_enabled, outreach_ai_runs), buildInboxAiContext, inbox-ai-audit lifecycle (create/claim/complete/fail/defer/link)
  - phase: 23-ai-inbox-automation-and-guardrails
    plan: 02
    provides: requestAiDraftProposal (strict fail-closed proposal-only Xphere adapter)
  - phase: 22-unified-inbox-operator-experience
    provides: executeInboxSendCommand (single lease-aware policy-gated executor), createInboxSendCommand, resolveSendCommand (persisted-thread recipient/threading resolver)
  - phase: 21-unified-inbox-foundation
    provides: persisted normalized outreach_conversation_messages (full bodies) + materialization
  - phase: 18-outreach-safety-and-execution-reliability
    provides: shared delivery-policy gate (evaluateOutreachDeliveryPolicy) enforced inside the executor
provides:
  - "inbox-ai-automation.ts — pure, DB-free effective-autonomy intersection + idempotent scheduling + leased per-run processor (no send capability; source-proven)"
  - "inbox-ai-automation-runtime.ts — DB-backed wiring: autonomy loader, persisted-context resolver, durable-command creator, and the ONLY hand-off to executeInboxSendCommand"
  - "Retired legacy direct-send follow-up: processFollowUps no longer scans next_follow_up_at or calls the shared dispatcher; it claims audited leased runs and drains the inert legacy queue"

affects: [23-04 evaluations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Effective autonomy = pure intersection(org autonomous + campaign autonomous + org unpaused + campaign active + org outreach-enabled), re-evaluated at claim AND immediately before dispatch"
    - "Scope fence: the model proposes a body only; recipient/account/threading are resolved deterministically from the persisted conversation (resolveSendCommand), never from model output"
    - "One delivery path: every AI send is a durable Phase 22 command handed to the single executeInboxSendCommand executor; the automation modules import no provider adapter/sender/dispatcher (source-inspection regression test)"
    - "Held-not-resent: an ambiguous provider outcome parks the run as deferred-with-no-retry-time, which the claimability predicate excludes forever (no hidden retry loop)"

key-files:
  created:
    - src/server/lib/inbox-ai-automation.ts
    - src/server/lib/inbox-ai-automation.test.ts
    - src/server/lib/inbox-ai-automation-runtime.ts
  modified:
    - src/server/jobs/processReplies.ts
    - src/server/jobs/processFollowUps.ts
    - src/server/jobs/index.ts
    - src/server/lib/outreach-followup.ts
    - src/server/lib/__tests__/outreach-entrypoints.test.ts
    - src/server/jobs/__tests__/outreach-campaign-lifecycle.db.test.ts

key-decisions:
  - "New runtime module (inbox-ai-automation-runtime.ts) holds all DB/executor wiring so the pure module stays DB-free and its 'structurally incapable of sending' source proof has a single target"
  - "processFollowUps DRAINS the retired next_follow_up_at queue (no send) so agentic-campaign completion (which counts an armed follow-up as pending work) still finalizes; the column is now rollout-compat only"
  - "Autonomous send hands an immediately-claimed durable command to executeInboxSendCommand and observes the outcome, so the pre-dispatch autonomy recheck is meaningful and held/policy outcomes drive the run's terminal state"
  - "No new migration: everything uses migration 043's schema"

requirements-completed: [AI-01, AI-03, AI-04, AI-05]

# Metrics
duration: 22min
completed: 2026-07-16
---

# Phase 23 Plan 03: Autonomous Inbox Automation and Guardrails Summary

**The safety-critical plan: it retires the legacy direct-send follow-up and makes autonomous AI sending safe. Every autonomous decision is now an audited, leased `outreach_ai_runs` row; effective autonomy is the re-checked intersection of org + campaign enablement with the kill switches; the model can only propose a body while the recipient/account come from the persisted conversation; and every AI send is a durable Phase 22 command handed to the SINGLE `executeInboxSendCommand` executor — there is exactly one path from an AI decision to a sent email, and it passes the Phase 18 policy gate.**

## Performance

- **Duration:** ~22 min
- **Started:** 2026-07-16T21:59:43Z
- **Completed:** 2026-07-16T22:22:03Z
- **Tasks:** 3
- **Files:** 9 (3 created, 6 modified)

## Task Commits

1. **Task 1: schedule audited autonomous runs from persisted replies** — `c1d86c3` (feat, TDD RED→GREEN)
2. **Task 2: retire direct-send follow-up for leased command dispatch** — `be3b836` (feat)
3. **Task 3: remove legacy decider/guardrails and add kill-control posture log** — `7c5bdfe` (feat)

**Plan metadata:** (this commit) `docs(23-03)`

## Autonomous run state machine

```
(inbound reply commits + attribution succeeds, effective autonomy ON)
        │  scheduleAutonomousAiRun  (idempotent per campaign-lead+trigger)
        ▼
     pending ──claim(lease)──▶ running
        │                        │
        │        ┌───────────────┼───────────────────────────┐
        │        ▼               ▼                            ▼
        │  autonomy OFF     context/adapter fail        proposal = wait/complete/escalate
        │  or max reached   (fail-closed)               (audit only)
        │        │               │                            │
        │        ▼               ▼                            ▼
        │   completed(none)    failed(errorCode)          completed(action)
        │
        │  proposal = draft  ──▶ recheck autonomy (pause race) ─OFF─▶ completed(none, paused_before_dispatch)
        │                        │ ON
        │                        ▼
        │        resolve recipient/account from PERSISTED conversation
        │                        │
        │        create durable Phase 22 command (idempotent ai-cmd:<runId>) → link run→command
        │                        │
        │        hand claimed command to executeInboxSendCommand (Phase 18 policy gate)
        │                        │
        │     ┌──────────┬───────┼────────────┬─────────────┐
        ▼     ▼          ▼       ▼            ▼             ▼
     sent   duplicate  held   rescheduled  failed        lost
     completed(draft)  deferred deferred    failed        deferred
     +outreachEmailId  (NO retry (retryAt)               (short retry)
                        time → held,
                        never resent)
```

## Effective-control truth table (any single OFF/paused → NO send)

| org autonomous | org paused | campaign autonomous | campaign active | org outreach | effective | deny reason |
| --- | --- | --- | --- | --- | --- | --- |
| ON | no | ON | yes | ON | **ENABLED** | — |
| OFF | no | ON | yes | ON | disabled | org_disabled |
| ON | **yes** | ON | yes | ON | disabled | org_paused |
| ON | no | OFF | yes | ON | disabled | campaign_disabled |
| ON | no | ON | **no** | ON | disabled | campaign_inactive |
| ON | no | ON | yes | **OFF** | disabled | outreach_disabled |

Evaluated at **scheduling**, again at **claim**, and again **immediately before dispatch** (the pause-race recheck). The Phase 18 delivery policy (org outreach kill switch, suppression, daily/warm-up/spacing/health, campaign, account) is re-evaluated authoritatively a fourth time inside `executeInboxSendCommand` before the provider call.

## Report-back answers

**How the legacy direct-send path was retired (grep-proof).** The old `processFollowUps` scanned `campaign_leads.next_follow_up_at`, asked `decideFollowUp`, ran a partial `enforceGuardrails`, and called `dispatchOutreachMessage` DIRECTLY (an earlier revision called `sendThreadedReply`). All of that is gone:
- `processFollowUps.ts` now imports only `processDueAutonomousRuns` (the leased processor) + a bounded drain of the inert `next_follow_up_at` column. It contains **no** `dispatchOutreachMessage`/`sendThreadedReply`/`createThreadedDispatchProvider`.
- `outreach-followup.ts` deleted `decideFollowUp`, `enforceGuardrails`, `FollowUpContext` (incl. `lastReplyText`), `FollowUpDecision`, and `Guardrails`; only the strict fail-closed proposal-only draft adapter remains.
- `processReplies.ts` no longer feeds a sender — `next_follow_up_at`/`last_reply_text` are written for rollout compatibility only and are drained (never dispatched).
- Grep proof: `grep -E "sendThreadedReply|dispatchOutreachMessage|createThreadedDispatchProvider"` over `inbox-ai-automation.ts`, `inbox-ai-automation-runtime.ts`, and `processFollowUps.ts` returns **nothing**. A source-inspection regression test asserts this (and that those files import no `outreach-provider`/`outreach-sender`/`outreach-dispatch-provider` module), plus that the runtime reaches the wire only via `executeInboxSendCommand`.

**How effective autonomy requires org+campaign+unpaused, rechecked at claim and dispatch.** `evaluateEffectiveAutonomy` is a pure intersection of the five controls (see truth table). It is evaluated: (1) in `scheduleAutonomousAiRun` — an ineligible/off/paused conversation creates NO run; (2) at claim in `processAutonomousAiRun` — a control flipped off after scheduling yields a `completed(none)` no-action run, not a send; (3) via `reloadAutonomy` immediately before the command is created (the pause race) — a kill switch flipped during the model call yields `paused_before_dispatch` with no command; and (4) the executor re-runs the full Phase 18 policy before the provider call. The autonomous follow-up ceiling (`min(org max_autonomous_follow_ups, campaign max_follow_ups)`) is enforced deterministically at claim.

**How the model can't pick recipients/account/override policy.** The proposal adapter (`requestAiDraftProposal`) strips any invented `to`/`recipient`/`accountId`/`provider`/`policy`/`send` field and returns only `action|subject|body|outcome|followUpMinutes`. The automation processor uses ONLY `proposal.body` (and optional subject) as model-authored content; the recipient/account/threading come from `resolveSendCommand` over the persisted `outreach_conversation_messages` (a reply to the latest inbound), exactly like the Phase 22 operator reply resolver. A test drives a prompt-injection body demanding a send to `evil@attacker.test` and asserts the created command's recipient is still the persisted prospect and never the attacker address. Terminal policy denial is owned by the executor and cannot be overridden by the model.

**How ambiguous outcomes are held.** When the executor reports `held` (an ambiguous provider outcome), the run is parked `deferred` with `policyCode='provider_outcome_held'` and **no** retry time. `isAutonomousRunClaimable` excludes a deferred run whose `policyRetryAt` is null, so no later tick ever re-claims it — a held run is never resent (tested: a second `processAutonomousAiRun` on a held run returns `skipped` and never calls dispatch again). A policy *defer* (`rescheduled`) sets a real retry time for a bounded, time-gated re-arm.

**How Xphere stays fail-closed.** The proposal adapter is optional and typed-error-only: missing config → `no_decider_configured`; timeout → `decider_timeout`; unreachable → `decider_unreachable`; malformed → `decider_bad_response`; unsafe/no-body draft → `unsafe_output`. Each maps to a `failed` run with that `errorCode` and **no** send and **no** infinite retry (leases + bounded attempts). A persisted-context failure (`no_inbound_body`, `attribution_mismatch`) and a vanished resolution likewise fail closed. All of these are inspectable audit rows, never a dispatch.

**Final gate counts.** `npm run test` → **830 passed** (54 files; was 784, +46 automation tests). `npx tsc --noEmit -p tsconfig.json` (client) → 0 errors. `npx tsc --noEmit -p tsconfig.server.json` (server) → 0 errors. `npm run lint` → 0 warnings. `npm run build` → success.

## Crash / restart safety (leases + idempotency)

- **Claim:** `claimAiRun` flips pending/deferred/expired-running → running with a fresh lease + one bounded attempt; a concurrent tick with a live lease loses (`lease_held` → skip). Tested with an in-flight run holding a live lease.
- **Death after model response, before command:** the run's lease expires, `isAutonomousRunClaimable` re-admits it, the model is re-consulted; no command was created so nothing was sent.
- **Death after command created, before dispatch:** the durable command is queued; either this processor (on re-claim, idempotent `ai-cmd:<runId>` returns the same command) or the Phase 22 `processInboxCommands` tick dispatches it once — the command's `(org, idempotency_key)` uniqueness collapses any replay onto the same `outreach_emails` row (at most once).
- **Death after provider send, before finalize:** the executor's idempotency key returns `duplicate`, finalized as sent; the run links the resulting email id. Exactly-once linkage (run→command→outreach email) is asserted.

## Deviations from Plan

### New file beyond the plan's list

- **`src/server/lib/inbox-ai-automation-runtime.ts`** (production DB/executor wiring). The plan listed `inbox-ai-automation.ts` for both the pure logic and the wiring; splitting the DB-backed deps into a runtime module keeps the pure module importable without `DATABASE_URL` and gives the "structurally incapable of sending" source proof a single clean target (mirrors 23-02's `inbox-ai-suggestions.ts` split). Not a scope change.

### Auto-fixed / adjusted

**1. [Rule 3 - Blocking] Drain the retired `next_follow_up_at` queue to preserve campaign completion**
- **Found during:** Task 2 — `markCompletedCampaigns` (Phase 18) blocks completion while `campaign.agentic_followup_enabled = TRUE AND campaign_leads.next_follow_up_at IS NOT NULL`. Simply removing the direct sender would leave armed rows that never clear, so agentic campaigns would never complete.
- **Fix:** `processFollowUps` now drains due `next_follow_up_at` rows (sets them null, **no send**) alongside processing autonomous runs. The completion lifecycle (stay active while armed → complete once drained) is preserved without any send.
- **Files:** `src/server/jobs/processFollowUps.ts`.

**2. [Rule 1 - Obsolete-contract test] Update entrypoints + campaign-lifecycle tests**
- **Found during:** Task 2/3 gate. `outreach-entrypoints.test.ts` asserted `processFollowUps.ts` *contains* `dispatchOutreachMessage` and the `agentic:` idempotency key — the exact behavior this plan retires. `outreach-campaign-lifecycle.db.test.ts` mocked the deleted `decideFollowUp`/`enforceGuardrails` and asserted the legacy `completed` counter.
- **Fix:** the entrypoints test now asserts `processFollowUps` has **no** direct dispatcher/sender and delegates to `processDueAutonomousRuns`; the lifecycle test asserts the legacy row is **drained** (`legacyDrained === 1`) and the campaign then completes. These encode the new safety contract.
- **Files:** `src/server/lib/__tests__/outreach-entrypoints.test.ts`, `src/server/jobs/__tests__/outreach-campaign-lifecycle.db.test.ts`.

## Known Stubs

None. The autonomous path is fully wired end to end (schedule → claim → context → proposal → durable command → executor). Production wiring resolves recipients/account/limits from real persisted state; unit tests inject fakes for determinism. Two production wrinkles are handled inline (not stubs): the durable command's required `actor_user_id` is resolved to an org admin/member, and a not-yet-materialized reply schedules with null conversation/trigger ids that the processor resolves from the campaign lead at claim time.

## User Setup Required

None new for this plan's code. Autonomous follow-up remains OFF for every org/campaign after migration 043 (default-off); enabling it is an explicit two-level opt-in (org `autonomous_enabled` + campaign `ai_autonomous_enabled`) with an immediate org pause + kill switch. Xphere stays optional — without `XPHERE_*` config an enabled org's autonomous run becomes an inspectable `no_decider_configured` failed run, never a send. Migration 043 is still a manual production deploy step (unchanged from 23-01).

## Next Phase Readiness

- 23-04 (evaluations) can drive `processAutonomousAiRun` and `scheduleAutonomousAiRun` with injected fakes over the fixture corpus, asserting the safety invariants (no send when forbidden, held-not-resent, correct persisted input references, no invented recipients) structurally. The autonomous path is the only one permitted to link a send command, and it does so exclusively through `executeInboxSendCommand`.
- No blockers. A future cleanup migration may drop the now-inert `campaign_leads.next_follow_up_at`/`agentic_followup_enabled` compatibility columns.

---
*Phase: 23-ai-inbox-automation-and-guardrails*
*Completed: 2026-07-16*

## Self-Check: PASSED

- All 3 created files (`inbox-ai-automation.ts`, `inbox-ai-automation.test.ts`, `inbox-ai-automation-runtime.ts`) + this SUMMARY verified present on disk.
- All 3 task commits (`c1d86c3`, `be3b836`, `7c5bdfe`) verified in git history.
- Gates: 830 tests, client tsc, server tsc, lint (0 warnings), build — all green.
- Grep-proof: no `sendThreadedReply`/`dispatchOutreachMessage`/`createThreadedDispatchProvider` in the AI autonomous path; the wire is reached only via `executeInboxSendCommand`.
