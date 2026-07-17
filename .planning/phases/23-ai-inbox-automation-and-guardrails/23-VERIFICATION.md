---
phase: 23
phase_name: ai-inbox-automation-and-guardrails
status: passed
score: "6/6 AI requirements (AI-01..06); milestone-gate gap resolved — suite deterministic (907/907 ×3). Review critical + minors fixed and re-reviewed."
verified_at: "2026-07-16T23:18:00Z"
resolved_at: "2026-07-17T00:05:00Z"
verifier: gsd-verifier
gaps:
  - truth: "The milestone acceptance gate `npm run test` passes cleanly and deterministically (23-04 Gate A / 23-EVALS Part A record `898 passed`)."
    status: failed
    reason: >
      `npm run test` is NON-DETERMINISTIC. A cold run passes 898/898, but a re-run
      fails 10/10 tests in `campaign-sequences.db.test.ts` with
      `PostgresError: relation "outreach_settings" does not exist` (campaign create returns
      500 instead of 201). Root cause is a pre-existing cross-suite shared-database ordering
      dependency: `campaign-sequences.db.test.ts` (Phase 20 CONS-01) applies only migration
      040 in its beforeAll and relies on a *sibling* suite (`outreach-settings.db.test.ts` /
      `outreach-notification-policy.db.test.ts`, which apply migration 024) to have created
      `outreach_settings` earlier in the one shared disposable database. With `fileParallelism:false`,
      Vitest reorders files by its cached slowest-first timing on re-runs, so the sibling
      that seeds the table sometimes runs AFTER `campaign-sequences`. Phase 23 added a new
      `.db` suite (`inbox-ai-migration.db.test.ts`) which perturbs the sequencer and exposes
      the latent flake. This is a test-harness isolation defect in a NON-AI suite — it does
      not affect AI-01..06 product code, and production always has `outreach_settings`
      (migration 024) — but it makes the recorded milestone gate not reproducible and fails
      the explicit "run twice, identical results" acceptance check.
    artifacts:
      - path: "src/server/routes/outreach/__tests__/campaign-sequences.db.test.ts"
        issue: "beforeAll (line 67-71) applies only 040; never seeds outreach_settings (migration 024), so it depends on sibling-suite run order in the shared DB."
      - path: "src/test/postgres-global-setup.ts"
        issue: "Global setup applies only OUTREACH_TEST_BASELINE_MIGRATIONS (excludes 024), so outreach_settings is never seeded globally; per-suite seeding is inconsistent."
    missing:
      - "Make campaign-sequences.db.test.ts self-seed its full schema in beforeAll (apply 024_outreach_settings.sql, or applyHandWrittenMigrations + the outreach stack it needs) so it does not depend on sibling suite ordering."
      - "OR seed the complete outreach migration set (incl. 024) once in postgres-global-setup.ts so every .db suite starts from a complete schema regardless of file order."
      - "Re-run `npm run test` twice and confirm identical 898/898 before closing the milestone gate."
---

# Phase 23 Verification — AI Inbox Automation and Guardrails

**Phase Goal:** Turn the experimental Xphere follow-up path into a safe, opt-in inbox capability: operators get editable drafts from persisted conversations; orgs/campaigns may separately enable autonomous follow-up; every decision and send is auditable and passes the same policy/dispatch path as every other outreach send.

**Verified:** 2026-07-16T23:18:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification.

## Verdict

**The six AI requirements (AI-01..AI-06) are genuinely satisfied by source code and by deterministic tests — not by inference.** Every safety-critical claim in the CONTEXT locked decisions was verified by direct source inspection and confirmed by passing tests: the autonomous decision reaches the wire through exactly one path (`executeInboxSendCommand` → the Phase 18 policy-gated `dispatchOutreachMessage`); the AI modules import no provider adapter/sender/dispatcher (grep + a source-reading regression test); the suggestion module is structurally incapable of sending; Xphere is fail-closed; the audit stores references and hashes, never secrets; the public DTO redacts; effective autonomy is a re-checked intersection default-off at every layer; and ambiguous outcomes are held-not-resent. The 51-assertion adversarial eval corpus drives the REAL production functions (only the model/DB/provider boundaries are faked) and passes on every run, proving no forbidden action ever dispatches across the four adversarial classes.

