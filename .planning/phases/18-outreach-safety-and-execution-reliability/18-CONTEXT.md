# Phase 18 Context — Outreach Safety and Execution Reliability

## Goal

Turn the outreach processor into a fail-closed, restart-safe state machine. An organization pause must stop every outreach-originated provider dispatch, non-email sequence steps must never become messages, retryable work must recover without blindly duplicating an ambiguous send, and due work must be selected fairly.

## Inputs

- `.planning/AUDIT-PRD.md`
- `.planning/REQUIREMENTS.md` (`SAFE-01` through `SAFE-06`)
- `src/server/jobs/processOutreachSequences.ts`
- `src/server/jobs/processFollowUps.ts`
- `src/server/routes/outreach/send-message.ts`
- `src/server/lib/outreach-sender.ts`
- `src/db/schema.ts`
- `supabase/migrations/037_reconcile_schema_only_unique_indexes.sql`

## Locked decisions

1. All outreach sends use one policy contract and one durable dispatcher. `origin` identifies `campaign`, `manual`, `agentic`, or `unified_inbox`; origin does not waive safety policy.
2. The organization kill switch is checked immediately before durable claim and again immediately before provider dispatch. A pause race therefore fails closed.
3. `delay` is a transition-only step: it never creates `outreach_emails`; its `delayHours` determines when the next step becomes eligible. `condition` remains fail-closed until a branch schema/product contract exists: activation rejects such sequences and the processor quarantines legacy condition steps without sending.
4. `outreach_emails` becomes the common attempt ledger. A stable organization-scoped idempotency key identifies the logical send.
5. Claims have leases and bounded attempts. Failures known to occur before provider acceptance can retry with backoff. A process loss after `dispatch_started_at` is ambiguous and moves to `held`; it is never automatically resent.
6. The migration for this phase is the hand-written `038_outreach_dispatch_state_machine.sql`; `src/db/schema.ts` mirrors it. Never run Drizzle generation or `db:push`.
7. Selection is deterministic and fair by account. Rows that cannot send yet are advanced to a concrete future eligibility time so they do not monopolize each tick.
8. Campaign completion uses `campaign_leads.completed_at` plus terminal statuses. A contacted lead with `completed_at` set is complete even if its lead status remains `contacted`.
9. Add Vitest as the first automated test harness, with separate Node, jsdom/React, and disposable-PostgreSQL projects and support for both `.ts` and `.tsx` tests. Pure policy/transition tests use injected repositories/providers; database integration tests start an isolated Testcontainers PostgreSQL instance and must never reuse or fall back to the configured production `DATABASE_URL`.
10. Campaign-lead terminality is one exhaustive shared contract: `replied`, `interested`, `not_interested`, `bounced`, and `unsubscribed` are terminal; `new` and `contacted` are not. Scheduler selection, campaign completion, and later metrics must import the same contract.

## Public contracts created by this phase

```ts
type OutreachOrigin = 'campaign' | 'manual' | 'agentic' | 'unified_inbox'

evaluateOutreachDeliveryPolicy(input): Promise<
  | { allowed: true; account; organization; campaign?: Campaign }
  | { allowed: false; code: DeliveryPolicyCode; retryAt?: Date }
>

dispatchOutreachMessage({
  origin,
  organizationId,
  emailAccountId,
  campaignId?,
  campaignLeadId?,
  sequenceStepId?,
  idempotencyKey,
  to,
  subject,
  text?,
  html?,
  inReplyTo?,
  references?,
}): Promise<DispatchResult>
```

## Deferred to later phases

- Outlook MIME parity and provider inbound sync: Phase 19.
- Canonical campaign sequence editing and SQL step constraints: Phase 20.
- Conversation/message persistence: Phase 21.
- Unified Inbox compose UX: Phase 22.
- AI decision audit/evaluations: Phase 23.
