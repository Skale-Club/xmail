---
phase: 23-ai-inbox-automation-and-guardrails
plan: 01
subsystem: database
tags: [ai, outreach, audit, postgres, drizzle, migration, sha256, tenant-isolation]

# Dependency graph
requires:
  - phase: 21-unified-inbox-foundation
    provides: persisted normalized outreach_conversation_messages (full bodies) + composite (id, organization_id) unique keys
  - phase: 22-unified-inbox-operator-experience
    provides: inbox_send_commands durable executor + composite (id, organization_id) unique key
  - phase: 18-outreach-safety-and-execution-reliability
    provides: shared delivery-policy gate + guarded disposable-Postgres migration test harness
provides:
  - "Migration 043: outreach_ai_settings (separate default-off draft + autonomy controls, kill switch), campaigns.ai_autonomous_enabled (default off), outreach_ai_runs audit table"
  - "buildInboxAiContext — deterministic, bounded, fail-closed context builder over persisted messages with a SHA-256 context hash"
  - "inbox-ai-audit.ts — redacted AI-run lifecycle (create/claim/complete/fail/defer/approve/link) over an injectable org-scoped store"
affects: [23-02 suggestion endpoint, 23-03 autonomous processor, 23-04 evaluations, ai-context, ai-audit]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Effective autonomy = intersection of org flag AND campaign flag AND clear kill switch AND Phase 18 policy (never one stored bit)"
    - "Deterministic bounded context projection + SHA-256 hash for reproducible/auditable AI inputs"
    - "Audit stores references + hash, never secrets; redaction of secret parameter keys with usage-counter preservation"
    - "Injectable store boundary makes DB-shaped lifecycle logic unit-testable without Postgres"

key-files:
  created:
    - supabase/migrations/043_ai_inbox_automation_audit.sql
    - src/server/lib/inbox-ai-context.ts
    - src/server/lib/inbox-ai-audit.ts
    - src/server/lib/__tests__/inbox-ai-migration.db.test.ts
    - src/server/lib/inbox-ai-context.test.ts
  modified:
    - src/db/schema.ts

key-decisions:
  - "Migration number 043 revalidated as the next free slot (042 highest) — no renumbering needed"
  - "campaign_lead_id is a plain FK (campaign_leads has no organization_id); all other audit links are composite (id, organization_id) FKs"
  - "Latest-inbound-body requirement is strict: a headers-only latest inbound fails closed (no stale fallback)"
  - "Audit lifecycle logic tested via an injectable in-memory store; production uses createDrizzleAiRunStore"

patterns-established:
  - "Untrusted message bodies are enclosed in a non-forgeable fence (token scrubbed from content) so prompt-injection text is data, never structure"
  - "Redaction regex redacts standalone `token` but preserves `tokens` usage counters (maxTokens/totalTokens)"

requirements-completed: [AI-01, AI-03, AI-05]

# Metrics
duration: 20min
completed: 2026-07-16
---

# Phase 23 Plan 01: AI Inbox Automation Foundation Summary

**Default-off AI control schema (migration 043) plus a deterministic fail-closed persisted-message context builder and a redacted, lease-driven AI-run audit lifecycle — the data/control/audit floor before any AI endpoint or send path exists.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-16T20:48:08Z
- **Completed:** 2026-07-16T21:08:29Z
- **Tasks:** 3
- **Files modified:** 6 (5 created, 1 modified)

## Accomplishments

- **Migration 043** (revalidated as the next free number): `outreach_ai_settings` with TWO SEPARATE default-off controls (`draft_assistance_enabled`, `autonomous_enabled`) + immediate kill switch (`autonomy_paused_at`/reason) + vetted model profile + autonomous follow-up ceiling; `campaigns.ai_autonomous_enabled` (backfilled OFF, legacy `agentic_followup_enabled` preserved); and the `outreach_ai_runs` audit table. Composite `(id, organization_id)` FKs block cross-tenant links in the DB; strict kind/status/action/lease/attempt/idempotency/approval CHECKs; claim, lease-recovery, history, and linkage indexes; `(organization_id, idempotency_key)` uniqueness; defense-in-depth RLS. Mirrored byte-for-byte in `src/db/schema.ts`.
- **`buildInboxAiContext`** — a pure, deterministic, bounded projection of persisted `outreach_conversation_messages` scoped to a verified org + conversation, producing ordered message ids and a SHA-256 context hash. Fails closed without a usable inbound body, treats bodies as untrusted data, and never reads `campaign_leads.lastReplyText`.
- **`inbox-ai-audit.ts`** — create/claim/complete/fail/defer/approve/link-command over an injectable org-scoped store with explicit transitions, leases, bounded attempts, idempotency, lease recovery, secret redaction, and bounded error text.
- **Gates:** full suite **744 tests** (was 700; +44), client tsc, server tsc, lint (0 warnings), and build all green.

