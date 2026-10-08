# Xmail outreach + Hermes architecture

## Security boundary

Hermes uses `X-Agent-Key` only against `/api/agent/outreach/*`. The clear token is returned once;
Xmail stores its SHA-256 hash, binds it to one organization and human principal, and evaluates an
explicit scope allow-list on every tool call. The existing `XMAIL_SERVICE_KEY` remains a legacy
Xphere credential and must never be shared with an LLM agent.

The initial Hermes capability set is deliberately asymmetric:

- read campaign state;
- import prospects in bounded batches;
- discover Apollo prospects without exposing provider secrets or consuming enrichment credits;
- rank persisted candidates with deterministic, explainable ICP scoring;
- create campaign drafts and sequence drafts;
- pause campaigns;
- poll and acknowledge durable events.

There is no agent endpoint to activate a campaign or dispatch mail. Human activation and every
send continue through the existing campaign validation, suppression, idempotency and dispatcher
policy gates.

> **Whole-system boundary (verified 2026-10-08).** Hermes also carries the Xphere,
> Skale Club and Notion MCPs plus direct Xcraper service credentials. Xphere may import and
> enrol an approved audience only into a `draft` or `paused` Xmail campaign; it refuses an
> active campaign and no longer has an activation client. The immediate 1:1 email/SMS tool was
> removed from the Xphere MCP registry. Across every Hermes path, first activation now exists
> only as a durable Xmail approval executed by an interactive admin in Telegram or the panel.

## Event flow

```mermaid
flowchart LR
    X["Xmail domain action"] --> O["outreach_event_outbox"]
    S["Bounded crash-window reconciler"] --> O
    O --> H["Hermes polling + credential cursor"]
    O --> R["Retrying Xphere adapter"]
    H --> A["Agent audit log"]
    R -->|"Idempotency-Key: event id"| XP["Xphere receiver"]
```

Producers commit `outreach.<event>` rows before returning. Hermes reads in `sequence_number` order
and advances only its own credential cursor after successful processing. Xphere has an independent
retry state with bounded exponential backoff, so either consumer may be unavailable without losing
the other consumer's progress.

Every event also has an organization-scoped deduplication key. A five-minute bounded reconciler
repairs the crash window where domain state committed immediately before an outbox insert failed;
its default lookback is six hours and can be changed with
`OUTREACH_EVENT_RECONCILE_LOOKBACK_HOURS`.

## API contract

