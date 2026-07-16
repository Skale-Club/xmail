---
phase: 23-ai-inbox-automation-and-guardrails
plan: 04
subsystem: outreach-inbox-ai-controls
tags: [ai, outreach, controls, autonomy, audit, evaluations, safety, redaction, tenant-isolation, uat]

# Dependency graph
requires:
  - phase: 23-ai-inbox-automation-and-guardrails
    plan: 01
    provides: migration 043 (outreach_ai_settings default-off, campaigns.ai_autonomous_enabled, outreach_ai_runs), buildInboxAiContext, inbox-ai-audit lifecycle
  - phase: 23-ai-inbox-automation-and-guardrails
    plan: 02
    provides: generateInboxAiSuggestion, requestAiDraftProposal, toPublicAiRun (redacted DTO), AiDraftAssistant, ai-suggestions/ai-runs endpoints
  - phase: 23-ai-inbox-automation-and-guardrails
    plan: 03
    provides: scheduleAutonomousAiRun / processAutonomousAiRun, evaluateEffectiveAutonomy, executeInboxSendCommand hand-off (single policy-gated path)
  - phase: 18-outreach-safety-and-execution-reliability
    provides: evaluateOutreachDeliverySnapshot (policy codes) + guarded disposable-Postgres migration test harness
provides:
  - "Org + campaign AI automation control endpoints on unified-inbox.ts (default-off flags, immediate pause/resume kill switch, optimistic-concurrency, effective-scope calc, audit-actor log)"
  - "OrgAiAutomationControl + CampaignAiAutomationControl presentational controls (default-off, confirm-to-enable, immediate pause, effective-scope display; opt-in cannot override org)"
  - "AiAutomationHistory (redacted causal ledger) + org/campaign/conversation cursor history endpoints reusing toPublicAiRun (+ triggerMessageId reference)"
  - "inbox-ai-evals.test.ts — versioned (inbox-ai-evals@1) deterministic safety/quality corpus proving no forbidden dispatch incl. prompt injection + every policy denial + the 4 adversarial classes"
  - "23-EVALS.md — eval-set documentation + milestone v1.4 UAT evidence/runbook"
affects: [milestone v1.4 close]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Transparent opt-in: default-off, confirm-to-enable autonomy, IMMEDIATE pause (no version check), and always-visible effective scope (org∩campaign∩unpaused∩outreach)"
    - "AI endpoints extend ONLY unified-inbox.ts; reads requireOutreachRead, mutations requireOutreachWrite, every query org-scoped; audit actor via structured log (no schema change)"
    - "Presentational control/history components (props + callbacks) so the safety UI behaviors are unit-testable without a network"
    - "Deterministic eval corpus drives the REAL suggestion/autonomous/adapter/context/policy/DTO code with injected fakes — no trivial mocks"

key-files:
  created:
    - src/components/outreach/inbox/AiAutomationHistory.tsx
    - src/components/outreach/inbox/AiAutonomyControls.tsx
    - src/server/lib/inbox-ai-evals.test.ts
    - .planning/phases/23-ai-inbox-automation-and-guardrails/23-EVALS.md
  modified:
    - src/server/routes/outreach/unified-inbox.ts
    - src/server/lib/inbox-ai-suggestions.ts
    - src/lib/unified-inbox-api.ts
    - src/components/outreach/inbox/ConversationThread.tsx
    - src/pages/outreach/SettingsPage.tsx
    - src/pages/outreach/campaigns/tabs/OverviewTab.tsx
    - src/pages/outreach/UnifiedInboxPage.tsx
    - src/pages/outreach/__tests__/UnifiedInboxPage.test.tsx
    - src/test/postgres-harness.ts

key-decisions:
  - "Audit actor recorded via a structured audit log (outreach.aiControls) on each control change — no schema change, no new migration"
  - "IMMEDIATE pause is unconditional (no optimistic-version check) — a kill switch must never be blockable by a stale token; flag edits ARE version-guarded (409)"
  - "Campaign opt-in never overrides org off/paused — enforced by the shared evaluateEffectiveAutonomy intersection; the UI displays exactly why"
  - "toPublicAiRun gained triggerMessageId (a message-id REFERENCE, no content) so history shows the trigger without any leakage"
  - "New presentational control/history components (beyond the plan's file list) so the toggle/pause/effective-scope/redaction behaviors are unit-tested in UnifiedInboxPage.test.tsx"
  - "No new migration: everything uses migration 043's schema"

requirements-completed: [AI-01, AI-02, AI-03, AI-04, AI-05, AI-06]

# Metrics
duration: 32min
completed: 2026-07-16
---

# Phase 23 Plan 04: Transparent Controls, History, Safety Evals & Milestone UAT Summary

