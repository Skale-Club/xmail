import { queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { sqlTimestampValue } from '../lib/sql-timestamp'
import { publishOutreachEvent } from '../lib/xphere-events'
import { evaluateDeliverabilityTrip, type CampaignHealthRow, type DeliverabilityTrip } from '../lib/deliverability-guard'

const log = createLogger('outreach.deliverability.guard')

/**
 * The raw shape returned by the SQL query below — before the 24h-vs-all-time denominator
 * choice `buildCampaignHealthRow` makes explicit and testable without a database.
 */
export interface RawCampaignHealthRow {
    campaignId: string
    organizationId: string
    sentCount24h: string | number
    sentCountAllTime: string | number
    bouncedCount: string | number
    unsubscribedCount: string | number
    bounceRateLimitPercent: string | number
    bounceRateMinSample: string | number
    unsubscribeRateLimitPercent: string | number
    unsubscribeRateMinSample: string | number
}

/**
 * Turn a raw row into the shape `evaluateDeliverabilityTrip` consumes, deciding the sent-count
 * denominator on the way.
 *
 * The numerators (`bouncedCount`/`unsubscribedCount`) are always filtered by the EVENT's own
 * timestamp (`bounced_at >= cutoff` / `unsubscribed_at >= cutoff`) in the SQL below — a bounce or
 * unsubscribe that arrives today for a message sent last week must still count today, not be
 * invisible because that message fell outside a `sent_at >= cutoff` join. The denominator is
 * where the actual choice lives: prefer sends within the same 24h window (the intuitive "rate
 * over the last day"), but when nothing was sent in that window at all — a quiet campaign whose
 * only new events are the very bounces/unsubscribes this guard exists to catch — divide over
 * all-time sends instead of by zero. Dividing by zero would either read as `0` (in
 * `evaluateDeliverabilityTrip`'s own `sentCount > 0 ? … : 0` guard) and silently hide a real
 * problem, or worse, if the guard's own zero-check were ever loosened. All-time sends for a
 * still-active campaign is always a defined, positive number once anything has ever gone out.
 */
export function buildCampaignHealthRow(row: RawCampaignHealthRow): CampaignHealthRow {
    const sentCount24h = Number(row.sentCount24h)
    const sentCountAllTime = Number(row.sentCountAllTime)
    return {
        campaignId: row.campaignId,
        organizationId: row.organizationId,
        sentCount: sentCount24h > 0 ? sentCount24h : sentCountAllTime,
        bouncedCount: row.bouncedCount,
        unsubscribedCount: row.unsubscribedCount,
        bounceRateLimitPercent: row.bounceRateLimitPercent,
        bounceRateMinSample: row.bounceRateMinSample,
        unsubscribeRateLimitPercent: row.unsubscribeRateLimitPercent,
        unsubscribeRateMinSample: row.unsubscribeRateMinSample,
    }
}

/** Pause active campaigns whose 24-hour metrics cross organization-configured safety limits. */
export async function enforceDeliverabilityGuardrails(now: Date = new Date()): Promise<DeliverabilityTrip[]> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
    const nowIso = sqlTimestampValue(now)
    const cutoffIso = sqlTimestampValue(cutoff)
    const rawRows = await queryClient<RawCampaignHealthRow[]>`
        SELECT
            campaign.id::text AS "campaignId",
            campaign.organization_id::text AS "organizationId",
            count(email.id) FILTER (WHERE email.sent_at >= ${cutoffIso}) AS "sentCount24h",
            -- All-time sent count for this campaign, decoupled from the join's row filter below
            -- (which only pulls in rows touched — sent, bounced, or unsubscribed — in the last
            -- 24h) so it stays a true "everything ever sent" fallback denominator.
            (
                SELECT count(*) FROM outreach_emails AS all_email
                WHERE all_email.campaign_id = campaign.id AND all_email.sent_at IS NOT NULL
            ) AS "sentCountAllTime",
            count(email.id) FILTER (WHERE email.bounced_at >= ${cutoffIso}) AS "bouncedCount",
            count(email.id) FILTER (WHERE email.unsubscribed_at >= ${cutoffIso}) AS "unsubscribedCount",
            coalesce(setting.bounce_rate_limit_percent, 5) AS "bounceRateLimitPercent",
            coalesce(setting.bounce_rate_min_sample, 20) AS "bounceRateMinSample",
            coalesce(setting.unsubscribe_rate_limit_percent, 2) AS "unsubscribeRateLimitPercent",
            coalesce(setting.unsubscribe_rate_min_sample, 50) AS "unsubscribeRateMinSample"
        FROM campaigns AS campaign
        JOIN outreach_emails AS email
          ON email.campaign_id = campaign.id
         AND (
             email.sent_at >= ${cutoffIso}
             OR email.bounced_at >= ${cutoffIso}
             OR email.unsubscribed_at >= ${cutoffIso}
         )
        LEFT JOIN outreach_settings AS setting ON setting.organization_id = campaign.organization_id
        WHERE campaign.status = 'active'
          AND coalesce(setting.deliverability_guard_enabled, true) = true
        GROUP BY campaign.id,
            setting.bounce_rate_limit_percent, setting.bounce_rate_min_sample,
            setting.unsubscribe_rate_limit_percent, setting.unsubscribe_rate_min_sample
        HAVING count(email.id) FILTER (WHERE email.sent_at >= ${cutoffIso}) >= 10
            OR count(email.id) FILTER (WHERE email.bounced_at >= ${cutoffIso}) > 0
            OR count(email.id) FILTER (WHERE email.unsubscribed_at >= ${cutoffIso}) > 0
        ORDER BY count(email.id) FILTER (WHERE email.sent_at >= ${cutoffIso}) DESC
        LIMIT 500
    `
    const rows = rawRows.map(buildCampaignHealthRow)

    const tripped: DeliverabilityTrip[] = []
    for (const row of rows) {
        const trip = evaluateDeliverabilityTrip(row)
        if (!trip) continue
        const [paused] = await queryClient<{ id: string }[]>`
            UPDATE campaigns
            SET status = 'paused',
                paused_at = ${nowIso},
                paused_reason = ${trip.reason},
                updated_at = ${nowIso}
            WHERE id = ${trip.campaignId}::uuid
              AND organization_id = ${trip.organizationId}::uuid
              AND status = 'active'
            RETURNING id::text
        `
        if (!paused) continue
        tripped.push(trip)
        await publishOutreachEvent({
            organizationId: trip.organizationId,
            eventType: 'campaign.deliverability_paused',
            aggregateType: 'campaign',
            aggregateId: trip.campaignId,
            deduplicationKey: `campaign.deliverability_paused:${trip.campaignId}:${now.toISOString().slice(0, 10)}:${trip.reason}`,
            payload: {
                campaign_id: trip.campaignId,
                reason: trip.reason,
                sent_count_24h: trip.sentCount,
                event_count_24h: trip.eventCount,
                rate_percent_24h: Number(trip.ratePercent.toFixed(2)),
                limit_percent: trip.limitPercent,
                human_review_required: true,
            },
        })
        log.warn({ action: 'outreach.deliverability.campaign_paused', ...trip }, 'campaign paused by deliverability guard')
    }
    return tripped
}

export async function runDeliverabilityGuardrailsWithLock(): Promise<void> {
    // jobs/index.ts schedules this every 10 minutes — the same as cron-lock's default budget.
    // 8 minutes leaves a margin so the lock reliably clears before the next scheduled tick instead
    // of racing it.
    await runWithLock('enforceDeliverabilityGuardrails', enforceDeliverabilityGuardrails, { timeoutMs: 8 * 60 * 1000 })
}
