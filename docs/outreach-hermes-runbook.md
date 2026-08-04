# Xmail + Hermes outreach runbook

## Release gate

This rollout is intentionally staged. Do not expose Apollo enrichment or campaign activation until
all migrations are applied, a tenant-bound credential is created, and the smoke checks below pass.
Hermes never receives `DATABASE_URL`, `XMAIL_SERVICE_KEY`, `APOLLO_API_KEY`, SMTP credentials or a
Supabase service-role key.

Apply in order:

```bash
psql "$DATABASE_URL" -f supabase/migrations/045_outreach_agent_gateway.sql
psql "$DATABASE_URL" -f supabase/migrations/046_prospecting_pipeline.sql
psql "$DATABASE_URL" -f supabase/migrations/047_outreach_action_approvals.sql
psql "$DATABASE_URL" -f supabase/migrations/048_deliverability_guardrails.sql
psql "$DATABASE_URL" -f supabase/migrations/049_prospect_ai_assessments.sql
npm run db:indexes
```

Configure `APOLLO_API_KEY` only in the Xmail container. The GitHub workflow expects an
`APOLLO_API_KEY` repository secret. Deploying without it is safe: Apollo routes fail closed with
HTTP 503 while mail continues to operate.

## Credential and scopes

Create the Hermes credential from an interactive organization-admin session using
`POST /api/outreach/agent-credentials?organizationId=<uuid>`. Recommended scopes for the full
governed workflow:

```json
[
  "outreach:read",
  "prospects:search",
  "prospects:enrich",
  "prospects:assess",
  "prospects:write",
  "campaigns:draft",
  "campaigns:request_activation",
  "campaigns:pause",
  "approvals:read",
  "events:read"
]
```

Store the one-time token only as `XMAIL_AGENT_KEY` in `/opt/hermes/hermes.env` (`chmod 600`). A
credential becomes invalid immediately when revoked, expired, or when its human principal loses
organization membership.

## Smoke path

1. Call `xmail_health`; confirm the organization and expected scopes.
2. Run `xmail_search_prospects` with `limit: 2`; confirm it returns candidates without email/phone.
3. Request enrichment approval for one candidate. Confirm it appears in `/outreach/agent-ops`.
4. Approve it in the UI, then call `xmail_execute_approved_enrichment` once. Replay the call and
   confirm `idempotentReplay: true` without another provider request.
5. Record an evidence-backed assessment, import the candidate to a lead list, create a campaign
   draft, enroll the draft with a verified non-primary-domain inbox, and request activation.
6. Confirm human approval activates the campaign. Confirm Hermes has no direct-send tool.
7. Poll and acknowledge the resulting durable events.

Use only test/controlled recipients during smoke validation.

## Monitoring

- Operator UI: `/outreach/agent-ops`.
- Platform metrics: `GET /api/admin/outreach/health`, field `agentOps`.
- Structured logs:

```bash
docker logs xmail --since 24h 2>&1 | grep -E 'outreach\.(approvals|deliverability|events)|agent-auth|prospecting'
```

Alert immediately when `stuckExecutingApprovals > 0` or `failedXphereDeliveries > 0`. An approval
stuck in `executing` represents an ambiguous paid call: never reset it to `approved` and never retry
blindly. Reconcile the Apollo usage/account state first, then create a new prospecting run and a new
approval if a human explicitly decides to continue.

## Deliverability incident

The ten-minute guard pauses active campaigns when their configured 24-hour bounce or unsubscribe
threshold and sample floor are both reached. The campaign records `paused_reason` and `paused_at` and
emits `outreach.campaign.deliverability_paused`.

1. Keep the campaign paused.
2. Inspect bounced addresses, verification status, sending inbox health and domain authentication.
3. Suppress invalid recipients and correct the ICP/source before considering a restart.
4. Resume only through the human campaign flow; activation clears the old pause marker after all
   readiness checks pass again.

## Credential or secret incident

1. Revoke the agent credential in Xmail immediately.
2. Rotate `APOLLO_API_KEY` if it may have left the Xmail server boundary.
3. Inspect `outreach_agent_audit_log`, `outreach_action_approvals`, `prospecting_runs` and the outbox.
4. Create a new least-privilege credential; never reuse the old clear token.

## Rollback

Application rollback uses the existing `xmail:previous` deployment path. Database migrations are
additive; do not drop the new tables during an incident. Disable the capability safely by revoking
Hermes credentials and removing `APOLLO_API_KEY`. Existing mail, campaign dispatch and inbound
processing remain independent of Apollo and the Hermes container.
