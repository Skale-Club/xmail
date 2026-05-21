# Phase 17: Observability foundation — Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Mode:** Pre-authored from architectural analysis (discuss skipped)

<domain>
## Phase Boundary

After Phase 14-16, the outreach module is functionally correct + deliverability-aware, but operationally OPAQUE. Today the operator finds out about problems by user complaint. This phase makes the system **legible**: structured logs you can grep, an admin health endpoint you can curl, and a daily digest you can read in 30 seconds.

In scope:
1. Adopt `pino` for structured JSON logging across outreach paths (sender, processor, reply, bounce, unsubscribe routes)
2. Standardize log shape: `{level, ts, action, campaignId?, leadId?, emailAccountId?, latencyMs?, error?, ...}`
3. New endpoint `GET /api/admin/outreach/health` (platform-admin-only) — returns per-org and per-campaign rolling-window metrics: emails sent (1h, 24h, 7d), open rate, click rate, bounce rate, reply rate, suppression rate, processor tick duration p50/p95
4. New cron job `dailyOutreachDigest` that LOGS (not emails — keeps it free) the prior 24h digest at 09:00 UTC: top 5 campaigns by send volume, any campaign with bounce rate > 5%, any inbox with status='failed', any processor tick > 30s
5. Alert thresholds defined: bounce_rate > 5% on rolling 1h → log WARN; > 10% on rolling 24h → log ERROR (Phase 18+ can wire to webhook/email)

Out of scope: pager-duty integration, Prometheus/Grafana scrape endpoint, ELK stack, distributed tracing — all premature for current scale.

Definition of done: operator can `docker logs skaleclub-mail 2>&1 | jq 'select(.action=="outreach.send.failed")'` to see recent failures; can `curl https://mail.skale.club/api/admin/outreach/health -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.byOrg'` to see fleet-wide outreach state; daily digest appears in container logs at 09:00 UTC.
</domain>

<decisions>
## Implementation Decisions

### Logger choice & config
- `pino` (not winston, not bunyan) — fastest, JSON-by-default, well-maintained
- Single `src/server/lib/logger.ts` exporting `logger` + `createLogger(context)` for child loggers
- Log level: env-driven (`LOG_LEVEL=info` default; `debug` in dev)
- Format: JSON in production, pretty-print in dev via `pino-pretty` (devDependency)
- Container stdout (Hetzner Docker captures already) — no file writers

### Log shape standardization
- All outreach logs include: `{action: "outreach.<area>.<event>"}` (e.g., `outreach.send.success`, `outreach.send.failed`, `outreach.reply.matched`, `outreach.bounce.detected`, `outreach.unsubscribe.requested`, `outreach.processor.tick.start`, `outreach.processor.tick.complete`)
- Contextual fields included when relevant: `campaignId`, `leadId`, `emailAccountId`, `organizationId`, `messageId`, `bounceReason`, `latencyMs`, `error.message`, `error.stack`
- Replaces ad-hoc `console.log("[processOutreachSequences] ...")` everywhere in outreach paths

### Health endpoint
- Path: `GET /api/admin/outreach/health` (mount in `src/server/routes/admin/outreach-health.ts` — new file)
- Auth: `requirePlatformAdmin` middleware (re-use existing)
- Response shape:
  ```ts
  {
    asOf: ISO string,
    overall: {
      sent1h, sent24h, sent7d,
      openRate24h, clickRate24h, replyRate24h, bounceRate24h, suppressionRate24h,
      processorTickP50Ms, processorTickP95Ms,
      activeCampaigns, activeEmailAccounts, failedEmailAccounts
    },
    byOrg: [{ organizationId, name, sent24h, bounceRate24h, replyRate24h, status: 'healthy'|'warning'|'critical' }],
    topBouncingCampaigns: [{ campaignId, name, bounceRate24h, sent24h }],
    alerts: [{ severity, kind, message, since }]
  }
  ```
- Metrics computed via aggregate SQL queries on `outreach_emails` + `campaign_leads` + `suppressions` + `email_accounts` (no pre-computed cache — these are aggregates over recent windows, cheap with indexes)
- Add index `outreach_emails (sent_at, status)` if not present (check schema first)

