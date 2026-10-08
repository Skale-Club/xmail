import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { resultRows } from './agent-manage'
import { RAMP_WINDOW_DAYS } from './sending-ramp'

/**
 * The counts behind the ramp recommendation: per inbox, over the last RAMP_WINDOW_DAYS, what it
 * sent and how that went. Email grain, like routes/agent-analytics.ts (`sent_at`, `bounced_at`,
 * `unsubscribed_at` on outreach_emails), so the numbers an agent reads here and in the analytics
 * tool agree.
 *
 * Complaints have no column of their own: nothing ingests feedback-loop reports, so a complaint
 * is a `complaint` suppression for an address this inbox mailed in the window. That is as complete
 * as the suppression list is, which the caller should say out loud rather than imply certainty.
 *
 * The organization is in the WHERE of the statement itself and again on the suppression join: the
 * app role bypasses RLS, so tenant isolation is only ever what the SQL says.
 */
export interface SendingRampStats {
    sent: number
    bounces: number
    complaints: number
    unsubscribes: number
}

interface StatsRow {
    id: string
    sent: number | string
    bounces: number | string
    complaints: number | string
    unsubscribes: number | string
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function loadSendingRampStats(
    organizationId: string,
    emailAccountIds: string[],
    now: Date = new Date(),
): Promise<Map<string, SendingRampStats>> {
    const stats = new Map<string, SendingRampStats>()
    if (emailAccountIds.length === 0) return stats

    const from = new Date(now.getTime() - RAMP_WINDOW_DAYS * DAY_MS)
    const ids = sql.join(emailAccountIds.map((id) => sql`${id}::uuid`), sql`, `)
    const rows = resultRows<StatsRow>(await db.execute(sql`
        SELECT e.email_account_id AS "id",
            count(*) FILTER (WHERE e.sent_at IS NOT NULL)::int AS "sent",
            count(*) FILTER (WHERE e.bounced_at IS NOT NULL)::int AS "bounces",
            count(*) FILTER (WHERE e.unsubscribed_at IS NOT NULL)::int AS "unsubscribes",
            count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM suppressions s
                WHERE s.organization_id = e.organization_id
                  AND s.source = 'complaint'
                  AND lower(s.email_address) = lower(e.to_address)
            ))::int AS "complaints"
        FROM outreach_emails e
        WHERE e.organization_id = ${organizationId}::uuid
          AND e.email_account_id IN (${ids})
          AND e.sent_at >= ${from.toISOString()}::timestamp
          AND e.sent_at < ${now.toISOString()}::timestamp
        GROUP BY e.email_account_id
    `))
    for (const row of rows) {
        stats.set(row.id, {
            sent: Number(row.sent) || 0,
            bounces: Number(row.bounces) || 0,
            complaints: Number(row.complaints) || 0,
            unsubscribes: Number(row.unsubscribes) || 0,
        })
    }
    return stats
}
