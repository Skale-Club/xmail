import { describe, expect, it, vi } from 'vitest'
import { evaluateDeliverabilityTrip } from '../lib/deliverability-guard'

// Pure unit tests — no DB. `buildCampaignHealthRow` is exported from the job module for
// testability, but importing that module also pulls in `../../db` (via `queryClient`), which
// throws at import time without DATABASE_URL. Mock it out, same as
// amortizeSubscriptionCosts.test.ts / measureProspectingOutcomes.test.ts do for the same reason.
// vi.mock calls are hoisted above imports by Vitest regardless of source order.
vi.mock('../../db', () => ({ db: {}, queryClient: vi.fn() }))

import { buildCampaignHealthRow, type RawCampaignHealthRow } from './enforceDeliverabilityGuardrails'

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

function rawRow(overrides: Partial<RawCampaignHealthRow> = {}): RawCampaignHealthRow {
    return {
        campaignId: 'campaign-1',
        organizationId: 'org-1',
        sentCount24h: 100,
        sentCountAllTime: 500,
        bouncedCount: 1,
        unsubscribedCount: 0,
        bounceRateLimitPercent: 5,
        bounceRateMinSample: 20,
        unsubscribeRateLimitPercent: 2,
        unsubscribeRateMinSample: 50,
        ...overrides,
    }
}

describe('buildCampaignHealthRow (24h vs all-time sent-count denominator)', () => {
    it('prefers the 24h sent count when the campaign sent something in the window', () => {
        expect(buildCampaignHealthRow(rawRow({ sentCount24h: 100, sentCountAllTime: 500 })).sentCount).toBe(100)
    })

    it('falls back to the all-time sent count when nothing was sent in the 24h window', () => {
        // A quiet campaign whose only new activity is a late bounce/unsubscribe on an old send:
        // dividing by the (zero) 24h send count would either hide the event entirely or divide
        // by zero, so the rate is computed against everything the campaign has ever sent.
        expect(buildCampaignHealthRow(rawRow({ sentCount24h: 0, sentCountAllTime: 500 })).sentCount).toBe(500)
    })

    it('stays at zero when the campaign has never sent anything at all', () => {
        expect(buildCampaignHealthRow(rawRow({ sentCount24h: 0, sentCountAllTime: 0 })).sentCount).toBe(0)
    })

    it('passes bounced/unsubscribed counts and thresholds through unchanged', () => {
        const built = buildCampaignHealthRow(rawRow({ bouncedCount: 7, unsubscribedCount: 3 }))
        expect(built).toMatchObject({
            campaignId: 'campaign-1',
            organizationId: 'org-1',
            bouncedCount: 7,
            unsubscribedCount: 3,
            bounceRateLimitPercent: 5,
            bounceRateMinSample: 20,
            unsubscribeRateLimitPercent: 2,
            unsubscribeRateMinSample: 50,
        })
    })

    it('surfaces a bounce on an old send once the fallback denominator applies', () => {
        // The exact scenario the fix targets: no sends in the last 24h, but a bounce arrived for
        // a message sent well before the window. It must still be visible to the trip evaluator.
        const built = buildCampaignHealthRow(rawRow({ sentCount24h: 0, sentCountAllTime: 40, bouncedCount: 4 }))
        expect(evaluateDeliverabilityTrip(built)).toMatchObject({ reason: 'bounce_rate', eventCount: 4 })
    })
})
