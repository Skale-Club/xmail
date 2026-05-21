/**
 * Phase 17 — Aggregate SQL helpers for the outreach observability surface.
 *
 * Reused by:
 *   - src/server/routes/admin/outreach-health.ts (HTTP endpoint, Plan 17-03)
 *   - src/server/jobs/dailyOutreachDigest.ts    (cron-scheduled digest, Plan 17-04)
 *
 * All queries filter on outreach_emails.sent_at (composite idx with status from
 * Plan 17-03 Task 1) so rolling-window aggregates stay index-only.
 *
 * Design notes:
 *   - Pure SQL aggregates, no client-side bucketing — single round-trip per call.
 *   - No logger calls inside the helpers; callers decide whether/how to log.
 *   - Deterministic given (db state, now) so they remain unit-testable later.
 *   - Defensive shape-detection between postgres-js (returns Array) and node-pg
 *     (returns { rows: [...] }) — matches the pattern used in
 *     processOutreachSequences.runOutreachProcessorWithLock.
 */

import { db } from '../../db'
import { sql } from 'drizzle-orm'
import {
    OUTREACH_BOUNCE_WARN_1H,
    OUTREACH_BOUNCE_ERROR_24H,
    OUTREACH_PROCESSOR_SLOW_MS,
} from './logger'
import { getRecentTickLatencies } from '../jobs/processOutreachSequences'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export interface OverallMetrics {
    sent1h: number
    sent24h: number
    sent7d: number
    openRate24h: number
    clickRate24h: number
    replyRate24h: number
    bounceRate24h: number
    bounceRate1h: number
    suppressionRate24h: number
    processorTickP50Ms: number | null
    processorTickP95Ms: number | null
    activeCampaigns: number
    activeEmailAccounts: number
    failedEmailAccounts: number
}

export interface OrgMetrics {
    organizationId: string
    name: string
    sent24h: number
    bounceRate24h: number
    replyRate24h: number
    status: 'healthy' | 'warning' | 'critical'
}

export interface TopBouncingCampaign {
    campaignId: string
    name: string
    bounceRate24h: number
    sent24h: number
}

