import { describe, expect, it } from 'vitest'
import { computeBaselineHypothesis, resolveHypothesis, type BaselineRunSample } from '../baseline-hypothesis'
import type { ProspectingHypothesis } from '../hypothesis'

function sample(label: string, overrides: Partial<BaselineRunSample> = {}): BaselineRunSample {
    return {
        label,
        discoveredCount: 0,
        emailedCount: 0,
        repliedCount: 0,
        attributedLeadCount: 0,
        verifiedOrLikelyLeadCount: 0,
        verifiedOkCount: null,
        webPresenceCoverage: null,
        template: null,
        enrichedCount: 0,
        costUsd: null,
        ...overrides,
    }
}

const CONTEXT = { provider: 'xcraper', template: 'enriched' }

describe('computeBaselineHypothesis — refuses to invent with fewer than 3 runs', () => {
    it('returns an empty expected and the fixed "first run" basis with zero prior runs', () => {
        const result = computeBaselineHypothesis([], CONTEXT)
        expect(result.expected).toEqual({})
        expect(result.basis).toBe('first run in this segment; no baseline yet')
    })

    it('still refuses with 1 prior run', () => {
        const result = computeBaselineHypothesis([sample('run-1', { discoveredCount: 40 })], CONTEXT)
        expect(result.expected).toEqual({})
        expect(result.basis).toBe('first run in this segment; no baseline yet')
    })

    it('still refuses with 2 prior runs — a "median" of two is really just picking one of two arbitrary numbers', () => {
        const result = computeBaselineHypothesis(
            [sample('run-1', { discoveredCount: 40 }), sample('run-2', { discoveredCount: 60 })],
            CONTEXT,
        )
        expect(result.expected).toEqual({})
        expect(result.basis).toBe('first run in this segment; no baseline yet')
    })
})

describe('computeBaselineHypothesis — median with 20% forgiving slack', () => {
    const samples: BaselineRunSample[] = [
        sample('run-1', { discoveredCount: 10, emailedCount: 100, repliedCount: 1, costUsd: 1 }),
        sample('run-2', { discoveredCount: 20, emailedCount: 100, repliedCount: 2, costUsd: 2 }),
        sample('run-3', { discoveredCount: 30, emailedCount: 100, repliedCount: 3, costUsd: 3 }),
        sample('run-4', { discoveredCount: 40, emailedCount: 100, repliedCount: 4, costUsd: 4 }),
        sample('run-5', { discoveredCount: 50, emailedCount: 100, repliedCount: 5, costUsd: 5 }),
    ]

    it('floors a ">=" metric (higher is better) at median * 0.8', () => {
        // discoveredCount median across [10,20,30,40,50] is 30 -> floor at 30*0.8 = 24.
        const result = computeBaselineHypothesis(samples, CONTEXT)
        expect(result.expected.discovered).toBe('>=24')
    })

    it('reply_rate follows the same ">=" rule: median 0.03 -> floor 0.024', () => {
        const result = computeBaselineHypothesis(samples, CONTEXT)
        expect(result.expected.reply_rate).toBe('>=0.024')
    })

    it('caps the "<=" metric (cost_usd, lower is better) at median * 1.2, not median * 0.8', () => {
        // costUsd median across [1,2,3,4,5] is 3 -> cap at 3*1.2 = 3.6.
        const result = computeBaselineHypothesis(samples, CONTEXT)
        expect(result.expected.cost_usd).toBe('<=3.6')
    })

    it('names the runs used and their median in basis', () => {
        const result = computeBaselineHypothesis(samples, CONTEXT)
        expect(result.basis).toContain('run-1')
        expect(result.basis).toContain('run-5')
        expect(result.basis).toContain('discovered=30')
        expect(result.basis).toContain('n=5')
    })

    it('never invents a value for a metric none of the samples could measure', () => {
        // No sample here has webPresenceCoverage, a template, or a verifiedOkCount/attributed
        // lead — no_owned_website_rate, booking_platform_share, email_rate and
        // verified_email_rate must all be absent from `expected`, not defaulted to anything.
        const result = computeBaselineHypothesis(samples, CONTEXT)
        expect(result.expected).not.toHaveProperty('no_owned_website_rate')
        expect(result.expected).not.toHaveProperty('booking_platform_share')
        expect(result.expected).not.toHaveProperty('email_rate')
        expect(result.expected).not.toHaveProperty('verified_email_rate')
    })

    it('only takes the median over samples that actually measured the metric', () => {
        // Only 3 of 5 runs ever got verified — the other two contribute no value, and the
        // median (and basis "n=") reflect 3, not 5.
        const mixed: BaselineRunSample[] = [
            sample('a', { discoveredCount: 100, verifiedOkCount: 10 }), // 0.10
            sample('b', { discoveredCount: 100, verifiedOkCount: 20 }), // 0.20
            sample('c', { discoveredCount: 100, verifiedOkCount: 30 }), // 0.30
            sample('d', { discoveredCount: 100, verifiedOkCount: null }),
            sample('e', { discoveredCount: 100, verifiedOkCount: null }),
        ]
        const result = computeBaselineHypothesis(mixed, CONTEXT)
        // median of [0.10, 0.20, 0.30] is 0.20 -> floor 0.20*0.8 = 0.16.
        expect(result.expected.verified_email_rate).toBe('>=0.16')
        expect(result.basis).toContain('verified_email_rate=0.2 (n=3)')
    })
})

describe('resolveHypothesis — human precedence', () => {
    const generated = computeBaselineHypothesis(
        [
            sample('run-1', { discoveredCount: 10 }),
            sample('run-2', { discoveredCount: 20 }),
            sample('run-3', { discoveredCount: 30 }),
        ],
        CONTEXT,
    )

    it('returns the human hypothesis untouched when one was supplied, ignoring the generated baseline entirely', () => {
        const human: ProspectingHypothesis = {
            premise: 'this vertical skews mobile-only, expect low owned-website coverage',
            expected: { discovered: '>=5' },
            basis: 'operator judgment, not a baseline',
        }
        expect(resolveHypothesis(human, generated)).toBe(human)
    })

    it('falls back to the generated baseline when no human hypothesis was supplied', () => {
        expect(resolveHypothesis(undefined, generated)).toBe(generated)
    })
})