| Method | Path | Scope | Effect |
|---|---|---|---|
| GET | `/health` | `outreach:read` | Connection and granted scopes |
| GET | `/campaigns` | `outreach:read` | Bounded organization campaign list |
| POST | `/prospects/import` | `prospects:write` | Idempotent batch import, maximum 100 |
| POST | `/prospecting/searches` | `prospects:search` | Idempotent Apollo discovery, maximum 100; no contact credits |
| GET | `/prospecting/searches/:id` | `outreach:read` | Run/provider/cost state |
| GET | `/prospecting/searches/:id/candidates` | `outreach:read` | Candidates ordered by explainable ICP score |
| POST | `/approvals/prospect-enrichment` | `prospects:enrich` | Request immutable candidate-set/credit approval, maximum 10 |
| GET | `/approvals/:id` | `approvals:read` | Poll an approval requested by this credential |
| POST | `/prospecting/searches/:id/enrich` | `prospects:enrich` | Execute only a matching, unexpired human approval |
| POST | `/prospecting/searches/:id/import` | `prospects:write` | Import score-qualified, verified-email candidates only |
| POST | `/campaigns/drafts` | `campaigns:draft` | Idempotent draft + canonical sequence only |
| POST | `/campaigns/:id/activation-requests` | `campaigns:request_activation` | Request human activation; never activates directly |
| POST | `/campaigns/:id/pause` | `campaigns:pause` | Immediate, idempotent pause |
| GET | `/campaigns/:id/sequence` | `campaigns:copy` | Campaign status + every step's copy, delays, A/B fields, counters and copy-lint findings |
| PUT | `/campaigns/:id/sequence/steps/:stepOrder` | `campaigns:copy` | Partial edit of subject/plainBody/htmlBody/delay of one step of a draft, paused or active campaign; audited, versioned, 422 if the step would fail the activation checks; never sends or activates |
| POST | `/campaigns/:id/sequence/steps/:stepOrder/revert` | `campaigns:copy` | Restore the version stored before the latest un-reverted agent edit; refuses if a human changed the step since |
| GET | `/campaigns/:id` | `outreach:read` | Settings, lifecycle, step schedule, linked inboxes (no secrets), stats |
| PATCH | `/campaigns/:id` | `outreach:manage` | Partial settings update (no status, reply-to or autonomy flags); audited |
| POST | `/campaigns/:id/duplicate` | `outreach:manage` | New draft with the same settings and steps (`delay_hours_max` kept), no leads; idempotent per key |
| POST | `/campaigns/:id/resume` | `outreach:manage` | Un-pause only if an executed activation approval exists, the agent paused it and the activation readiness checks pass again |
| GET | `/campaigns/:id/leads` | `outreach:read` | Paginated roster with status, step and last event |
| GET / PATCH | `/leads/:leadId` | `outreach:read` / `outreach:manage` | Read one lead; partial personalization update (no email, status, verification, reserved custom-field keys) |
| DELETE | `/campaigns/:id/leads/:leadId` | `outreach:manage` | `confirm: true` required (409 otherwise); never-mailed lead is deleted, mailed lead is stopped |
| GET / POST / PATCH | `/lead-lists`, `/lead-lists/:listId` | `outreach:read` / `outreach:manage` | List, create, rename lead lists |
| GET / PATCH | `/email-accounts`, `/email-accounts/:id` | `outreach:read` / `outreach:manage` | Inbox status, limits, warm-up, health (never credentials); pacing update only |
| GET | `/inbox/conversations`, `/inbox/conversations/:id` | `outreach:read` | Read-only unified inbox; plain text, flagged untrusted |
| GET | `/analytics/campaigns`, `/analytics/email-accounts` | `outreach:read` | Email-grain metrics over a date range |
| GET / POST / DELETE | `/suppressions`, `/suppressions/:id` | `outreach:read` / `outreach:manage` | List, add an address or domain, lift a manual one (`confirm: true`) |
| GET | `/events` | `events:read` | Ordered event polling |
| POST | `/events/ack` | `events:read` | Monotonic credential cursor |

All paths above are relative to `/api/agent/outreach`.
Campaign draft calls require a stable `idempotencyKey`; retrying the same key returns the original
draft instead of creating another campaign.

Apollo's key remains only in the Xmail server environment. Paid enrichment requires an immutable,
24-hour approval requested by the bound credential and reviewed in an interactive organization-admin
session. The approval records the candidate IDs and worst-case credit ceiling; execution atomically
consumes it once. Personal email and phone revelation remain disabled at the provider adapter.

## Operational rollout

1. Apply `supabase/migrations/045_outreach_agent_gateway.sql` and
   `supabase/migrations/046_prospecting_pipeline.sql`, then
   `supabase/migrations/047_outreach_action_approvals.sql`.
2. Deploy Xmail.
3. As an organization admin, create a credential through
   `POST /api/outreach/agent-credentials?organizationId=<uuid>` and retain the returned token.
4. Put the token in `/opt/hermes/hermes.env` as `XMAIL_AGENT_KEY` and recreate the Hermes container.
5. Register the mounted MCP server:

   ```bash
   docker exec -it hermes hermes mcp add xmail \
     --command node --args /opt/xmail-mcp/server.mjs
   ```

6. Verify `xmail_health`, import test prospects, create a draft, poll events and acknowledge the
   returned cursor. Revoke the credential immediately if it appears in logs or chat history.