**The closing plan of milestone v1.4: transparent default-off/confirmed/immediately-pausable org and campaign autonomy controls that display their effective scope, a redacted causal history ledger, a deterministic adversarial evaluation corpus that proves no forbidden action ever dispatches (prompt injection + every policy denial + the four adversarial classes), and the recorded milestone UAT — with all gates green.**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-07-16T22:29:25Z
- **Completed:** 2026-07-16T23:01:52Z
- **Tasks:** 3
- **Files:** 13 (4 created, 9 modified)

## Task Commits

1. **Task 1: transparent AI automation controls + redacted history** — `dfd0037` (feat)
2. **Task 2: deterministic AI safety/quality evaluation suite** — `e0e1f76` (test)
3. **Deviation: seed outreach_ai_runs in the shared Postgres baseline** — `529af95` (fix)
4. **Task 3: milestone v1.4 UAT evidence + disclosure audit** — `add6c34` (docs)

**Plan metadata:** (this commit) `docs(23-04)`

## Report-back answers

**Opt-in controls (default-off / confirm / pause / effective-scope).** Two presentational controls
(`OrgAiAutomationControl`, `CampaignAiAutomationControl` in `AiAutonomyControls.tsx`) wired to
unified-inbox-only endpoints. Both the org draft + autonomous flags and the campaign flag are
**default-off** (they read `outreach_ai_settings` / `campaigns.ai_autonomous_enabled`, both DEFAULT
false). Enabling **autonomy** (org or campaign) opens a `ConfirmDialog` and only calls the mutation on
explicit confirm; **disabling** is immediate. **Pause** is a prominent one-click kill switch that
takes effect at once — the `POST /ai-automation-settings/pause` endpoint is unconditional (no
optimistic-version check, so a stale token can never block a kill switch), setting
`autonomy_paused_at`; Resume clears it. Every control always renders its **effective scope**: the org
banner shows OFF / PAUSED / BLOCKED (outreach disabled) / ACTIVE (and notes a campaign must also opt
in); the campaign banner shows ACTIVE or the exact reason it is not (`org_disabled` / `org_paused` /
`campaign_disabled` / `campaign_inactive` / `outreach_disabled`) — computed by the shared
`evaluateEffectiveAutonomy` intersection, so a campaign flag can never override the org being off or
paused. Flag edits are optimistic-concurrency guarded (`expectedUpdatedAt` → 409 `ai_settings_conflict`
on a stale edit); each change emits a structured `outreach.aiControls` audit log with the actor + org
(never content or a secret).

**Redacted history.** `AiAutomationHistory` renders ONLY the redacted `toPublicAiRun` DTO: run
kind/status, prompt version + model label, the **trigger message reference** (`triggerMessageId`, a
UUID reference — added to the DTO this plan) + time, the decision (action/outcome), the approval
actor/time, the policy code, and the command/send outcome (`Sent through the policy gate` when an
outreach email is linked, a policy code, or a failure code) — never a secret, hidden/system prompt,
model parameter, lease token, raw error detail, idempotency key, or cross-tenant body. It is surfaced
via `ConversationThread` (new `aiHistory` prop) on the open thread; new **org / campaign /
conversation** cursor history endpoints (`GET /ai-runs`, `GET /campaigns/:id/ai-runs`,
`GET /conversations/:id/ai-runs`) all project through the same allowlisted DTO. A grep disclosure
audit of the new UI confirmed zero secret fields.

**Adversarial eval set (`inbox-ai-evals@1`, 51 assertions).** It drives the REAL code —
`generateInboxAiSuggestion`, `scheduleAutonomousAiRun`/`processAutonomousAiRun`,
`requestAiDraftProposal` (real adapter + fake fetch), `buildInboxAiContext`,
`evaluateOutreachDeliverySnapshot`, `toPublicAiRun` — with injected fakes, no DB/network. It proves
**no forbidden action ever dispatches** for: prompt injection, unsubscribe, suppression, missing body,
OOO/auto-reply, bounce/DSN, org paused, campaign paused/inactive, org disabled, outreach disabled,
exhausted daily / warm-up / spacing (each denial code produced by the REAL policy evaluator), provider
timeout/malformed/missing-config, ambiguous provider (held, never resent), cross-tenant context, and a
duplicate tick. The **four adversarial classes** are each proven: (a) a body demanding an immediate
send → at most an `awaiting_approval` draft / no command created under a pause race; (b) a foreign-org
message → `attribution_mismatch` fail-closed with the **model never called** + a redacted DTO carrying
no input ids/other-tenant content; (c) a body demanding a send to `evil@attacker.test` → recipient
stays the persisted prospect and the real adapter strips any invented `to`/`accountId`/`policy`/`send`
field to the five allowlisted keys; (d) a confident model draft over a **terminal** policy denial →
run `failed`, no `outreachEmailId`, never resent.

