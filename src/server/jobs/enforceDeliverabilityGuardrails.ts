import { queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { publishOutreachEvent } from '../lib/xphere-events'
import { evaluateDeliverabilityTrip, type CampaignHealthRow, type DeliverabilityTrip } from '../lib/deliverability-guard'

const log = createLogger('outreach.deliverability.guard')

/** Pause active campaigns whose 24-hour metrics cross organization-configured safety limits. */
export async function enforceDeliverabilityGuardrails(now: Date = new Date()): Promise<DeliverabilityTrip[]> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
    const rows = await queryClient<CampaignHealthRow[]>`
        SELECT
            campaign.id::text AS "campaignId",
            campaign.organization_id::text AS "organizationId",
            count(email.id) AS "sentCount",
            count(email.id) FILTER (WHERE email.status = 'bounced' OR email.bounced_at IS NOT NULL) AS "bouncedCount",
            count(email.id) FILTER (WHERE email.unsubscribed_at IS NOT NULL) AS "unsubscribedCount",
            coalesce(setting.bounce_rate_limit_percent, 5) AS "bounceRateLimitPercent",
            coalesce(setting.bounce_rate_min_sample, 20) AS "bounceRateMinSample",
            coalesce(setting.unsubscribe_rate_limit_percent, 2) AS "unsubscribeRateLimitPercent",
            coalesce(setting.unsubscribe_rate_min_sample, 50) AS "unsubscribeRateMinSample"
        FROM campaigns AS campaign
        JOIN outreach_emails AS email
          ON email.campaign_id = campaign.id
         AND email.sent_at >= ${cutoff}
        LEFT JOIN outreach_settings AS setting ON setting.organization_id = campaign.organization_id
        WHERE campaign.status = 'active'
          AND coalesce(setting.deliverability_guard_enabled, true) = true
        GROUP BY campaign.id,
            setting.bounce_rate_limit_percent, setting.bounce_rate_min_sample,
            setting.unsubscribe_rate_limit_percent, setting.unsubscribe_rate_min_sample
        HAVING count(email.id) >= 10
        ORDER BY count(email.id) DESC
        LIMIT 500
    `

    const tripped: DeliverabilityTrip[] = []
    for (const row of rows) {
        const trip = evaluateDeliverabilityTrip(row)
        if (!trip) continue
        const [paused] = await queryClient<{ id: string }[]>`
            UPDATE campaigns
            SET status = 'paused',
                paused_at = ${now},
                paused_reason = ${trip.reason},
                updated_at = ${now}
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
    await runWithLock('enforceDeliverabilityGuardrails', enforceDeliverabilityGuardrails)
}
