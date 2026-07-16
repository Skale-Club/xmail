---
phase: 23-ai-inbox-automation-and-guardrails
plan: 02
subsystem: outreach-inbox-ai
tags: [ai, outreach, inbox, xphere, suggestions, audit, human-in-the-loop, tenant-isolation, fail-closed]

# Dependency graph
requires:
  - phase: 23-ai-inbox-automation-and-guardrails
    plan: 01
    provides: buildInboxAiContext (persisted-message context + hash), inbox-ai-audit lifecycle (createAiRun/claim/complete/fail + awaitingApproval), migration 043 (outreach_ai_settings default-off, outreach_ai_runs)
  - phase: 22-unified-inbox-operator-experience
    provides: ConversationComposer + durable send commands (the single policy-gated send path)
  - phase: 21-unified-inbox-foundation
    provides: persisted normalized outreach_conversation_messages (full bodies)
provides:
  - "requestAiDraftProposal — strict, proposal-only, fail-closed Xphere draft adapter (bounds output, strips invented control fields, credentials in Authorization only)"
  - "generateInboxAiSuggestion — no-send-by-construction suggestion orchestrator (persisted context + audit run, gated on default-off draft setting, idempotent)"
  - "POST ai-suggestions / GET ai-settings / GET ai-runs / GET ai-runs/:id / POST ai-runs/:id/accept on unified-inbox.ts (redacted DTOs, org-scoped)"
  - "AiDraftAssistant composer integration — request/preview/insert/discard; the draft flows INTO the existing composer, never a second send path"
