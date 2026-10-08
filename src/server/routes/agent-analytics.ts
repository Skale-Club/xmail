import { Router } from 'express'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { READ_SCOPE, ManageError, handleManageError, requireScope, resultRows } from '../lib/agent-manage'

/**
 * Hermes / Kai outreach metrics over a date range, per campaign and per sending inbox.
 *
 *   GET /analytics/campaigns        outreach:read
 *   GET /analytics/email-accounts   outreach:read
 *
 * Email grain: every number counts outreach_emails rows sent inside [from, to), so a prospect
 * mailed three times counts three times. That is the right grain for "what did this inbox/campaign
 * do this week"; the lead-grain, all-time rates stay on GET /campaigns/:id (`stats`). The
 * organization is the credential's, in the WHERE of the statement itself and again on every JOIN.
 */

const router = Router()

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RANGE_DAYS = 30
const MAX_RANGE_DAYS = 366

const dateInput = z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), 'Use an ISO date or datetime')

const rangeQuerySchema = z.object({
    from: dateInput.optional(),
    to: dateInput.optional(),
    campaignId: z.string().uuid().optional(),
    emailAccountId: z.string().uuid().optional(),
})

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** [from, to) in UTC. A date-only `to` is inclusive of that whole day. */
function resolveRange(input: { from?: string; to?: string }, now: Date = new Date()) {
    const toParsed = input.to ? new Date(input.to) : now
    const to = input.to && DATE_ONLY.test(input.to) ? new Date(toParsed.getTime() + DAY_MS) : toParsed
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS)
    if (from.getTime() >= to.getTime()) {
        throw new ManageError(400, { error: '"from" must be before "to"', code: 'invalid_range' })
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new ManageError(400, { error: `The range cannot exceed ${MAX_RANGE_DAYS} days`, code: 'range_too_large' })
    }
    return { from, to }
}

interface MetricRow {
    id: string
    name: string
    status: string | null
    sent: number | string
    delivered: number | string
    opens: number | string
    clicks: number | string
    replies: number | string
    bounces: number | string
    unsubscribes: number | string
}

const percent = (numerator: number, denominator: number): number =>
    denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0

function shape(row: MetricRow) {
    const sent = Number(row.sent) || 0
    const metrics = {
        sent,
        delivered: Number(row.delivered) || 0,
        opens: Number(row.opens) || 0,
        clicks: Number(row.clicks) || 0,
        replies: Number(row.replies) || 0,
        bounces: Number(row.bounces) || 0,
        unsubscribes: Number(row.unsubscribes) || 0,
    }
    return {
        ...metrics,
        rates: {
            openRatePercent: percent(metrics.opens, sent),
            clickRatePercent: percent(metrics.clicks, sent),
            replyRatePercent: percent(metrics.replies, sent),
            bounceRatePercent: percent(metrics.bounces, sent),
            unsubscribeRatePercent: percent(metrics.unsubscribes, sent),
        },
    }
}

function totalsOf(rows: MetricRow[]) {
    const sum = (key: keyof MetricRow) => rows.reduce((acc, row) => acc + (Number(row[key]) || 0), 0)
    return shape({
        id: 'total', name: 'total', status: null,
        sent: sum('sent'), delivered: sum('delivered'), opens: sum('opens'), clicks: sum('clicks'),
        replies: sum('replies'), bounces: sum('bounces'), unsubscribes: sum('unsubscribes'),
    })
}

const COUNTS = sql`
    count(*) FILTER (WHERE e.sent_at IS NOT NULL)::int AS "sent",
    count(*) FILTER (WHERE e.delivered_at IS NOT NULL)::int AS "delivered",
    count(*) FILTER (WHERE e.opened_at IS NOT NULL)::int AS "opens",
    count(*) FILTER (WHERE e.clicked_at IS NOT NULL)::int AS "clicks",
    count(*) FILTER (WHERE e.replied_at IS NOT NULL)::int AS "replies",
    count(*) FILTER (WHERE e.bounced_at IS NOT NULL)::int AS "bounces",
    count(*) FILTER (WHERE e.unsubscribed_at IS NOT NULL)::int AS "unsubscribes"`

router.get('/analytics/campaigns', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = rangeQuerySchema.parse(req.query)
        const { from, to } = resolveRange(query)
        const filters: SQL[] = [
            sql`e.organization_id = ${principal.organizationId}::uuid`,
            sql`e.campaign_id IS NOT NULL`,
            sql`e.sent_at >= ${from.toISOString()}::timestamp`,
            sql`e.sent_at < ${to.toISOString()}::timestamp`,
        ]
        if (query.campaignId) filters.push(sql`e.campaign_id = ${query.campaignId}::uuid`)

        const rows = resultRows<MetricRow>(await db.execute(sql`
            SELECT e.campaign_id AS "id", c.name AS "name", c.status::text AS "status", ${COUNTS}
            FROM outreach_emails e
            JOIN campaigns c ON c.id = e.campaign_id AND c.organization_id = e.organization_id
            WHERE ${sql.join(filters, sql` AND `)}
            GROUP BY e.campaign_id, c.name, c.status
            ORDER BY count(*) DESC, c.name ASC
        `))
        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            grain: 'email',
            campaigns: rows.map((row) => ({ campaignId: row.id, name: row.name, status: row.status, ...shape(row) })),
            totals: totalsOf(rows),
        })
    } catch (error) {
        handleManageError(error, res, 'campaign analytics')
    }
})

router.get('/analytics/email-accounts', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = rangeQuerySchema.parse(req.query)
        const { from, to } = resolveRange(query)
        const filters: SQL[] = [
            sql`e.organization_id = ${principal.organizationId}::uuid`,
            sql`e.sent_at >= ${from.toISOString()}::timestamp`,
            sql`e.sent_at < ${to.toISOString()}::timestamp`,
        ]
        if (query.emailAccountId) filters.push(sql`e.email_account_id = ${query.emailAccountId}::uuid`)
        if (query.campaignId) filters.push(sql`e.campaign_id = ${query.campaignId}::uuid`)

        // Only id, address and status of the inbox are selected: nothing from the credential columns.
        const rows = resultRows<MetricRow>(await db.execute(sql`
            SELECT e.email_account_id AS "id", a.email AS "name", a.status::text AS "status", ${COUNTS}
            FROM outreach_emails e
            JOIN email_accounts a ON a.id = e.email_account_id AND a.organization_id = e.organization_id
            WHERE ${sql.join(filters, sql` AND `)}
            GROUP BY e.email_account_id, a.email, a.status
            ORDER BY count(*) DESC, a.email ASC
        `))
        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            grain: 'email',
            emailAccounts: rows.map((row) => ({ emailAccountId: row.id, email: row.name, status: row.status, ...shape(row) })),
            totals: totalsOf(rows),
        })
    } catch (error) {
        handleManageError(error, res, 'email account analytics')
    }
})

export default router