### Processor tick metrics
- `processOutreachSequences.ts`: wrap the lock-acquired block with `const tickStart = performance.now()` and log `outreach.processor.tick.complete` with `latencyMs`, `processed`, `errors`, `skipped`
- Persist last 100 tick records in-memory ring buffer (no DB table — keep it free, simple) exposed via `processorMetrics.getRecent()` consumed by health endpoint for p50/p95

### Daily digest
- New file `src/server/jobs/dailyOutreachDigest.ts`
- Cron scheduled in `jobs/index.ts` for `0 9 * * *` (09:00 UTC daily)
- Computes same metrics as health endpoint over PRIOR 24h window
- LOGS digest as structured `outreach.digest.daily` event with all data inline
- NO email/Slack sent — Phase 18+ can wire that

### Alert thresholds
- Define constants in logger.ts: `OUTREACH_BOUNCE_WARN_1H = 0.05`, `OUTREACH_BOUNCE_ERROR_24H = 0.10`, `OUTREACH_PROCESSOR_SLOW_MS = 30000`
- Health endpoint computes alerts based on these
- Processor logs WARN when its own tick exceeds `OUTREACH_PROCESSOR_SLOW_MS`

### Claude's Discretion
- Whether to add a tiny `src/server/lib/metrics.ts` for the ring-buffer + helper functions
- Whether to add a basic UI page `/admin/outreach-health` showing the same data (recommend YES if 1-2 hours; helpful for operator)
- Exact alert message phrasing

</decisions>

<code_context>
## Existing Code Insights

### Current logging state
- Mix of `console.log`, `console.error`, `console.warn` across all outreach files
- No structured shape — pure string concatenation
- No log level filtering
- Some files use prefix `[processOutreachSequences]` but inconsistently

### Existing admin endpoints / middleware
- `requirePlatformAdmin` middleware exists somewhere in `src/server/index.ts` or middleware folder — reuse it
- Admin routes pattern: see existing admin pages for examples
- Auth flow: JWT → `req.userId` → check user.is_platform_admin

### Reusable Assets
- Drizzle aggregate queries: see existing endpoints that do `SELECT COUNT(*) ... GROUP BY ...`
- Cron pattern: `src/server/jobs/index.ts` already has multiple cron-scheduled jobs (review the pattern there)

### Integration Points
- `src/server/lib/logger.ts` (new) — central logger
- All outreach files (sender, processor, replies, bounces, unsubscribe route, track route) — replace `console.*` with `logger.*`
- `src/server/routes/admin/outreach-health.ts` (new) — health endpoint
- `src/server/index.ts` — mount the new admin route
- `src/server/jobs/dailyOutreachDigest.ts` (new) — daily digest job
- `src/server/jobs/index.ts` — register the cron + ensure it's covered by the advisory lock pattern from Phase 14
- `package.json` — add `pino` (and `pino-pretty` as devDependency)
- `src/db/schema.ts` — confirm `outreach_emails(sent_at, status)` index exists; add if missing (migration 022)

</code_context>

<specifics>
## Specific Ideas

- The health endpoint is the OPERATOR's primary debugging tool. Make sure each metric has a clear definition embedded in the response (`{value: 0.07, definition: "bounced / sent over rolling 24h"}` — verbose but unambiguous)
- Daily digest doubles as a "morning routine" anchor — landing in the logs at 09:00 UTC means the team can grep for `outreach.digest.daily` and see system health at a glance
- All log calls should be lazy (`logger.info({ ... }, "msg")`) so the JSON serialization cost is paid only at the configured level

</specifics>

<deferred>
## Deferred Ideas

- Webhook firing for alerts (would couple to existing webhook system) → Phase 18
- Email/Slack notification of digest → Phase 18
- Prometheus `/metrics` scrape endpoint → if/when scale demands
- Distributed tracing (OpenTelemetry) → not needed at current scale
- UI charts on /admin pages → defer to Phase 19 if needed
- Per-email-account dashboards → defer

</deferred>