**However, the phase is marked `gaps_found` for one reason: the milestone acceptance gate is not reproducible.** `npm run test` produced 898/898 on a cold run and then 888/898 (10 failed) on two subsequent runs. The failure is entirely in `campaign-sequences.db.test.ts` — a **Phase 20** suite with no AI involvement — caused by a pre-existing cross-suite shared-database ordering dependency that Phase 23 exposed by adding a new `.db` suite. It has no effect on AI-01..06 correctness or on production (where `outreach_settings` always exists), but it fails the explicit "run twice, confirm deterministic identical results" criterion and contradicts the recorded "898 passed" evidence in 23-04-SUMMARY / 23-EVALS Part A.

## Fresh verification evidence

| Check | Result |
|---|---|
| `npm run test` — Run 1 (cold cache, isolated) | **898 passed / 55 files / 0 failed** — matches the claimed count exactly |
| `npm run test` — Run 2 (concurrent with build/lint/tsc) | **888 passed / 10 failed** (1 file) |
| `npm run test` — Run 3 (isolated, warm cache) | **888 passed / 10 failed** — all 10 in `campaign-sequences.db.test.ts`: `relation "outreach_settings" does not exist` (500≠201) |
| **Determinism** | ✗ **NON-DETERMINISTIC** (898 vs 888) — see Gap 1 |
| AI-specific suites across all 3 runs | ✓ deterministic every run: `inbox-ai-evals` (51), `inbox-ai-automation` (46), `inbox-ai-suggestions` (32), `inbox-ai-context`+audit (30), `inbox-ai-migration.db` (14 cold) |
| `npm run build` | **exit 0** — Vite client (60 precache entries) + server `tsc` built |
| `npm run lint` | **exit 0**, zero warnings (`--max-warnings 0`) |
| `npx tsc --noEmit -p tsconfig.json` (client) | **exit 0**, 0 errors |
| `npx tsc --noEmit -p tsconfig.server.json` (server) | **exit 0**, 0 errors |
| AI-path direct-dispatch grep | `dispatchOutreachMessage`/`sendThreadedReply`/`createThreadedDispatchProvider` return **zero** matches in `inbox-ai-automation.ts`, `inbox-ai-automation-runtime.ts`, `inbox-ai-suggestions.ts`, `processFollowUps.ts` |
| Migration 043 provenance | Hand-written `supabase/migrations/043_ai_inbox_automation_audit.sql`; no Drizzle-generate path in the phase diff; `src/db/schema.ts` mirror matches the SQL |
| Phase diff | `0ee07f8..HEAD` = 18 commits (4 execute plans + docs), matching the four SUMMARYs |

The disposable PostgreSQL container (`postgres:16-alpine`, DB `xmail_test_*`, `max_connections=300`) applied migration 043 **twice** in `inbox-ai-migration.db.test.ts` (14 assertions), verifying default-off controls, all audit columns, the absence of secret columns, strict kind/status/action/lease/attempt/idempotency/approval CHECKs, all 7 indexes, DB-level tenant isolation via composite `(id, organization_id)` FKs, and RLS. Migration 043 is **not** applied to production (documented manual runbook step).

