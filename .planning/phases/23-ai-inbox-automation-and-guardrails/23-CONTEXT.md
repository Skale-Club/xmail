# Phase 23 Context — AI Inbox Automation and Guardrails

## Outcome

Turn the existing experimental Xphere follow-up path into a safe, opt-in inbox capability. Operators can request an editable draft from a persisted conversation; organizations/campaigns may separately enable autonomous follow-up; every decision and send is auditable and every delivery passes the same policy/dispatch path as campaign, manual, and Unified Inbox sends.

## Requirements

- AI-01 — context comes from persisted normalized conversation messages, never header-only fields.
- AI-02 — on-demand suggestion is editable, failure-safe, and never implicitly sent.
- AI-03 — autonomy is explicit per organization/campaign with pause/kill controls.
- AI-04 — AI sends pass suppression, limits, warm-up, spacing, health, campaign, and organization checks.
- AI-05 — prompt/model/version/input references, decisions, approvals, sends, failures, and representative safety evaluations are auditable.
- AI-06 — UI/API expose status/history without leaking credentials, hidden prompts, or cross-tenant content.

## Locked decisions

1. **Draft assistance and autonomous sending are separate permissions.** Draft suggestions may be enabled organization-wide; autonomous sends require organization opt-in plus campaign opt-in. Default is off after migration/backfill.
2. **Persisted inbox messages are the only conversation source.** Replace `campaign_leads.lastReplyText` as reasoning source; it may remain a compatibility/cache field but cannot authorize or construct AI context.
3. **One delivery path.** AI never imports provider adapters, calls `sendThreadedReply`, or calls `dispatchOutreachMessage` directly. It creates or hands off a durable inbox send command to the single lease-aware executor exported by `src/server/lib/inbox-command-dispatch.ts`; that executor alone evaluates policy and calls the shared dispatcher.
4. **No hidden retry loop.** Decisions and dispatch use leases, bounded attempts, idempotency, and held state for ambiguous outcomes. Policy `retryAt` may defer a durable command; terminal denial cannot be overridden by the model.
5. **Audit references, not secret dumps.** Store prompt template/version, provider/model, parameters, input message IDs + deterministic context hash, output/action, policy result, actor/approval, command/outreach-email IDs, latency/token metadata if returned, and errors. Do not store API keys, Authorization headers, or expose system prompt/raw hidden reasoning in public APIs.
6. **Human draft endpoint never sends.** It returns/persists a suggestion with an audit run. Sending requires an explicit operator action through the Phase 22 composer.
7. **Autonomous controls are immediate.** Organization kill switch, automation pause, campaign pause, and outreach kill switch are evaluated at claim and again immediately before dispatch.
8. **Xphere remains optional and fail-closed.** Timeout, malformed response, missing config, or context failure produces an inspectable failed/no-action run, not a send or infinite retry.

## Existing path to replace

- `src/server/lib/outreach-followup.ts` sends a small `FollowUpContext` with `lastReplyText` to `XPHERE_FOLLOWUP_URL` and parses `send|wait|complete`.
- `src/server/jobs/processFollowUps.ts` scans `campaign_leads.nextFollowUpAt`, checks partial guardrails, and calls `sendThreadedReply` directly. It bypasses organization enablement, daily/warm-up/spacing policy, durable outreach attempt history, and full reply bodies.
- `processReplies.ts` schedules agentic follow-up when campaign flag is enabled but does not reliably persist body context.

Phase 23 must retire that direct-send architecture, not wrap it with another boolean.

## Migration discipline

If audit/control tables are not already present, provisional migration is `043_ai_inbox_automation_audit.sql` (assuming Phase 22 consumes 042). Revalidate the number first. Automated migration tests require explicit `MIGRATION_TEST_DATABASE_URL`, refuse when it equals `DATABASE_URL` or the database name lacks `_test`, and never infer a target. The Windows manual runbook command is `psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/043_ai_inbox_automation_audit.sql` (using the revalidated filename). Never use Drizzle generate/db:push.

All AI endpoints extend only `src/server/routes/outreach/unified-inbox.ts`. Reads use `requireOutreachRead`, mutations use `requireOutreachWrite` from `src/server/lib/outreach-access.ts`, and every service/job query carries the verified organization predicate.

## Scope fences

In scope: suggestion endpoint/UI, opt-in controls, audit history, context builder, Xphere adapter, autonomous processor refactor, shared dispatch, evaluations and tenant/security tests.

Out: training/fine-tuning, prompt playground for end users, exposing chain-of-thought/system prompts, autonomous CRM changes, sentiment-based suppression without deterministic policy, or choosing new recipients not already in the conversation/campaign.
