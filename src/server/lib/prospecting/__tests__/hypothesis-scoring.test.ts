import { describe, expect, it } from 'vitest'
import {
    extractExpectedMetrics,
    parseComparator,
    scoreHypothesis,
    type HypothesisMeasuredValues,
} from '../hypothesis-scoring'

function measured(overrides: Partial<HypothesisMeasuredValues> = {}): HypothesisMeasuredValues {
    return {
        discoveredCount: 0,
        emailedCount: 0,
        repliedCount: 0,
        attributedLeadCount: 0,
        verifiedOrLikelyLeadCount: 0,
        ...overrides,
    }
}

describe('parseComparator', () => {
    it.each([
        ['>=30', { op: '>=', value: 30 }],
        ['>30', { op: '>', value: 30 }],
        ['<=30', { op: '<=', value: 30 }],
        ['<30', { op: '<', value: 30 }],
        ['==30', { op: '==', value: 30 }],
        ['=30', { op: '==', value: 30 }],
        ['30', { op: '>=', value: 30 }],
        ['  >=   30  ', { op: '>=', value: 30 }],
        ['>=3%', { op: '>=', value: 0.03 }],
        ['>=0.25', { op: '>=', value: 0.25 }],
        ['-5', { op: '>=', value: -5 }],
        ['>=2.5', { op: '>=', value: 2.5 }],
    ])('parses %s', (raw, expected) => {
        expect(parseComparator(raw)).toEqual(expected)
    })

    it('treats a bare JSON number the same as a bare-number string (>=)', () => {
        expect(parseComparator(30)).toEqual({ op: '>=', value: 30 })
    })

    it.each([
        ['garbage'],
        ['>=abc'],
        [''],
        ['   '],
        ['>=10-20'],
        ['~30'],
        ['>=30 or 40'],
        [NaN],
        [null],
        [undefined],
        [{}],
        [[]],
        [true],
    ])('returns null for unparsable input %p', (raw) => {
        expect(parseComparator(raw)).toBeNull()
    })
})

describe('scoreHypothesis — per-metric verdicts', () => {
    it('scores "discovered" against discoveredCount, met', () => {
        const result = scoreHypothesis({ discovered: '>=30' }, measured({ discoveredCount: 40 }))
        expect(result.metrics).toHaveLength(1)
        expect(result.metrics[0]).toMatchObject({ metric: 'discovered', actual: 40, verdict: 'met' })
        expect(result.overall).toBe('confirmed')
    })

    it('scores "discovered" not met', () => {
        const result = scoreHypothesis({ discovered: '>=30' }, measured({ discoveredCount: 10 }))
        expect(result.metrics[0]).toMatchObject({ actual: 10, verdict: 'not_met' })
        expect(result.overall).toBe('refuted')
    })

    it('scores "reply_rate" as replied/emailed', () => {
        const result = scoreHypothesis({ reply_rate: '>=0.03' }, measured({ emailedCount: 100, repliedCount: 5 }))
        expect(result.metrics[0]).toMatchObject({ actual: 0.05, verdict: 'met' })
    })

    it('a zero-emailed denominator is unknown, never refuted', () => {
        const result = scoreHypothesis({ reply_rate: '>=0.03' }, measured({ emailedCount: 0, repliedCount: 0 }))
        expect(result.metrics[0].verdict).toBe('unknown')
        expect(result.metrics[0].actual).toBeNull()
        expect(result.overall).toBe('inconclusive')
    })

    it('scores "verified_email_rate" as verified-or-likely / attributed leads', () => {
        const result = scoreHypothesis(
            { verified_email_rate: '>=0.25' },
            measured({ attributedLeadCount: 50, verifiedOrLikelyLeadCount: 20 }),
        )
        expect(result.metrics[0]).toMatchObject({ actual: 0.4, verdict: 'met' })
    })

    it('a zero attributed-lead denominator is unknown, never refuted', () => {
        const result = scoreHypothesis(
            { verified_email_rate: '>=0.25' },
            measured({ attributedLeadCount: 0, verifiedOrLikelyLeadCount: 0 }),
        )
        expect(result.metrics[0].verdict).toBe('unknown')
        expect(result.overall).toBe('inconclusive')
    })

    it('an unrecognized metric key is unknown, never guessed', () => {
        const result = scoreHypothesis({ made_up_metric: '>=1' }, measured({ discoveredCount: 100 }))
        expect(result.metrics[0]).toMatchObject({ metric: 'made_up_metric', verdict: 'unknown', actual: null })
        expect(result.overall).toBe('inconclusive')
    })

    it('an unparsable expectation is unknown, never met or refuted', () => {
        const result = scoreHypothesis({ discovered: 'lots' }, measured({ discoveredCount: 100 }))
        expect(result.metrics[0]).toMatchObject({ verdict: 'unknown', actual: null, comparator: null })
        expect(result.overall).toBe('inconclusive')
    })

    it('echoes the parsed comparator back on the result for inspection', () => {
        const result = scoreHypothesis({ discovered: '>=30' }, measured({ discoveredCount: 40 }))
        expect(result.metrics[0].comparator).toEqual({ op: '>=', value: 30 })
    })
})