## Goal Achievement — Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | AI context is a deterministic bounded projection of persisted messages; fails closed without a usable inbound body; never uses `lastReplyText` | ✓ VERIFIED | `buildInboxAiContext` at `src/server/lib/inbox-ai-context.ts:211`; SHA-256 canonical serialization at `:307`; fail-closed `no_inbound_body`/`no_inbound_message`/`attribution_mismatch` at `:218,242,245`; `lastReplyText` written only as a legacy cache at `processReplies.ts:500`, never read by any AI module |
| 2 | On-demand suggestion is editable, failure-safe, and structurally incapable of sending | ✓ VERIFIED | `inbox-ai-suggestions.ts` imports no send primitive (grep=0); every failure mode → recoverable no-send run (`:141,206,243`); draft flows into the Phase 22 composer via `renderAiAssistant`/`insertDraft`; accept records approval only (`unified-inbox.ts:1151`) |
| 3 | Autonomy is explicit per org+campaign, default-off, immediately pausable | ✓ VERIFIED | `evaluateEffectiveAutonomy` intersection at `inbox-ai-automation.ts:88`; both org flags + `campaigns.ai_autonomous_enabled` DEFAULT false (`043...sql:58,62,121`; schema `:2174,2175,788`); immediate unconditional pause endpoint `unified-inbox.ts:1319` |
| 4 | Every AI send passes ALL policy checks via the single executor; AI never dispatches directly | ✓ VERIFIED | Single path `runtime.ts:459` → `executeInboxSendCommand` → `dispatchOutreachMessage` (Phase 18 gate) at `inbox-command-dispatch.ts:129`; recheck at schedule/claim/pre-dispatch (`automation.ts:168,354,427`) + 4th policy eval in executor; source-inspection regression test `inbox-ai-automation.test.ts:618-645` |
| 5 | Prompt/model/version/refs/decisions/approvals/sends/failures auditable; no secrets/hidden reasoning | ✓ VERIFIED | `outreach_ai_runs` schema stores references+hash (`043...sql:126`); `sanitizeModelParameters` redaction `inbox-ai-audit.ts:82`; migration test asserts no secret columns `inbox-ai-migration.db.test.ts:195` |
| 6 | UI/API expose status/history without leaking credentials/prompts/cross-tenant content | ✓ VERIFIED | `toPublicAiRun` allowlist DTO omits modelParameters/leaseToken/errorDetail/idempotencyKey/inputMessageIds (`inbox-ai-suggestions.ts:311`); every endpoint via `requireOutreachRead`/`requireOutreachWrite` + org scope (`unified-inbox.ts:159,186,1027-1360`) |
| 7 | Milestone gate `npm run test` is clean and deterministic | ✗ FAILED | 898 (cold) vs 888/10-failed (re-run); `campaign-sequences.db.test.ts` × `outreach_settings does not exist` — see Gap 1 |

**Score:** 6/6 AI requirement-truths verified; 1 milestone-gate truth failed.

## Requirement matrix (AI-01..AI-06)

