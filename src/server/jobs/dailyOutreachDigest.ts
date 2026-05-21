/**
 * Phase 17 — Daily outreach digest.
 *
 * Runs once a day at 09:00 UTC (cron registered in jobs/index.ts).
 * Computes the same aggregates as the /api/admin/outreach/health endpoint
 * over the prior 24h window and emits them as a SINGLE structured log line:
 *
 *   action='outreach.digest.daily'
 *
 * NOT an email, NOT a slack message, NOT a webhook. Just a log line that
 * lands in `docker logs skaleclub-mail`. Operator's grep query:
 *
 *   docker logs skaleclub-mail 2>&1 | jq 'select(.action=="outreach.digest.daily")'
 *
 * Phase 18+ can wire this same payload to webhook/email/Slack — the payload
 * shape is intentionally a complete snapshot so a downstream transport
 * needs zero extra computation.
 */

import { performance } from 'node:perf_hooks'
import { createLogger } from '../lib/logger'
import {
    computeOverallMetrics,
    computeByOrgMetrics,
    computeTopBouncingCampaigns,
    buildAlerts,
} from '../lib/outreach-metrics'

const log = createLogger('outreach.digest')

export interface DailyDigestResult {
    success: boolean
    durationMs: number
    alertCount: number
}

export async function dailyOutreachDigest(): Promise<DailyDigestResult> {
    const startedAt = new Date()
    const t0 = performance.now()

    try {
        const [overall, byOrg, topBouncingCampaigns] = await Promise.all([
            computeOverallMetrics(startedAt),
            computeByOrgMetrics(startedAt),
            computeTopBouncingCampaigns(startedAt),
        ])

        const alerts = buildAlerts(overall, byOrg, topBouncingCampaigns, startedAt)
        const durationMs = Math.round(performance.now() - t0)

        // Single payload — everything the operator needs in one grep.
        log.info({
            action: 'outreach.digest.daily',
            asOf: startedAt.toISOString(),
            window: '24h',
            durationMs,
            overall: {
                sent24h: overall.sent24h,
                sent7d: overall.sent7d,
                openRate24h: overall.openRate24h,
                clickRate24h: overall.clickRate24h,
                replyRate24h: overall.replyRate24h,
                bounceRate24h: overall.bounceRate24h,
                suppressionRate24h: overall.suppressionRate24h,
                processorTickP50Ms: overall.processorTickP50Ms,
                processorTickP95Ms: overall.processorTickP95Ms,
                activeCampaigns: overall.activeCampaigns,
                activeEmailAccounts: overall.activeEmailAccounts,
                failedEmailAccounts: overall.failedEmailAccounts,
            },
            byOrg: byOrg.map((o) => ({
                organizationId: o.organizationId,
                name: o.name,
                sent24h: o.sent24h,
                bounceRate24h: o.bounceRate24h,
                replyRate24h: o.replyRate24h,
                status: o.status,
            })),
            topBouncingCampaigns,
            alerts,
            summary: {
                healthyOrgs: byOrg.filter((o) => o.status === 'healthy').length,
                warningOrgs: byOrg.filter((o) => o.status === 'warning').length,
                criticalOrgs: byOrg.filter((o) => o.status === 'critical').length,
                alertCount: alerts.length,
            },
        }, 'daily outreach digest')

        return { success: true, durationMs, alertCount: alerts.length }
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        const durationMs = Math.round(performance.now() - t0)
        log.error({
            action: 'outreach.digest.failed',
            durationMs,
            error: { message: e.message, stack: e.stack },
        }, 'daily digest failed')
        return { success: false, durationMs, alertCount: 0 }
    }
}