export interface HealthAlert {
    severity: 'warning' | 'critical'
    kind: string
    message: string
    since: string  // ISO timestamp
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function safeRate(numerator: number, denominator: number): number {
    if (denominator === 0) return 0
    return numerator / denominator
}

function rowsOf<T extends Record<string, unknown>>(result: unknown): T[] {
    if (Array.isArray(result)) {
        return result as T[]
    }
    const wrapped = result as { rows?: T[] }
    return wrapped?.rows ?? []
}

// -------------------------------------------------------------------------
// Aggregate queries
// -------------------------------------------------------------------------

/**
 * One round-trip aggregate over outreach_emails for the rolling windows.
 * Uses FILTER (WHERE ...) PostgreSQL aggregate to compute all rates in a
 * single SELECT — no N+1, no client-side bucketing.
 */
export async function computeOverallMetrics(now: Date = new Date()): Promise<OverallMetrics> {
    const cutoff1h = new Date(now.getTime() - ONE_HOUR_MS).toISOString()
    const cutoff24h = new Date(now.getTime() - ONE_DAY_MS).toISOString()
    const cutoff7d = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString()

    // Single aggregate query for all the email-level metrics.
    const rawRows = await db.execute(sql`
        SELECT
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff1h}) AS sent_1h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff24h}) AS sent_24h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff7d}) AS sent_7d,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff24h} AND opened_at IS NOT NULL) AS opened_24h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff24h} AND clicked_at IS NOT NULL) AS clicked_24h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff24h} AND replied_at IS NOT NULL) AS replied_24h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff24h} AND status = 'bounced') AS bounced_24h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff1h} AND status = 'bounced') AS bounced_1h,
            COUNT(*) FILTER (WHERE sent_at >= ${cutoff24h} AND unsubscribed_at IS NOT NULL) AS unsubscribed_24h
        FROM outreach_emails
        WHERE sent_at IS NOT NULL
    `)

    const rows = rowsOf<Record<string, string | number | null>>(rawRows)
    const r = rows[0] ?? {}
    const n = (k: string): number => Number(r[k] ?? 0)

    const sent24h = n('sent_24h')
    const sent1h = n('sent_1h')

    // Campaign + account counts in three small queries (no rolling window).
    const activeCampaignsRows = rowsOf<{ c: string | number }>(await db.execute(sql`
        SELECT COUNT(*) AS c FROM campaigns WHERE status = 'active'
    `))
    const activeAccountsRows = rowsOf<{ c: string | number }>(await db.execute(sql`
        SELECT COUNT(*) AS c FROM email_accounts WHERE status = 'verified'
    `))
    const failedAccountsRows = rowsOf<{ c: string | number }>(await db.execute(sql`
        SELECT COUNT(*) AS c FROM email_accounts WHERE status = 'failed'
    `))

    const { p50, p95 } = computeProcessorPercentiles()

    return {
        sent1h,
        sent24h,
        sent7d: n('sent_7d'),
        openRate24h: safeRate(n('opened_24h'), sent24h),
        clickRate24h: safeRate(n('clicked_24h'), sent24h),
        replyRate24h: safeRate(n('replied_24h'), sent24h),
        bounceRate24h: safeRate(n('bounced_24h'), sent24h),
        bounceRate1h: safeRate(n('bounced_1h'), sent1h),
        suppressionRate24h: safeRate(n('unsubscribed_24h'), sent24h),
        processorTickP50Ms: p50,
        processorTickP95Ms: p95,
        activeCampaigns: Number(activeCampaignsRows[0]?.c ?? 0),
        activeEmailAccounts: Number(activeAccountsRows[0]?.c ?? 0),
        failedEmailAccounts: Number(failedAccountsRows[0]?.c ?? 0),
    }
}

/**
 * Per-organization metrics over the 24h window. Single GROUP BY query.
 * Status derived from bounce rate:
 *   - critical if bounceRate24h >= OUTREACH_BOUNCE_ERROR_24H (10%)
 *   - warning  if bounceRate24h >= OUTREACH_BOUNCE_WARN_1H * 2 (10% sustained over a day = sustained warning)
 *   - healthy  otherwise
 *
 * HAVING COUNT > 0 drops orgs that sent nothing in the window; they show as
 * absent rather than as a row of zeros.
 */
export async function computeByOrgMetrics(now: Date = new Date()): Promise<OrgMetrics[]> {
    const cutoff24h = new Date(now.getTime() - ONE_DAY_MS).toISOString()

    const rawRows = await db.execute(sql`
        SELECT
            o.id AS organization_id,
            o.name AS name,
            COUNT(oe.*) AS sent_24h,
            COUNT(oe.*) FILTER (WHERE oe.status = 'bounced') AS bounced_24h,
            COUNT(oe.*) FILTER (WHERE oe.replied_at IS NOT NULL) AS replied_24h
        FROM organizations o
        LEFT JOIN outreach_emails oe
            ON oe.organization_id = o.id
            AND oe.sent_at >= ${cutoff24h}
        GROUP BY o.id, o.name
        HAVING COUNT(oe.*) > 0
        ORDER BY sent_24h DESC
    `)

    const arr = rowsOf<Record<string, string | number | null>>(rawRows)

    return arr.map((row) => {
        const sent24h = Number(row.sent_24h ?? 0)
        const bounced24h = Number(row.bounced_24h ?? 0)
        const replied24h = Number(row.replied_24h ?? 0)
        const bounceRate24h = safeRate(bounced24h, sent24h)
        const replyRate24h = safeRate(replied24h, sent24h)

        let status: 'healthy' | 'warning' | 'critical' = 'healthy'
        if (bounceRate24h >= OUTREACH_BOUNCE_ERROR_24H) {
            status = 'critical'
        } else if (bounceRate24h >= OUTREACH_BOUNCE_WARN_1H * 2) {
            status = 'warning'
        }

        return {
            organizationId: String(row.organization_id),
            name: String(row.name ?? ''),
            sent24h,
            bounceRate24h,
            replyRate24h,
            status,
        }
    })
}

/**
 * Top 5 campaigns by bounce rate over 24h. Floors `sent_24h` at 10 to avoid
 * tiny-sample noise (a campaign with 1 send and 1 bounce is not a "100% bounce
 * rate" problem). Ranked by raw bounce ratio descending.
 */
export async function computeTopBouncingCampaigns(now: Date = new Date()): Promise<TopBouncingCampaign[]> {
    const cutoff24h = new Date(now.getTime() - ONE_DAY_MS).toISOString()

    const rawRows = await db.execute(sql`
        SELECT
            c.id AS campaign_id,
            c.name AS name,
            COUNT(oe.*) AS sent_24h,
            COUNT(oe.*) FILTER (WHERE oe.status = 'bounced') AS bounced_24h
        FROM campaigns c
        JOIN outreach_emails oe ON oe.campaign_id = c.id
        WHERE oe.sent_at >= ${cutoff24h}
        GROUP BY c.id, c.name
        HAVING COUNT(oe.*) >= 10
        ORDER BY (COUNT(oe.*) FILTER (WHERE oe.status = 'bounced'))::float / NULLIF(COUNT(oe.*), 0) DESC
        LIMIT 5
    `)

    const arr = rowsOf<Record<string, string | number | null>>(rawRows)

    return arr.map((row) => {
        const sent24h = Number(row.sent_24h ?? 0)
        const bounced24h = Number(row.bounced_24h ?? 0)
        return {
            campaignId: String(row.campaign_id),
            name: String(row.name ?? ''),
            sent24h,
            bounceRate24h: safeRate(bounced24h, sent24h),
        }
    })
}

/**
 * Compute p50/p95 from the in-memory ring buffer Plan 17-02 exposes.
 * Returns nulls when fewer than 5 samples are available (not enough signal
 * to report a percentile honestly).
 */
export function computeProcessorPercentiles(): { p50: number | null; p95: number | null } {
    const samples = [...getRecentTickLatencies()].sort((a, b) => a - b)
    if (samples.length < 5) return { p50: null, p95: null }
    const idx = (q: number) => Math.min(samples.length - 1, Math.floor(q * samples.length))
    return {
        p50: samples[idx(0.5)],
        p95: samples[idx(0.95)],
    }
}

/**
 * Derive structured alerts from current metrics. Plan 17-03's HTTP endpoint and
 * Plan 17-04's digest both render these in their responses.
 *
 * Sample-size floors prevent thresholds firing on tiny windows: bounce-rate
 * alerts require minimum send volumes (20 for 1h, 100 for 24h) before they
 * surface. Without these floors a single bounce when sent=2 would trip a 50%
 * bounce rate alert spuriously.
 */
export function buildAlerts(
    overall: OverallMetrics,
    byOrg: OrgMetrics[],
    _topBouncing: TopBouncingCampaign[],
    now: Date = new Date(),
): HealthAlert[] {
    const alerts: HealthAlert[] = []
    const sinceIso = now.toISOString()

    if (overall.bounceRate1h >= OUTREACH_BOUNCE_WARN_1H && overall.sent1h >= 20) {
        alerts.push({
            severity: overall.bounceRate1h >= OUTREACH_BOUNCE_ERROR_24H ? 'critical' : 'warning',
            kind: 'bounce_rate_1h',
            message: `Bounce rate ${(overall.bounceRate1h * 100).toFixed(1)}% over last 1h (sent=${overall.sent1h}); threshold ${(OUTREACH_BOUNCE_WARN_1H * 100).toFixed(0)}%`,
            since: sinceIso,
        })
    }

    if (overall.bounceRate24h >= OUTREACH_BOUNCE_ERROR_24H && overall.sent24h >= 100) {
        alerts.push({
            severity: 'critical',
            kind: 'bounce_rate_24h',
            message: `Bounce rate ${(overall.bounceRate24h * 100).toFixed(1)}% over last 24h (sent=${overall.sent24h}); threshold ${(OUTREACH_BOUNCE_ERROR_24H * 100).toFixed(0)}%`,
            since: sinceIso,
        })
    }

    if (overall.processorTickP95Ms !== null && overall.processorTickP95Ms > OUTREACH_PROCESSOR_SLOW_MS) {
        alerts.push({
            severity: 'warning',
            kind: 'processor_slow',
            message: `Processor tick p95 ${overall.processorTickP95Ms}ms exceeds ${OUTREACH_PROCESSOR_SLOW_MS}ms threshold`,
            since: sinceIso,
        })
    }

    if (overall.failedEmailAccounts > 0) {
        alerts.push({
            severity: 'warning',
            kind: 'failed_email_accounts',
            message: `${overall.failedEmailAccounts} email account(s) in 'failed' status`,
            since: sinceIso,
        })
    }

    for (const org of byOrg) {
        if (org.status === 'critical') {
            alerts.push({
                severity: 'critical',
                kind: 'org_critical',
                message: `Org "${org.name}" bounce rate ${(org.bounceRate24h * 100).toFixed(1)}% over 24h (sent=${org.sent24h})`,
                since: sinceIso,
            })
        }
    }

    return alerts
}

// Re-export thresholds so the health endpoint + digest can include them in
// the response without importing logger.ts directly.
export {
    OUTREACH_BOUNCE_WARN_1H,
    OUTREACH_BOUNCE_ERROR_24H,
    OUTREACH_PROCESSOR_SLOW_MS,
} from './logger'