| Requirement | Status | File:line evidence |
|---|---|---|
| **AI-01** — context from persisted messages, never header-only | ✓ PASS | Deterministic bounded builder over persisted `outreach_conversation_messages`: `src/server/lib/inbox-ai-context.ts:211`. Anchor = latest inbound with a usable body; headers-only → `no_inbound_body` (`:244`). Attribution guard rejects any cross-org/conversation row (`:216`). Facts come from campaign/lead metadata only (`:288`); `campaign_leads.lastReplyText` is never read (test `inbox-ai-context.test.ts:228`; write-only legacy cache `processReplies.ts:500`). |
| **AI-02** — on-demand suggestion editable, failure-safe, never implicitly sent | ✓ PASS | `generateInboxAiSuggestion` (`inbox-ai-suggestions.ts:108`) imports **no** dispatcher/send-command factory (grep=0). Missing-config/timeout/malformed/unsafe/missing-body each → inspectable `failed`/`no_action` run with null `sendCommandId`/`outreachEmailId` (`:141,206,243,256`). Draft inserts into the Phase 22 composer; `POST /ai-runs/:id/accept` records approval only (`unified-inbox.ts:1151`, `inbox-ai-audit.ts:427`). |
| **AI-03** — autonomy explicit per org/campaign, pause/kill | ✓ PASS | Two separate org flags + per-campaign flag, all DEFAULT false (`043...sql:58,62,121`; schema `:2174,2175,788`). `evaluateEffectiveAutonomy` requires org-on ∧ unpaused ∧ campaign-on ∧ active ∧ outreach-on (`inbox-ai-automation.ts:88`). Immediate, version-unconditional pause `POST /ai-automation-settings/pause` (`unified-inbox.ts:1319`). |
| **AI-04** — AI sends pass ALL policy checks; single path | ✓ PASS | The autonomous decision creates a durable Phase 22 command and hands it to the SINGLE `executeInboxSendCommand` (`inbox-ai-automation-runtime.ts:459,488`), which reaches the wire only via `dispatchOutreachMessage` with `origin:'unified_inbox'` (`inbox-command-dispatch.ts:129,275`) — the Phase 18 policy gate. Autonomy rechecked at schedule/claim/pre-dispatch (`automation.ts:168,354,427`). Legacy direct-send retired: `decideFollowUp`/`enforceGuardrails`/`FollowUpContext.lastReplyText` deleted from `outreach-followup.ts`; `processFollowUps.ts` drains the inert `next_follow_up_at` queue with no send. Grep + source-reading regression test (`inbox-ai-automation.test.ts:618`) enforce no provider/sender/dispatcher import. |
| **AI-05** — auditable; no credentials/hidden reasoning | ✓ PASS | `outreach_ai_runs` stores input-message-id array + context hash, prompt version, provider/model, redacted `model_parameters`, sanitized output, policy code, actor/approval pair, and command/email links (`043...sql:126-192`; lifecycle `inbox-ai-audit.ts`). `sanitizeModelParameters` recursively redacts secret keys (`:82`); error text length-bounded (`:100,367`). No system prompt / hidden reasoning is stored anywhere; migration test asserts no `api_key`/`authorization`/`secret`/`system_prompt`/`hidden`/`credential` columns (`inbox-ai-migration.db.test.ts:195`). |
| **AI-06** — UI/API expose status/history without leaking secrets/cross-tenant content | ✓ PASS | `toPublicAiRun` projects an explicit allowlist and omits `modelParameters`/`leaseToken`/`errorDetail`/`idempotencyKey`/`inputMessageIds` (`inbox-ai-suggestions.ts:311`; eval assertion `inbox-ai-evals.test.ts:498-520`). All 8 AI endpoints resolve org scope via `requireOutreachRead`/`requireOutreachWrite` and project through the DTO (`unified-inbox.ts:1026-1360`, helpers `:159,186`). |

## Declared must-have verification per plan

### Plan 23-01 (foundation: migration + context + audit)

| Must-have | Status | Evidence |
|---|---|---|
| Deterministic bounded persisted-message context, fail-closed on no inbound body | ✓ | `inbox-ai-context.ts:211`; 30 context/audit unit tests pass every run |
| Draft + autonomy are separate default-off settings; effective autonomy = intersection | ✓ | `043...sql:58,62`; `evaluateEffectiveAutonomy` `automation.ts:88` |
| Audit stores refs/hash/model/prompt/decision/policy/approval/links, no secrets | ✓ | `inbox-ai-audit.ts`; migration test asserts no secret columns |
| Migration 043 revalidated to the next free slot; mirrored in schema.ts | ✓ | 042 highest; `043...sql` + `schema.ts:2171-2264` column/type/check/index parity; `inbox-ai-migration.db.test.ts` applies it twice |

### Plan 23-02 (human-in-the-loop suggestion)

| Must-have | Status | Evidence |
|---|---|---|
| Suggestion uses persisted context + audit run; cannot send/schedule itself | ✓ | `inbox-ai-suggestions.ts` (no dispatcher import); source-level test |
| Missing config/timeout/malformed/disabled/missing-body → recoverable no-send | ✓ | `:118,141,206,243`; strict fail-closed adapter `outreach-followup.ts:147` |
| Operator explicitly inserts/edits before the Phase 22 send | ✓ | composer `renderAiAssistant`/`insertDraft`; accept = approval only |
| Public DTO omits credentials/hidden prompt/cross-tenant content | ✓ | `toPublicAiRun:311`; eval `:498` |

