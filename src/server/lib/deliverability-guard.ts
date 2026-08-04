export interface CampaignHealthRow {
    campaignId: string
    organizationId: string
    sentCount: string | number
    bouncedCount: string | number
    unsubscribedCount: string | number
    bounceRateLimitPercent: string | number
    bounceRateMinSample: string | number
    unsubscribeRateLimitPercent: string | number
    unsubscribeRateMinSample: string | number
}

export interface DeliverabilityTrip {
    campaignId: string
    organizationId: string
    reason: 'bounce_rate' | 'unsubscribe_rate'
    sentCount: number
    eventCount: number
    ratePercent: number
    limitPercent: number
}

export function evaluateDeliverabilityTrip(row: CampaignHealthRow): DeliverabilityTrip | null {
    const sentCount = Number(row.sentCount)
    const bouncedCount = Number(row.bouncedCount)
    const unsubscribedCount = Number(row.unsubscribedCount)
    const bounceLimit = Number(row.bounceRateLimitPercent)
    const unsubscribeLimit = Number(row.unsubscribeRateLimitPercent)
    const bounceRate = sentCount > 0 ? (bouncedCount / sentCount) * 100 : 0
    const unsubscribeRate = sentCount > 0 ? (unsubscribedCount / sentCount) * 100 : 0

    if (sentCount >= Number(row.bounceRateMinSample) && bounceRate >= bounceLimit) {
        return {
            campaignId: row.campaignId,
            organizationId: row.organizationId,
            reason: 'bounce_rate',
            sentCount,
            eventCount: bouncedCount,
            ratePercent: bounceRate,
            limitPercent: bounceLimit,
        }
    }
    if (sentCount >= Number(row.unsubscribeRateMinSample) && unsubscribeRate >= unsubscribeLimit) {
        return {
            campaignId: row.campaignId,
            organizationId: row.organizationId,
            reason: 'unsubscribe_rate',
            sentCount,
            eventCount: unsubscribedCount,
            ratePercent: unsubscribeRate,
            limitPercent: unsubscribeLimit,
        }
    }
    return null
}
