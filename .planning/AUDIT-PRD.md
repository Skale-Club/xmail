# Outreach Reliability and Unified Inbox — Planning Brief

**Created:** 2026-07-15  
**Source:** repository audit of outreach jobs, provider adapters, routes, schema, and React pages  
**Target milestone:** v1.4 — Reliable Outreach + Unified Inbox

## Outcome

Make outreach execution safe and predictable, then add a true organization-scoped Unified Inbox comparable to Instantly Unibox: replies from every connected outreach account are ingested with their bodies, attributed to the correct lead/campaign, threaded, searchable, actionable, and replyable from one place.

## Confirmed gaps to close

1. The organization outreach kill switch is written but not enforced by sender jobs.
2. `delay` and `condition` sequence steps can be persisted but the processor treats every current step as an email, risking blank sends.
3. Claimed `outreach_emails` rows have no bounded retry/recovery state machine; stale `queued` and retryable `failed` rows can be stranded.
4. The processor scans an unordered batch of 200 due leads; repeatedly blocked rows can starve sendable work.
5. Outlook outreach is send-only: reply/bounce ingestion and full provider parity are missing; Graph sends also omit unsubscribe headers.
6. SMTP presets use port 587 with implicit TLS instead of STARTTLS semantics.
7. Campaign sequence ownership is ambiguous: campaign creation makes a default sequence, global sequence creation can create another, enrollment selects the first, and edits append steps.
8. Outreach UI routes require platform admin while the API permits organization admin/member access.
9. Outreach settings are stored but not consistently consumed by account/campaign defaults or notifications.
10. Agentic follow-ups bypass normal send budgets, warm-up, account spacing, API enablement, and durable outreach-email history; reply body context is not reliably populated.
11. Campaign completion is not invoked correctly and normal completed contacted leads can remain incomplete.
12. Campaign-rate denominators include pre-send suppressed/unsubscribed leads.
13. Lead search UI sends `search` but the API ignores it.
14. Sequence constraints exist in TypeScript but are not fully enforced in SQL/API validation.
15. Native delivery-status notifications can be consumed as replies before bounce processing.
16. IMAP bounce scanning is not bounded like reply scanning.
17. Service-key authentication trusts a caller-supplied `x-user-id`; the machine credential must bind to a server-side principal/organization.
18. No automated test framework currently protects the outreach state machine.
19. There is no Unified Inbox: existing outreach inbox pages manage sender accounts only; external reply fetches do not persist message bodies or conversation threads.

## Product boundary

Phases 18–20 stabilize the existing system. Phases 21–22 deliver the Unified Inbox foundation and operator experience. Phase 23 makes AI assistance opt-in, auditable, and subject to the same delivery guardrails as manual and campaign sends.

## Non-negotiable architecture constraints

- Production remains a long-running Node 20 Docker process on Hetzner behind Coolify/Traefik for HTTP; mail ports remain raw TCP.
- Tenant authorization is enforced in JavaScript through `src/server/lib/access.ts`; every new tenant-scoped route and job must explicitly scope organization/server access.
- `src/db/schema.ts` supplies TypeScript types, while hand-written sequential SQL files in `supabase/migrations/` are the database source of truth. The next migration after the current tree is `038`. Never use `drizzle-kit generate` or `db:push`.
- Ingestion must be idempotent across native mail, IMAP/SMTP accounts, and Outlook Graph.
- All automated sends must pass one shared policy gate: organization enablement, campaign/account state, suppression, daily allowance, warm-up, and per-account spacing.
- Existing outreach message history must remain valid; migrations should backfill safely and be idempotent where practical.

## Definition of milestone done

- Pausing outreach at organization level prevents every outreach-originated send.
- Sequence processing cannot send a non-email step and recovers safely from process/container interruption.
- Native, IMAP, and Outlook replies/bounces are ingested without duplicate side effects.
- An authorized organization user can open one inbox, filter/search conversations, read full threads, reply, organize, and schedule follow-up work.
- AI assistance is opt-in, visible, reproducible, and cannot bypass suppression, throttling, or budget rules.
- Critical state-machine and tenant-isolation behavior has automated tests and executable verification commands.