### Plan 23-03 (autonomous processor — safety-critical)

| Must-have | Status | Evidence |
|---|---|---|
| Autonomous work leased; enabled only when org+campaign on & unpaused | ✓ | `claimAiRun` leases (`inbox-ai-audit.ts:239`); intersection re-checked at claim (`automation.ts:354`) |
| Model cannot choose recipients/account or override policy | ✓ | recipient/account from `resolveSendCommand` over persisted thread (`runtime.ts:306`); adapter strips invented `to/recipient/accountId/provider/policy/send` (`outreach-followup.ts:119`); eval (c) |
| Every AI send → single `executeInboxSendCommand`; AI never dispatches directly | ✓ | `runtime.ts:459,488`; grep=0; source-inspection regression test |
| Pause rechecked immediately before dispatch; ambiguous held not resent | ✓ | `reloadAutonomy` pre-dispatch (`automation.ts:427`); held → deferred w/ null retry, excluded by `isAutonomousRunClaimable` (`:283,477`); eval "held never resent" |

### Plan 23-04 (controls, history, evals, UAT)

| Must-have | Status | Evidence |
|---|---|---|
| Org+campaign controls default-off, confirmed, immediately pausable, show effective scope | ✓ | endpoints `unified-inbox.ts:1284-1360`; controls tested in `UnifiedInboxPage.test.tsx` (113 client tests pass) |
| Redacted history shows trigger/decision/approval/policy/outcome without secret leakage | ✓ | `AiAutomationHistory` renders `toPublicAiRun`; history endpoints `:1093-1132` |
| Evals prove forbidden actions never dispatch (injection + every policy denial) | ✓ | `inbox-ai-evals.test.ts` (51 assertions, deterministic, passes every run) |
| Milestone completion requires full tests/build/lint/db-audit + recorded UAT | ⚠️ PARTIAL | build/lint/tsc/db-audit green; **full `npm run test` is non-deterministic** (Gap 1). UAT is documentary (23-EVALS Part B/C); the automated proofs it maps to are the deterministic AI suites, which pass. |

## Safety-critical scrutiny (as requested)

- **Eval suite drives real code, not trivial mocks.** `inbox-ai-evals.test.ts` imports and calls the production `generateInboxAiSuggestion`, `scheduleAutonomousAiRun`, `processAutonomousAiRun`, `requestAiDraftProposal` (real strict adapter with a fake `fetch`), `buildInboxAiContext`, `evaluateOutreachDeliverySnapshot` (the real Phase 18 evaluator), and `toPublicAiRun`. Only the AI-run store, the model, and the command dispatch hand-off are faked — the correct external boundaries. The four adversarial classes each have real assertions: (a) injection body → suggestion yields at most `awaiting_approval` with null send links, autonomous path with a pre-dispatch pause creates NO command (`createCommand`/`dispatchCommand` asserted not called); (b) foreign-org message → `buildInboxAiContext` throws `attribution_mismatch`, `requestProposal` asserted not called, DTO carries no input ids; (c) injection demanding `evil@attacker.test` → created command's `resolvedSend.to === [PROSPECT]`, and the real adapter strips invented control fields to the five allowlisted keys; (d) confident draft over a terminal `lead_unsubscribed` denial → run `failed`, null `outreachEmailId`. All pass deterministically every run.
- **`executeInboxSendCommand` is genuinely the only path to the wire.** Traced by source, not by trusting the grep claim: `inbox-ai-automation-runtime.ts` imports only `executeInboxSendCommand`/`resolveSendCommand`/`createInboxSendCommand`; the executor (`inbox-command-dispatch.ts`) is the sole module importing `dispatchOutreachMessage`, and it dispatches with `origin:'unified_inbox'` after revalidating org ownership — subject to the same Phase 18 policy verified in Phase 18. The pure automation and suggestion modules import no send primitive at all.
- **Xphere fail-closed.** `requestAiDraftProposal` returns typed error codes for missing config / timeout / unreachable / http-error / bad-response / unsafe-output; each maps to a `failed` run with bounded attempts and no send and no infinite retry. Real-adapter timeout and no-config paths are asserted in the eval suite.
- **The two harness deviations are SOUND (they do not hide a schema/migration problem).** `installCampaignsAiAutonomousColumn` and `installOutreachAiRunsTable` (`postgres-harness.ts:211,235`) are column-only baseline stubs so campaign-lifecycle suites' `SELECT`s from `outreach_ai_runs` do not 500; they carry column-for-column parity with 043. The dedicated `inbox-ai-migration.db.test.ts` still applies the **full** 043 twice and asserts every constraint, index, RLS policy, and composite-org FK — so the complete schema is exercised. These stubs are not the cause of Gap 1.