describe('scoreHypothesis — overall verdict', () => {
    it('confirmed when every computable expectation is met and at least one was computable', () => {
        const result = scoreHypothesis(
            { discovered: '>=30', reply_rate: '>=0.03' },
            measured({ discoveredCount: 40, emailedCount: 100, repliedCount: 5 }),
        )
        expect(result.overall).toBe('confirmed')
    })

    it('inconclusive when a metric is met but another is unknown — a half-tested prediction is not a confirmed one', () => {
        const result = scoreHypothesis(
            { discovered: '>=30', made_up: '>=1' },
            measured({ discoveredCount: 40 }),
        )
        expect(result.overall).toBe('inconclusive')
    })

    it('inconclusive for the real Cape Cod shape: discovery met, every rate unmeasurable because nothing was sent', () => {
        // 50 businesses found, zero emails ever sent. Both rate denominators are zero, so both
        // are unknown. Emitting `confirmed` here would let a tally of confirmed hypotheses count
        // runs that never tested their own premise.
        const result = scoreHypothesis(
            { discovered: '>=30', reply_rate: '>=0.03', verified_email_rate: '>=0.25' },
            measured({ discoveredCount: 50 }),
        )
        expect(result.overall).toBe('inconclusive')
        expect(result.metrics.find((m) => m.metric === 'discovered')?.verdict).toBe('met')
        expect(result.metrics.find((m) => m.metric === 'reply_rate')?.verdict).toBe('unknown')
    })

    it('confirmed only when every expectation was computable and met', () => {
        const result = scoreHypothesis(
            { discovered: '>=30', reply_rate: '>=0.03' },
            measured({ discoveredCount: 40, emailedCount: 100, repliedCount: 5 }),
        )
        expect(result.overall).toBe('confirmed')
    })

    it('refuted outranks unknown — one broken promise refutes however much else is unmeasurable', () => {
        const result = scoreHypothesis(
            { discovered: '>=30', reply_rate: '>=0.03' },
            measured({ discoveredCount: 5 }),
        )
        expect(result.overall).toBe('refuted')
    })

    it('refuted when at least one expectation is definitively not met, even if others are met', () => {
        const result = scoreHypothesis(
            { discovered: '>=30', reply_rate: '>=0.50' },
            measured({ discoveredCount: 40, emailedCount: 100, repliedCount: 5 }),
        )
        expect(result.overall).toBe('refuted')
    })

    it('inconclusive when every expectation is unknown', () => {
        const result = scoreHypothesis(
            { reply_rate: '>=0.03', verified_email_rate: '>=0.25' },
            measured({ emailedCount: 0, attributedLeadCount: 0 }),
        )
        expect(result.overall).toBe('inconclusive')
    })

    it('inconclusive when expected is empty', () => {
        expect(scoreHypothesis({}, measured()).overall).toBe('inconclusive')
    })

    it('inconclusive when expected is null/undefined', () => {
        expect(scoreHypothesis(null, measured()).overall).toBe('inconclusive')
        expect(scoreHypothesis(undefined, measured()).overall).toBe('inconclusive')
    })
})

describe('extractExpectedMetrics', () => {
    it('extracts string/number leaves from hypothesis.expected', () => {
        expect(extractExpectedMetrics({ expected: { discovered: '>=30', sampleSize: 150 } }))
            .toEqual({ discovered: '>=30', sampleSize: 150 })
    })

    it('drops non-string/number leaves defensively', () => {
        expect(extractExpectedMetrics({ expected: { discovered: '>=30', nested: { a: 1 } } }))
            .toEqual({ discovered: '>=30' })
    })

    it('returns null when there is no expected object', () => {
        expect(extractExpectedMetrics({})).toBeNull()
        expect(extractExpectedMetrics({ premise: 'x' })).toBeNull()
    })

    it('returns null when expected has zero valid keys', () => {
        expect(extractExpectedMetrics({ expected: { nested: { a: 1 } } })).toBeNull()
    })

    it('returns null for non-object input', () => {
        expect(extractExpectedMetrics(null)).toBeNull()
        expect(extractExpectedMetrics(undefined)).toBeNull()
        expect(extractExpectedMetrics('not an object')).toBeNull()
    })
})