**Milestone UAT contents (23-EVALS.md Part 2).** A recorded acceptance matrix mapping every required
check — draft-edit-vs-send separation, org/campaign enable/disable/pause races, **two-tenant
isolation**, a supported-provider autonomous send through the single policy gate, every **policy
denial**, Xphere timeout fail-closed, **process-death/restart** idempotency, history linkage,
viewer/member/admin visibility, and the **disclosure audit** — to its automated proof (full suite 898,
evals 51, db-audit 14), plus a 10-step staged operator runbook for the interactive deploy-time checks,
and the conclusion: **zero forbidden sends, duplicates, or cross-tenant leaks**.

**Final gate counts.** `npm run test` → **898 passed** (55 files; was 830 at 23-03, +17 client
controls/history +51 evals; the previously-red campaign-lifecycle `.db` suite is now green). `npx tsc
--noEmit -p tsconfig.json` (client) → 0 errors. `npx tsc --noEmit -p tsconfig.server.json` (server) →
0 errors. `npm run lint` → 0 warnings. `npm run build` → success.

## Deviations from Plan

### New files beyond the plan's list

- **`src/components/outreach/inbox/AiAutonomyControls.tsx`** (`OrgAiAutomationControl` +
  `CampaignAiAutomationControl`). The plan listed `SettingsPage.tsx` / `OverviewTab.tsx` as the wiring
  sites; extracting the controls as presentational components lets the safety behaviors (default-off,
  confirm-to-enable, immediate pause, effective-scope display) be unit-tested directly in
  `UnifiedInboxPage.test.tsx` (as the prompt requires), mirroring the 23-02/03 split pattern. Not a
  scope change.

### Auto-fixed / adjusted

**1. [Rule 3 - Blocking] Seed `outreach_ai_runs` in the shared Postgres baseline**
- **Found during:** the full `npm run test` gate (Task 3). `outreach-campaign-lifecycle.db.test.ts`
  500'd with `relation "outreach_ai_runs" does not exist`.
- **Root cause (pre-existing, Docker-only):** 23-03 made `processFollowUps` →
  `processDueAutonomousRuns` `SELECT` from `outreach_ai_runs` every tick, and a Phase-18 code-review
  fix (`4921984`, after 23-03) made this lifecycle suite drive that job. The generic baseline
  (`applyHandWrittenMigrations`) never seeded the table (only the `campaigns.ai_autonomous_enabled`
  column was, in 23-02), so the SELECT failed whenever Docker was available.
- **Fix:** added `installOutreachAiRunsTable` (a self-contained, column-only `CREATE TABLE IF NOT
  EXISTS` mirroring 043 and the existing `installCampaignsAiAutonomousColumn` pattern) to the baseline.
  The dedicated migration suite still applies the FULL 043 (twice) over it, adding every
  constraint/index/RLS via its own IF-NOT-EXISTS / DROP-then-ADD guards — verified both suites pass.
- **Files:** `src/test/postgres-harness.ts`
- **Commit:** `529af95`

## Known Stubs

None. Every control is wired to a real endpoint and real settings; the effective scope is computed
from live state via the shared intersection; the history renders live redacted runs. The eval suite
drives production code paths with injected fakes for determinism only.

## Issues Encountered

- Two initial eval assertions were my own fixture-math errors (a warm-up `currentDailySent` below the
  effective allowance, and asserting the anchor is the *last* message id when the newest message is
  outbound). Both fixed to match the real policy math and the anchor-retained invariant; no production
  code was wrong.

## User Setup Required

None new for this plan's code. AI inbox automation remains OFF for every org/campaign after migration
043 (default-off); enabling autonomy is a two-level, confirmed opt-in with an immediate pause. Xphere
stays optional + fail-closed. **Migration 043 is still a manual production deploy step** (unchanged
since 23-01): `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/043_ai_inbox_automation_audit.sql`.

## Next Phase Readiness

- Milestone v1.4 ("Reliable Outreach + Unified Inbox") is closed by this plan. AI-01..AI-06 are
  end-to-end demonstrated: assistance is useful and never implicitly sends, autonomy is explicit and
  stoppable, every send is policy-gated through the single executor, and every outcome is
  auditable/redacted with no cross-tenant or credential leakage.
- No blockers. Deploy-time follow-ups: apply migration 043 and run the staged operator runbook
  (23-EVALS.md Part C) against a live two-tenant environment.

---
*Phase: 23-ai-inbox-automation-and-guardrails*
*Completed: 2026-07-16*

## Self-Check: PASSED

- All 4 created files + this SUMMARY verified present on disk.
- All 4 task commits (`dfd0037`, `e0e1f76`, `529af95`, `add6c34`) verified in git history.
- Gates: 898 tests, client tsc, server tsc, lint (0 warnings), build — all green.
- Disclosure audit: no secret/prompt/model-parameter fields in the new AI UI surfaces.