affects: [23-03 autonomous processor, 23-04 evaluations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Proposal-only adapter boundary: the model may propose subject/body/outcome/delay but can never name recipients/account/provider/policy or send — deterministic code owns all of that"
    - "No-send-by-construction: the suggestion service imports NO dispatcher; a source-level test asserts the forbidden send primitives never appear, so prompt-injection has nothing to call"
    - "Fail-closed everywhere: missing config/timeout/malformed/unsafe/missing-body → an inspectable failed/no-action run; a disabled org → a clean not-enabled gate with no run"
    - "Draft flows INTO the Phase 22 composer via an insertDraft render-prop with replace-confirmation; the operator edits, then uses the existing durable send path"

key-files:
  created:
    - src/server/lib/inbox-ai-suggestions.ts
    - src/server/lib/inbox-ai-suggestions.test.ts
    - src/components/outreach/inbox/AiDraftAssistant.tsx
  modified:
    - src/server/lib/outreach-followup.ts
    - src/server/routes/outreach/unified-inbox.ts
    - src/lib/unified-inbox-api.ts
    - src/hooks/useUnifiedInbox.ts
    - src/components/outreach/inbox/ConversationComposer.tsx
    - src/pages/outreach/UnifiedInboxPage.tsx
    - src/pages/outreach/__tests__/UnifiedInboxPage.test.tsx
    - src/test/postgres-harness.ts

key-decisions:
  - "The suggestion orchestrator is a NEW dedicated module (inbox-ai-suggestions.ts) so the whole no-send path is unit-testable without DB/network and the source-level 'cannot send' proof has a single, auditable target"
  - "A disabled draft setting returns a clean not_enabled response with NO audit row; the enabled-but-failed modes create an inspectable failed/no-action run"
  - "Accepting a suggestion (POST ai-runs/:id/accept) records approval only (approveAiRun) — it never sends; the send stays the separate Phase 22 composer action"
  - "No new migration: everything uses migration 043's schema"

requirements-completed: [AI-01, AI-02, AI-05, AI-06]

# Metrics
duration: 27min
completed: 2026-07-16
---

# Phase 23 Plan 02: On-demand AI Draft Suggestions Summary

**Human-in-the-loop AI draft suggestions in the Unified Inbox: a proposal-only, fail-closed Xphere adapter feeds a no-send-by-construction orchestrator that reasons over persisted messages, writes a redacted audit run, and hands an editable draft INTO the existing Phase 22 composer — the operator edits and sends through the one durable policy-gated path. The suggestion endpoint is structurally incapable of sending.**

## Performance

- **Duration:** ~27 min
- **Started:** 2026-07-16T21:19:49Z
- **Completed:** 2026-07-16T21:46:26Z
- **Tasks:** 3
- **Files:** 11 (3 created, 8 modified)

## Accomplishments

- **Task 1 — strict Xphere proposal adapter** (`outreach-followup.ts`). `requestAiDraftProposal` accepts only the canonical persisted context + prompt/run refs + an allowlisted tone; it calls the configured Xphere endpoint with a timeout and parses a strict `draft|wait|complete|escalate` schema. It bounds subject/body/outcome/delay, strips any invented control field (recipients/account/provider/policy/`send`), keeps the API key in the Authorization header only (never in the payload), and returns typed fail-closed error codes (`no_decider_configured`/`decider_timeout`/`decider_unreachable`/`decider_http_error`/`decider_bad_response`/`unsafe_output`). Legacy `decideFollowUp`/`enforceGuardrails` (still used by `processFollowUps`) are untouched.
- **Task 2 — no-send suggestion orchestrator + redacted endpoints** (`inbox-ai-suggestions.ts` + `unified-inbox.ts`). `generateInboxAiSuggestion` gates on the default-off `draft_assistance_enabled` setting, builds the persisted context, creates the audit run BEFORE the external call (recording input message ids + context hash + prompt version), claims it (lease + bounded attempts), and completes it to `awaiting_approval` with the editable draft — or fails it with an inspectable code. It imports NO dispatcher; a source-level test proves the forbidden send primitives never appear. `toPublicAiRun` redacts creds/model-parameters/error-detail/lease/idempotency/input-ids. The endpoints (`POST ai-suggestions`, `GET ai-settings`, `GET ai-runs`, `GET ai-runs/:id`, `POST ai-runs/:id/accept`) extend only `unified-inbox.ts`, with reads on `requireOutreachRead`, mutations on `requireOutreachWrite`, and a per-user/org rate limiter.
- **Task 3 — editable draft in the Phase 22 composer** (`AiDraftAssistant.tsx` + composer/hooks/page). An enabled-gated "Suggest draft" action requests → previews → inserts the body into the composer's normal editable field (`renderAiAssistant` render-prop + `insertDraft` with a replace-confirmation that preserves operator text). Inserting records acceptance against the run and NEVER sends; the subsequent send is the existing durable command path.
- **Gates:** full suite **784 tests** (53 files), client tsc, server tsc, lint (0 warnings), build — all green. Server suggestion suite: 32 tests. Client Unified Inbox suite: 87 → 96.

## Task Commits

1. **Task 1: strict Xphere draft proposal adapter** — `1e76d01` (feat, TDD RED written first)
2. **Task 2: tenant-safe suggestion orchestrator + redacted AI endpoints** — `0126d12` (feat)
3. **Task 3: editable AI draft assistant in the composer** — `c561b64` (feat)
4. **Deviation: seed campaigns.ai_autonomous_enabled in the test baseline** — `04e9daa` (fix)

**Plan metadata:** (this commit) `docs(23-02)`

## Report-back answers

**Suggestion endpoint contract.** `POST /api/outreach/unified-inbox/conversations/:id/ai-suggestions?organizationId=` (`requireOutreachWrite`). Body: optional `{ idempotencyKey, toneGoal }` (tone from a server allowlist). Responses: `201 { enabled:true, suggestion:{runId,subject,body}, run }` for an insertable draft; `200 { enabled:false, suggestion:null, run:null }` when draft assistance is off; `200 { enabled:true, suggestion:null, run }` for a no-action (`wait`/`complete`/`escalate`) or a recoverable failure; `409 { error:'ai_suggestion_in_progress', run }` for a duplicate while the first is still running; `404` for a foreign/missing conversation; `429 { error:'ai_suggestion_rate_limited' }`. Companion reads: `GET /ai-settings`, `GET /conversations/:id/ai-runs` (cursor-bounded), `GET /ai-runs/:id`; `POST /ai-runs/:id/accept` records approval only.

**How it is structurally incapable of sending.** The suggestion service (`inbox-ai-suggestions.ts`) imports NO send primitive — no `executeInboxSendCommand`, `dispatchOutreachMessage`, `sendThreadedReply`, or `createResolvedSendCommand`. Its only effects are (a) audit-run CRUD via an injected `AiRunStore` and (b) a proposal call to the adapter, which itself has no send capability. A run can only reach `awaiting_approval`/`completed`/`failed` — never a send/queued state — and `sendCommandId`/`outreachEmailId` stay null on the draft path. Two source-level tests assert the forbidden tokens never appear in either module, so a prompt-injection body in the conversation has literally nothing to call (verified: an injection body still yields at most an awaiting-approval draft).

**How each failure mode is recoverable / fail-closed (locked #8).** Missing config → `no_decider_configured` failed run; timeout → `decider_timeout` failed run; malformed/unsafe output → `decider_bad_response`/`unsafe_output` failed run; missing inbound body → the context builder's `no_inbound_body` failed run (created then failed, never a send); a `wait`/`complete`/`escalate` proposal → a `completed` no-action run with no draft. Each is an inspectable run with a machine `errorCode`, bounded attempts, and no infinite retry. The client renders the reason inline with a Try again affordance and inserts nothing.

**How it is gated on the default-off draft setting.** The orchestrator's FIRST step loads `outreach_ai_settings.draft_assistance_enabled` (or null when no row exists) and, when off, returns `not_enabled` with NO run created and NO external call — the endpoint answers `200 { enabled:false }`. The composer only renders the "Suggest draft" affordance when `GET /ai-settings` reports it enabled (`AiDraftAssistant` returns null otherwise).

**How the public DTO redacts (locked #5 / AI-06).** `toPublicAiRun` projects an explicit allowlist: id/scope, kind/status/action, prompt version/provider/model, the operator-facing `output*`, `policyCode`, a coarse `errorCode`, `contextHash`, actor/approval, command/email links, and usage/latency. It OMITS `modelParameters`, `leaseToken`/`leaseExpiresAt`, `errorDetail` (raw provider text), `idempotencyKey`, `inputMessageIds`, and attempts. A test injects secrets into a stored run and asserts they never appear in the DTO. No system prompt or hidden reasoning is stored anywhere to leak.

**How the draft flows into the existing composer (not a second send path).** `ConversationComposer` gained a `renderAiAssistant(insertDraft)` slot rendered inside the open editor. `AiDraftAssistant` requests → previews → on explicit "Insert into reply" calls `insertDraft(body)`, which copies the suggestion into the composer's normal editable `body` field (behind a replace-confirmation if the operator already typed) and records acceptance against the run. The operator then edits and clicks the existing Send reply, which creates the durable Phase 22 send command through the single policy-gated executor. The AI adds no send capability — it only pre-fills the body.

**Final gate counts.** `npm run test` → **784 passed** (53 files). `npx tsc --noEmit -p tsconfig.json` (client) → 0 errors. `npx tsc --noEmit -p tsconfig.server.json` (server) → 0 errors. `npm run lint` → 0 warnings. `npm run build` → success.

## Decisions Made

- **Dedicated orchestrator module.** The plan's `files_modified` listed the test but not a SUT module; a dedicated `inbox-ai-suggestions.ts` makes the whole no-send path unit-testable without DB/network and gives the "cannot send" source-level proof a single auditable target.
- **Disabled → clean gate, no run.** A disabled org gets `not_enabled` with no audit row (the feature is off); only the enabled-but-failed modes create an inspectable failed/no-action run. This satisfies both "not an error, not a draft" and "recoverable no-send result".
- **Accept records approval, never sends.** `POST ai-runs/:id/accept` uses `approveAiRun` (records approver + time on an awaiting-approval run) so acceptance is auditable; sending remains the separate composer action.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Seeded `campaigns.ai_autonomous_enabled` in the disposable-test baseline**
- **Found during:** running the full `npm run test` gate (Task 2/3 verification).
- **Issue:** 23-01 added `campaigns.ai_autonomous_enabled` to the canonical Drizzle schema + migration 043, but the shared disposable-Postgres baseline (`OUTREACH_TEST_BASELINE_MIGRATIONS`) never applied it. Every campaign-creating `.db` suite (`outreach-settings.db.test.ts`, `outreach-campaign-lifecycle.db.test.ts`) 500'd with `column "ai_autonomous_enabled" of relation "campaigns" does not exist` — a latent regression that only surfaces when Docker is available (23-01's run likely skipped the postgres project). The full 043 file cannot be replayed in the generic baseline (its composite FKs target the Phase 21/22 tables 041/042 do not seed there, and its RLS references helpers the harness deliberately stubs).
- **Fix:** applied the self-contained, idempotent `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_autonomous_enabled ...` inline in `applyHandWrittenMigrations`, mirroring the existing per-column baseline pattern (and the auth/RLS stub installers). Suites that exercise the full 043 schema still apply it explicitly.
- **Files modified:** `src/test/postgres-harness.ts`
- **Commit:** `04e9daa`

### New file beyond the plan's list

- **`src/server/lib/inbox-ai-suggestions.ts`** (the suggestion orchestrator + `toPublicAiRun` + rate limiter). The plan listed the test file but not the SUT module; the orchestrator is the natural home for the no-send logic and its structural "cannot send" guarantee. Not a scope change — it implements exactly Task 2's action.

## Known Stubs

None. `AiDraftAssistant` returning null when draft assistance is disabled is an intentional gate (not a stub); the composer receives real run/suggestion data, and the history list is wired to `useInboxAiRuns` (no hardcoded empty data flowing to the UI).

## Issues Encountered

- `import.meta.url` in the server test failed `tsc` under the CommonJS server tsconfig; switched the source-inspection helper to `process.cwd()`-relative resolution (works under both the CommonJS tsc project and the Vite/ESM runner).

## User Setup Required

None for this plan's code. Xphere draft suggestions remain OPTIONAL and fail-closed: without `XPHERE_DRAFT_URL`/`XPHERE_FOLLOWUP_URL` + an API key, an enabled org's request produces an inspectable `no_decider_configured` failed run (never a send). Migration 043 is still a manual production deploy step (unchanged from 23-01).

## Next Phase Readiness

- 23-03 (autonomous processor) can reuse `requestAiDraftProposal` for its decision call and `buildInboxAiContext`/`createAiRun`/`claimAiRun`/`deferAiRun`/`linkAiRunCommand`, gating on the org+campaign+kill-switch+policy intersection and handing off to `executeInboxSendCommand` (the autonomous path is the ONLY one allowed to link a send command). 23-04 (evaluations) can drive `generateInboxAiSuggestion` with an injected adapter over the fixture corpus.
- No blockers.

---
*Phase: 23-ai-inbox-automation-and-guardrails*
*Completed: 2026-07-16*

## Self-Check: PASSED

- All 3 created files (`inbox-ai-suggestions.ts`, `inbox-ai-suggestions.test.ts`, `AiDraftAssistant.tsx`) + this SUMMARY verified present on disk.
- All 4 commits (`1e76d01`, `0126d12`, `c561b64`, `04e9daa`) verified in git history.
- Gates: 784 tests, client tsc, server tsc, lint (0 warnings), build — all green.