## Task Commits

1. **Task 1: default-off AI settings + AI-run audit migration** — `6be5b9e` (feat)
2. **Task 2: deterministic persisted-message context** — `575015d` (feat, TDD RED→GREEN)
3. **Task 3: redacted AI-run lifecycle audit service** — `60cd34f` (feat, TDD RED→GREEN)

**Plan metadata:** (this commit) `docs(23-01)`

## Files Created/Modified

- `supabase/migrations/043_ai_inbox_automation_audit.sql` - AI settings + per-campaign flag + AI-run audit schema (idempotent, RLS, composite-org FKs)
- `src/db/schema.ts` - Mirror: `outreachAiSettings`, `outreachAiRuns` tables/types/relations + `campaigns.aiAutonomousEnabled`
- `src/server/lib/inbox-ai-context.ts` - Deterministic bounded context builder + SHA-256 hash + fail-closed guards
- `src/server/lib/inbox-ai-audit.ts` - Redacted AI-run lifecycle + injectable store + `createDrizzleAiRunStore`
- `src/server/lib/__tests__/inbox-ai-migration.db.test.ts` - Applies 043 twice on the guarded disposable Postgres (14 tests)
- `src/server/lib/inbox-ai-context.test.ts` - Context builder (14) + audit lifecycle (16) = 30 tests

## Report-back answers

**AI settings/audit tables + default-off semantics.** `outreach_ai_settings` (one row per org) carries `draft_assistance_enabled` and `autonomous_enabled` — two independent booleans, BOTH `DEFAULT false`, plus `autonomy_paused_at`/`autonomy_paused_reason` (immediate kill switch), `model_profile`, and `max_autonomous_follow_ups`. `campaigns.ai_autonomous_enabled` is added `NOT NULL DEFAULT false` so every existing campaign backfills to OFF. `outreach_ai_runs` is the append-only audit table. All controls are off after migration + backfill; enabling anything is an explicit action.