## Anti-patterns / notable findings

| Item | Severity | Impact |
|---|---|---|
| `npm run test` non-deterministic (Gap 1) | 🛑 Blocker (gate) | Milestone gate not reproducible; fails the "run twice, identical" criterion |
| `campaign-sequences.db.test.ts` self-seeds only migration 040, relies on sibling suite for `outreach_settings` | 🛑 Root cause | Cross-suite shared-DB ordering dependency in a Phase 20 suite; exposed by Phase 23 adding a `.db` suite |
| Logged `error: { message: "sql.begin is not a function" }` during a passing suite | ℹ️ Info | Benign — appears in both passing and failing runs; a handled error-path log, not a failure |

No AI-code anti-patterns found. No stubs, TODO/FIXME, hardcoded-empty renders, or orphaned artifacts in the Phase 23 AI surface.

## Milestone completion assessment (v1.4, phases 18–23)

- **AI-01..AI-06 are genuinely complete** in code and covered by deterministic, DB-free tests that pass on every run. The autonomous-send safety architecture (single executor, no direct dispatch, re-checked intersection, held-not-resent, fail-closed Xphere, redacted audit/DTO, DB-level tenant FKs) is real and defensible.
- **Correctly deferred (not falsely claimed done):** migration 043 unapplied to production (documented manual `psql` runbook step, consistent across all four SUMMARYs); the live-provider Xphere quality smoke is env-gated and out of CI; the 10-step staged operator runbook (23-EVALS Part C) is a deploy-time human check whose safety-critical outcomes are each proven by the deterministic Part-B automated suites. Migrations 038–043 unapplied to prod, the private Storage bucket, service-principal env vars, and the Outlook Graph sandbox gate remain deployment prerequisites — appropriately deferred.
- **The one thing standing between this phase and a clean `passed`** is the non-deterministic full test suite. It is a test-harness isolation defect in a **non-AI** Phase 20 suite (`campaign-sequences.db.test.ts`), with no product/runtime impact, but it invalidates the recorded "898 passed" milestone evidence and the required determinism check. Once the suite self-seeds `outreach_settings` (or global setup seeds the full schema) and two consecutive `npm run test` runs are confirmed identical, this phase and the v1.4 milestone are code-complete.

## Gaps Summary

One gap, structured in the frontmatter: **`npm run test` is not deterministic** — cold run 898/898, re-run 888/898 with all 10 failures in `campaign-sequences.db.test.ts` (`relation "outreach_settings" does not exist`). Root cause is a pre-existing cross-suite shared-database ordering dependency, not any Phase 23 AI code. Fix: make `campaign-sequences.db.test.ts` seed its own schema (migration 024) in `beforeAll`, or seed the full outreach migration set once in `postgres-global-setup.ts`; then confirm two identical runs. No AI-01..AI-06 gap exists.

## Human verification

