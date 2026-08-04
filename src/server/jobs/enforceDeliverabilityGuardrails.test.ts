import { describe, expect, it } from 'vitest'
import { evaluateDeliverabilityTrip } from '../lib/deliverability-guard'

function row(overrides: Partial<Parameters<typeof evaluateDeliverabilityTrip>[0]> = {}) {
    return {
        campaignId: 'campaign-1',
        organizationId: 'org-1',
        sentCount: 100,
        bouncedCount: 1,
        unsubscribedCount: 0,
        bounceRateLimitPercent: 5,
        bounceRateMinSample: 20,
        unsubscribeRateLimitPercent: 2,
        unsubscribeRateMinSample: 50,
        ...overrides,
    }
}

describe('deliverability circuit breaker', () => {
    it('does not trip below the minimum sample even when a tiny sample looks bad', () => {
        expect(evaluateDeliverabilityTrip(row({ sentCount: 10, bouncedCount: 10 }))).toBeNull()
    })

    it('prioritizes a bounce-rate trip when the configured limit is reached', () => {
        expect(evaluateDeliverabilityTrip(row({ sentCount: 100, bouncedCount: 5 }))).toMatchObject({
            reason: 'bounce_rate',
            ratePercent: 5,
            eventCount: 5,
        })
    })

    it('trips unsubscribe rate independently after its own sample floor', () => {
        expect(evaluateDeliverabilityTrip(row({ sentCount: 50, bouncedCount: 0, unsubscribedCount: 1 }))).toMatchObject({
            reason: 'unsubscribe_rate',
            ratePercent: 2,
            eventCount: 1,
        })
    })

    it('does not trip a healthy campaign', () => {
        expect(evaluateDeliverabilityTrip(row())).toBeNull()
    })
})