**Effective autonomy requires org AND campaign opt-in.** The schema stores the inputs, never a single "on" bit. EFFECTIVE autonomy (documented in the migration header and schema comments, enforced in later plans' JS/queries) is the INTERSECTION: `outreach_ai_settings.autonomous_enabled = true` AND `campaigns.ai_autonomous_enabled = true` AND `autonomy_paused_at IS NULL` (org kill switch clear) AND all Phase 18 delivery-policy / campaign / outreach kill switches clear. Draft assistance requires only `draft_assistance_enabled` and never authorizes a send (locked decision #1). Legacy `agentic_followup_enabled` is preserved for compatible rollout but does NOT participate in this intersection.

**Context builder — deterministic, fail-closed, avoids lastReplyText.** `buildInboxAiContext` is a pure function over the persisted `outreach_conversation_messages` (Phase 21 full normalized bodies). Determinism: messages ordered by `(received/sent/created time, then id tiebreak)`, a fixed message/char/total budget, HTML→plain normalization via the shared `htmlToPlainText`, and a SHA-256 over a canonical fixed-field serialization — identical input yields identical ordered ids, serialized context, and hash. It FAILS CLOSED (`InboxAiContextError`) when the thread has no inbound message (`no_inbound_message`) or the latest inbound is headers-only/whitespace (`no_inbound_body`) — no stale fallback, no invented reply. It NEVER reads `campaign_leads.lastReplyText` (facts come only from campaign/lead metadata). Every message is checked against the verified org + conversation; a single foreign row throws `attribution_mismatch` before any content is serialized. Bodies are enclosed in a non-forgeable fence (the fence token is scrubbed from content) so prompt-injection text is preserved as data but can never break structure; headers, attachment bytes, credentials, and tokens are excluded entirely.

**Audit — stores vs never stores.** Stores stable REFERENCES + provenance: input message id array + deterministic context hash, run kind (`draft|autonomous`), status/action, prompt version, provider/model, an ALLOWLISTED+redacted `model_parameters` snapshot, sanitized `output_subject/body/outcome`, policy code + retry time, actor + approval pair, durable `send_command_id` + `outreach_email_id`, lease/attempts/idempotency, optional latency/token usage, and bounded error code/detail. NEVER stores API keys, Authorization/bearer headers, passwords/credentials/secrets, or the system prompt / hidden reasoning — `sanitizeModelParameters` recursively replaces secret-named keys with `[redacted]` (while keeping usage counters like `maxTokens`/`totalTokens`), error text is length-bounded, and the create path accepts only typed allowlisted fields (no raw request blob). The migration test asserts no credential/secret/prompt columns exist on `outreach_ai_runs`.

**Final gate counts.** `npm run test` → **744 passed** (52 files; was 700, +14 migration +30 context/audit). `npx tsc --noEmit -p tsconfig.json` (client) → 0 errors. `npx tsc --noEmit -p tsconfig.server.json` (server) → 0 errors. `npm run lint` → 0 warnings. `npm run build` → success.

## Decisions Made

- **043 confirmed free** — 042 is the highest existing migration, so 043 needed no renumbering. All phase references already used 043.
- **`campaign_lead_id` uses a plain FK** to `campaign_leads(id)` (ON DELETE SET NULL) because `campaign_leads` has no `organization_id` column; its org scope flows through the composite `campaign_id` FK. Every other cross-tenant link is a composite `(id, organization_id)` FK with column-list `ON DELETE SET NULL` so the audit row survives when a referenced row is removed.
- **Audit lifecycle placed behind an injectable store** so all transition/lease/redaction/tenant logic is unit-tested in the fast `server` project (per the plan's verify command) while the Drizzle-backed store remains production-ready for the 23-02/03/04 worker + endpoint db suites.

## Deviations from Plan

None - plan executed exactly as written. (Two minor within-plan refinements, not scope changes: `InboxAiContextError`/`AiRunError` messages include their `.code` so logs/tests can match by message; the redaction regex distinguishes a standalone `token` secret from `tokens` usage counters so `maxTokens`/`totalTokens` are preserved.)

## Issues Encountered

- ESLint `prefer-const` on the `selected` window array (mutated via `.splice`, never reassigned) — changed `let`→`const`.
- Two attribution tests used `.toThrowError(/code/)` which matches the error message; made both error classes embed their code in the message so the match is robust. Both resolved before commit; no gate regressions.

## User Setup Required

None for this plan's code. **Operator note (do NOT auto-apply):** migration `043_ai_inbox_automation_audit.sql` is written + tested against the disposable Postgres but is NOT applied to production. It is a manual deploy step, applied in ascending order after 038→042: `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/043_ai_inbox_automation_audit.sql`.

## Next Phase Readiness

- The data/control/audit floor for AI-03/05 exists before any model or send path is enabled. 23-02 (suggestion endpoint) can consume `buildInboxAiContext` + `createAiRun`/`completeAiRun` (draft mode, `awaitingApproval`); 23-03 (autonomous processor) can consume `claimAiRun`/`deferAiRun`/`linkAiRunCommand` and must gate on the org+campaign+kill-switch+policy intersection and hand off to `executeInboxSendCommand` (never dispatch directly).
- No blockers. The Drizzle-backed AI-run store is not yet exercised by a `.db` suite — that lands with the 23-02/03 worker/endpoint tests.

---
*Phase: 23-ai-inbox-automation-and-guardrails*
*Completed: 2026-07-16*

## Self-Check: PASSED

- All 5 created files + this SUMMARY verified present on disk.
- All 3 task commits (`6be5b9e`, `575015d`, `60cd34f`) verified in git history.
- Gates: 744 tests, client tsc, server tsc, lint (0 warnings), build — all green.