Deploy-time only (correctly out of the CI executor's reach): apply migration 043 to a two-tenant staging environment and run 23-EVALS Part C (live draft/autonomous send, policy denial, immediate pause, Xphere timeout, container-restart idempotency, org-B isolation, disclosure audit). Each maps to an automated proof already passing deterministically.

---

_Verified: 2026-07-16T23:18:00Z_
_Verifier: Claude (gsd-verifier) — source inspection + fresh gate runs, not SUMMARY claims_

## Resolution addendum (2026-07-17, post review-fix)

The verifier passed all six AI requirements on code+test evidence but marked the phase `gaps_found` on
one milestone-gate gap (non-deterministic suite). A parallel 3-lens code review (`23-REVIEW.md`) —
AI-send-path safety, tenant-isolation/audit-redaction, requirements verification — additionally found
**1 critical + 4 minor** (the tenant-isolation lens found ZERO). All blocking items are now fixed and
independently re-reviewed (both CONFIRMED FIXED at root cause, no new blockers):

- **C-1 (critical) — the `max_autonomous_follow_ups` per-thread ceiling was inoperative.** It read
  `campaign_leads.follow_up_count`, which the 23-03 refactor left un-incremented, so any positive cap
  was silently unlimited — every inbound prospect reply could spawn another autonomous AI send. Fixed:
  the count is now derived from `countAutonomousSends` — a tenant-scoped COUNT of `outreach_ai_runs`
  that genuinely dispatched (`run_kind='autonomous' AND status='completed' AND action='draft' AND
  send_command_id IS NOT NULL`, set at exactly one place: the executor's sent/duplicate branch). The
  re-review confirmed it advances exactly once per real send, is replay-safe, excludes the in-flight
  run, is org+lead scoped, cannot be influenced by the model, and that `max=0` blocks / `max=2` blocks
  the 3rd. A `.db` test drives N genuine sends through the real counting path and proves the (N+1)th is
  `no_action` (and that `follow_up_count` stays 0 — the direct RED against the old code). No new send
  path; the single-delivery-path invariant is intact.
- **G-1 (gap) — the full suite was non-deterministic** (a Phase 20 suite depended on a sibling suite's
  migration 024). Fixed at root by adding `024_outreach_settings.sql` to the global test baseline, so
  the run is order-independent. Verified 907/907 identical across 3 runs (with observed file
  reordering).
- **M-1** — the `attribution_mismatch` guard is now live on the suggestion path (stamps org/conversation
  from the DB row). **M-2** — `reloadAutonomy` is a required dep (the pre-dispatch pause recheck can't
  be silently skipped). **M-4** — the source-guard test now also proves the AI automation modules import
  no direct provider/dispatch primitive. **M-3** (within-org idempotency-key reuse) deferred as a
  documented low-priority within-tenant quirk.

Two new low-severity, non-blocking observations from the re-review, accepted as known:
1. A narrow crash-window over-count edge inherent to any count-based limiter — a run that dispatched
   but crashed before `completeAiRun` is briefly uncounted; self-heals because runs are processed
   oldest-first and a later run's inbound trigger postdates the send past the 60s lease. Vastly
   narrower than the original unbounded bug.
2. The behavioral ceiling test uses a hand-rolled `resolveRun` mirroring production plus a source-lock
   on the real wiring, rather than driving `resolveAutonomousRun` end-to-end. Current code traced
   correct.

**Fresh gates after fixes:** `npm run test` **907 passed (56 files)**, identical across 3 runs
(deterministic); build exit 0; lint 0 warnings; client and server `tsc --noEmit` both clean.

Phase 23 status is therefore **passed**. This is the final phase — milestone v1.4 (phases 18-23) is
code-complete. Remaining work is the manual production deploy (apply migrations 038→043 in order,
provision the private Storage bucket, set the service-principal env vars, run the Outlook Graph sandbox
gate, and the two-tenant/provider/restart + live-provider-send UAT rows), which is deliberately not
auto-applied.
