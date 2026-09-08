import { describe, expect, it } from 'vitest'
import {
    extractExpectedMetrics,
    parseComparator,
    scoreHypothesis,
    verdictFingerprint,
    type HypothesisMeasuredValues,
} from '../hypothesis-scoring'

/** The real byWebPresence shape (external-run.ts's runCoverageSchema.byWebPresence), summed
 *  to `total` by the scorer — the five non-owned buckets are split arbitrarily as long as
 *  they add up to the "no owned website" count the fixture needs. */
function coverage(ownedWebsite: number, noOwnedWebsite: number): Record<string, number> {
    return {
        owned_website: ownedWebsite,
        none: noOwnedWebsite,
        booking_platform: 0,
        social_profile: 0,
        link_hub: 0,
        directory_listing: 0,
    }
}

function measured(overrides: Partial<HypothesisMeasuredValues> = {}): HypothesisMeasuredValues {
    return {
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

    describe('"verified_email_rate" — Phase 34 measured verification (verifiedOkCount)', () => {
        it('uses verifiedOkCount / discoveredCount when a verification has been measured, ignoring the leads-based counts', () => {
            // The real Fase 34 evidence shape: 98 checked, 69 ok, out of a run that discovered
            // 100. attributedLeadCount/verifiedOrLikelyLeadCount are deliberately left at their
            // leads-based (and here misleading) defaults to prove they are NOT consulted.
            const result = scoreHypothesis(
                { verified_email_rate: '>=0.6' },
                measured({
                    discoveredCount: 100,
                    verifiedOkCount: 69,
                    attributedLeadCount: 10,
                    verifiedOrLikelyLeadCount: 1,
                }),
            )
            expect(result.metrics[0]).toMatchObject({ actual: 0.69, verdict: 'met' })
            expect(result.metrics[0].reason).toContain('69/100 verified (measured)')
        })

        it('falls back to the leads-based ratio when verifiedOkCount is null (never measured)', () => {
            const result = scoreHypothesis(
                { verified_email_rate: '>=0.25' },
                measured({ verifiedOkCount: null, attributedLeadCount: 50, verifiedOrLikelyLeadCount: 20 }),
            )
            expect(result.metrics[0]).toMatchObject({ actual: 0.4, verdict: 'met' })
        })

        it('a zero discoveredCount denominator is unknown, never refuted, even with a measured verifiedOkCount', () => {
            const result = scoreHypothesis(
                { verified_email_rate: '>=0.25' },
                measured({ discoveredCount: 0, verifiedOkCount: 0 }),
            )
            expect(result.metrics[0].verdict).toBe('unknown')
            expect(result.overall).toBe('inconclusive')
        })

        it('a measured verifiedOkCount of exactly 0 is a real zero, not treated as "never measured"', () => {
            const result = scoreHypothesis(
                { verified_email_rate: '<0.1' },
                measured({ discoveredCount: 50, verifiedOkCount: 0 }),
            )
            expect(result.metrics[0]).toMatchObject({ actual: 0, verdict: 'met' })
        })
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

// ============================================================
// Phase 35 — new metrics
// ============================================================

describe('scoreHypothesis — "no_owned_website_rate"', () => {
    it('is 1 - owned_website / total across every coverage bucket, not just owned vs none', () => {
        const result = scoreHypothesis(
            { no_owned_website_rate: '>=0.4' },
            measured({ webPresenceCoverage: coverage(12, 13) }),
        )
        expect(result.metrics[0]).toMatchObject({ actual: 0.52, verdict: 'met' })
        expect(result.metrics[0].reason).toContain('13/25 without an owned website')
    })

    it('is unknown, never a 0% ownership rate, when no coverage was ever recorded', () => {
        const result = scoreHypothesis({ no_owned_website_rate: '>=0.4' }, measured({ webPresenceCoverage: null }))
        expect(result.metrics[0].verdict).toBe('unknown')
        expect(result.metrics[0].actual).toBeNull()
    })
})

describe('scoreHypothesis — "booking_platform_share"', () => {
    it('is booking_platform / total', () => {
        const result = scoreHypothesis(
            { booking_platform_share: '>=0.1' },
            measured({ webPresenceCoverage: { owned_website: 10, none: 10, booking_platform: 5, social_profile: 0, link_hub: 0, directory_listing: 0 } }),
        )
        expect(result.metrics[0]).toMatchObject({ actual: 0.2, verdict: 'met' })
        expect(result.metrics[0].reason).toContain('5/25 on a booking platform')
    })

    it('is unknown when no coverage was recorded', () => {
        const result = scoreHypothesis({ booking_platform_share: '>=0.1' }, measured({ webPresenceCoverage: null }))
        expect(result.metrics[0].verdict).toBe('unknown')
    })
})

describe('scoreHypothesis — "email_rate"', () => {
    it('is enriched_count / discoveredCount for the "enriched" template', () => {
        const result = scoreHypothesis(
            { email_rate: '>=0.2' },
            measured({ template: 'enriched', discoveredCount: 25, enrichedCount: 7 }),
        )
        expect(result.metrics[0]).toMatchObject({ actual: 0.28, verdict: 'met' })
    })

    it('is unknown, NOT 0, for the "standard" template — that actor never extracts email at all', () => {
        const result = scoreHypothesis(
            { email_rate: '>=0.1' },
            // A misleading enrichedCount of 0 on a standard-template run: if this scored as
            // 0/discoveredCount it would refute a run for skipping a step it was never asked
            // to perform.
            measured({ template: 'standard', discoveredCount: 25, enrichedCount: 0 }),
        )
        expect(result.metrics[0].verdict).toBe('unknown')
        expect(result.metrics[0].actual).toBeNull()
        expect(result.metrics[0].reason).toContain('standard')
        expect(result.overall).toBe('inconclusive')
    })

    it('is unknown for a run with no recorded template at all (predates the field)', () => {
        const result = scoreHypothesis({ email_rate: '>=0.1' }, measured({ template: null, discoveredCount: 25, enrichedCount: 7 }))
        expect(result.metrics[0].verdict).toBe('unknown')
    })

    it('a zero discoveredCount denominator is unknown even on the enriched template', () => {
        const result = scoreHypothesis({ email_rate: '>=0.1' }, measured({ template: 'enriched', discoveredCount: 0 }))
        expect(result.metrics[0].verdict).toBe('unknown')
    })
})

describe('scoreHypothesis — "cost_usd" (the one "lower is better" metric)', () => {
    it('a "<=" expectation is met when spend is under budget', () => {
        const result = scoreHypothesis({ cost_usd: '<=2.20' }, measured({ costUsd: 0.1651 }))
        expect(result.metrics[0]).toMatchObject({ actual: 0.1651, verdict: 'met' })
    })

    it('a "<=" expectation is refuted when spend exceeds budget — "lower is better" is not silently flipped to "higher is better"', () => {
        const result = scoreHypothesis({ cost_usd: '<=2.20' }, measured({ costUsd: 3.5 }))
        expect(result.metrics[0]).toMatchObject({ actual: 3.5, verdict: 'not_met' })
        expect(result.overall).toBe('refuted')
    })

    it('is unknown, not a free $0 pass, when there are no lead_source cost entries yet', () => {
        const result = scoreHypothesis({ cost_usd: '<=2.20' }, measured({ costUsd: null }))
        expect(result.metrics[0].verdict).toBe('unknown')
        expect(result.metrics[0].actual).toBeNull()
    })
})

/**
 * The three real production runs from 2026-09-08 that motivated Phase 35 (see the module
 * header comment). Framingham and Worcester wrote `verified_email_rate` hypotheses anchored on
 * the previous run's number and both missed; Boston, the largest sample, held. Before this
 * phase, `no_owned_website_rate`/`email_rate`/`cost_usd` would all have scored `unknown` here
 * even though every number below was already sitting in the database.
 */
describe('scoreHypothesis — Phase 35 real production evidence (2026-09-08)', () => {
    const EXPECTED = {
        discovered: '>=20',
        no_owned_website_rate: '>=0.4',
        email_rate: '>=0.1',
        verified_email_rate: '>=0.15',
        cost_usd: '<=2.20',
    }

    it('Framingham (ff0ddd60): refuted on verified_email_rate (12% < 15%), every other metric met', () => {
        const result = scoreHypothesis(EXPECTED, measured({
            discoveredCount: 25,
            webPresenceCoverage: coverage(12, 13),
            template: 'enriched',
            enrichedCount: 7,
            verifiedOkCount: 3,
            costUsd: 0.1651,
        }))

        expect(result.overall).toBe('refuted')
        expect(result.metrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ metric: 'discovered', actual: 25, verdict: 'met' }),
            expect.objectContaining({ metric: 'no_owned_website_rate', actual: 0.52, verdict: 'met' }),
            expect.objectContaining({ metric: 'email_rate', actual: 0.28, verdict: 'met' }),
            expect.objectContaining({ metric: 'verified_email_rate', actual: 0.12, verdict: 'not_met' }),
            expect.objectContaining({ metric: 'cost_usd', actual: 0.1651, verdict: 'met' }),
        ]))
    })

    it('Worcester (c9c35798): refuted on verified_email_rate (7% < 10%), every other metric met', () => {
        const result = scoreHypothesis({ ...EXPECTED, verified_email_rate: '>=0.10' }, measured({
            discoveredCount: 100,
            webPresenceCoverage: coverage(21, 79),
            template: 'enriched',
            enrichedCount: 11,
            verifiedOkCount: 7,
            // No cost_usd figure was given for this run in the 2026-09-08 evidence (only
            // Framingham's $0.1651 and Boston's $2.0601 were) — this uses the per-result unit
            // cost documented in docs/prospecting-engine-plan.md's Fase 36 (US$0.0061-0.0066)
            // rather than inventing a figure with no basis at all.
            costUsd: 100 * 0.0064,
        }))

        expect(result.overall).toBe('refuted')
        expect(result.metrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ metric: 'discovered', actual: 100, verdict: 'met' }),
            expect.objectContaining({ metric: 'no_owned_website_rate', actual: 0.79, verdict: 'met' }),
            expect.objectContaining({ metric: 'email_rate', actual: 0.11, verdict: 'met' }),
            expect.objectContaining({ metric: 'verified_email_rate', actual: 0.07, verdict: 'not_met' }),
            expect.objectContaining({ metric: 'cost_usd', verdict: 'met' }),
        ]))
    })

    it('Boston (37766ea5): all five metrics met — the larger sample is what held, not the city', () => {
        const result = scoreHypothesis({ ...EXPECTED, verified_email_rate: '>=0.10' }, measured({
            discoveredCount: 330,
            webPresenceCoverage: coverage(99, 231),
            template: 'enriched',
            enrichedCount: 60,
            verifiedOkCount: 45,
            costUsd: 2.0601,
        }))

        expect(result.overall).toBe('confirmed')
        expect(result.metrics.every((m) => m.verdict === 'met')).toBe(true)
        expect(result.metrics).toEqual(expect.arrayContaining([
            expect.objectContaining({ metric: 'discovered', actual: 330 }),
            expect.objectContaining({ metric: 'no_owned_website_rate', actual: 0.7 }),
            expect.objectContaining({ metric: 'email_rate', actual: 60 / 330 }),
            expect.objectContaining({ metric: 'verified_email_rate', actual: 45 / 330 }),
            expect.objectContaining({ metric: 'cost_usd', actual: 2.0601 }),
        ]))
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

describe('verdictFingerprint (Fase 39)', () => {
    it('is identical for two scores with the same overall verdict and per-metric verdicts, even when actual/reason differ', () => {
        const a = scoreHypothesis({ reply_rate: '>=0.03' }, measured({ emailedCount: 10, repliedCount: 1 }))
        const b = scoreHypothesis({ reply_rate: '>=0.03' }, measured({ emailedCount: 20, repliedCount: 2 }))

        expect(a.overall).toBe('confirmed')
        expect(b.overall).toBe('confirmed')
        // The raw actual differs (0.1 vs 0.1 happens to match here by design of the fixture,
        // so assert the reason strings differ instead to prove the fingerprint really does
        // ignore them, not just tolerate an accidental numeric coincidence).
        expect(a.metrics[0].reason).not.toBe(b.metrics[0].reason)
        expect(verdictFingerprint(a)).toBe(verdictFingerprint(b))
    })

    it('differs when the overall verdict differs', () => {
        const confirmed = scoreHypothesis({ reply_rate: '>=0.03' }, measured({ emailedCount: 10, repliedCount: 1 }))
        const refuted = scoreHypothesis({ reply_rate: '>=0.50' }, measured({ emailedCount: 10, repliedCount: 1 }))

        expect(confirmed.overall).toBe('confirmed')
        expect(refuted.overall).toBe('refuted')
        expect(verdictFingerprint(confirmed)).not.toBe(verdictFingerprint(refuted))
    })

    it('differs when a single metric flips verdict even if the overall stays the same category', () => {
        const bothMet = scoreHypothesis(
            { discovered: '>=10', reply_rate: '>=0.03' },
            measured({ discoveredCount: 40, emailedCount: 10, repliedCount: 1 }),
        )
        const oneUnknown = scoreHypothesis(
            { discovered: '>=10', reply_rate: '>=0.03' },
            measured({ discoveredCount: 40, emailedCount: 0, repliedCount: 0 }),
        )

        expect(verdictFingerprint(bothMet)).not.toBe(verdictFingerprint(oneUnknown))
    })
})
