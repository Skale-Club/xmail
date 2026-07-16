# Phase 23 Research — AI Inbox Automation and Guardrails

## Current implementation findings

- `outreach-followup.ts` has good fail-closed parsing/timeouts, but its context is lead/campaign fields plus `lastReplyText`; it lacks persisted thread history, stable input references, prompt/model audit, approval, and tenant-aware run IDs.
- `processFollowUps.ts` is advisory-locked and bounded to 100, but due rows are not leased before the external call. A long call/restart can repeat decisions. It calls `sendThreadedReply` directly, increments follow-up counters separately, and does not persist the sent follow-up in `outreach_emails`/Unified Inbox before dispatch.
- Existing `enforceGuardrails` checks suppression/unsubscribe/max count/window only. It omits organization outreach toggle, account daily allowance/warm-up/spacing/health and API enablement. Phases 18–19 create the authoritative replacements:
  - `evaluateOutreachDeliveryPolicy(ctx)` returning allowed context or `{allowed:false, code, retryAt?}`.
  - `dispatchOutreachMessage({origin, ..., idempotencyKey})`, which persists an outreach attempt before provider dispatch and holds ambiguous outcomes. AI must not call it directly: it hands a durable command to the single lease-aware executor in `inbox-command-dispatch.ts`.
- Phase 21 provides durable normalized conversation/message IDs and bodies; Phase 22 provides inbox send commands and operator composer/history. AI should join those models, not maintain a second thread or delivery log.

## Recommended model

Add `outreach_ai_settings` (or extend finalized outreach settings) with `draft_assistance_enabled`, `autonomous_enabled`, paused timestamp/reason, approved model/profile, max autonomous followups, and audit timestamps. Campaign keeps an explicit autonomy flag but effective autonomy is the intersection of organization setting + campaign flag + all kill switches.

Add `outreach_ai_runs` with organization/campaign/conversation/campaign-lead, run kind (`draft|autonomous`), trigger/source message, input message ID array or child join, context hash, prompt version, provider/model/config snapshot, status/action, sanitized output draft/subject/outcome, policy code/retryAt, actor/approver, command/outreach-email IDs, lease/attempt/idempotency, latency/usage, error code/detail, timestamps. Keep API output allowlisted; audit admins may inspect message references and rendered draft, never credentials/hidden prompt text.

## Context builder

`buildInboxAiContext` should:

1. verify user/job organization access and conversation/campaign attribution;
2. select a deterministic bounded window of persisted messages (latest inbound required, then recent thread within message/character/token budget);
3. include direction, participants, subject, timestamps, sanitized plain text, campaign/lead/seller facts, and policy-safe instruction metadata;
4. ignore external HTML instructions/attachments as executable instructions and label message content as untrusted data;
5. produce ordered message IDs and a SHA-256 hash of canonical serialized context;
6. refuse headers-only/missing-body context rather than inventing a reply.

## Decision boundary

Model output is a proposal with a strict Zod schema (`draft|wait|complete|escalate`). It may propose subject/body/delay/outcome, but cannot select arbitrary account/recipients, change policy, unsuppress a lead, activate a campaign, or send. Deterministic code resolves recipients/account and evaluates policy.

Draft mode persists status `suggested` and returns it to the composer. Autonomous mode converts only a valid `draft` proposal into a durable inbox command, then rechecks controls/policy and dispatches. `escalate`, malformed output, or safety uncertainty stays for human review.

## Evaluation set

Version a fixture corpus covering: positive interest, unsubscribe, not interested, out-of-office, bounce/DSN, prompt injection in inbound body, missing body, multilingual reply, forwarded thread, conflicting recipients, suppressed lead, paused org/campaign, exhausted daily/warm-up/spacing, duplicate processor tick, provider timeout/ambiguous result, cross-tenant IDs, and overly long context.

Assertions are structural/safety-first: no send when forbidden, correct persisted input references/hash, valid schema, no invented recipients, no credential/prompt leakage, idempotent command linkage. Quality scoring may inspect relevance/tone separately and must not weaken safety gates.

## Key risks

- Storing full model inputs duplicates sensitive mail. Prefer message references + hash and reconstruct under authorization; store only the generated draft needed for audit/operator use.
- A model response can be valid JSON but unsafe. Deterministic recipient/policy constraints remain authoritative.
- UI opt-in can become dark-pattern consent. Default off, explain impact, show current scope, and require confirmation for autonomy.
- Xphere availability must not block inbox reading/manual replies.
