import { describe, expect, it } from 'vitest'
import { buildAdvisory, wilsonScoreInterval, type AdvisoryPriorRun } from '../advisory'

function priorRun(overrides: Partial<AdvisoryPriorRun> = {}): AdvisoryPriorRun {
    return {
        searchFilters: {},
        imported: 0,
        emailed: 0,
        replied: 0,
        bounced: 0,
        candidatesObserved: 0,
        candidatesVerifiedOrLikely: 0,
        discoveredCount: 0,
        hypothesisExpected: null,
        ...overrides,
    }
}

describe('wilsonScoreInterval', () => {
    it('returns null when n = 0', () => {
        expect(wilsonScoreInterval(0, 0)).toBeNull()
    })

    it('matches hand-computed values for a mid-size sample (40 replies of 100 emailed)', () => {
        // p = 0.4, z = 1.96, n = 100
        // denom = 1 + 1.96^2/100 = 1.038416
        // center = (0.4 + 1.96^2/200) / denom = (0.4 + 0.019208) / 1.038416 = 0.4036996...
        // margin = (1.96/1.038416) * sqrt(0.4*0.6/100 + 1.96^2/40000) = 0.0942996...
        // low/high verified against an independent computation of the same closed-form
        // expressions given in the task spec.
        const result = wilsonScoreInterval(40, 100)
        expect(result).not.toBeNull()
        expect(result!.point).toBeCloseTo(0.4, 10)
        expect(result!.n).toBe(100)
        expect(result!.low).toBeCloseTo(0.3093997, 6)
        expect(result!.high).toBeCloseTo(0.4979992, 6)
    })

    it('handles the 0-success case (0 replies of 50 emailed) without a negative low bound', () => {
        // p = 0, denom = 1 + 1.96^2/50 = 1.076832
        // center = (0 + 1.96^2/100)/1.076832 = 0.038416/1.076832 = 0.0356847...
        // margin = (1.96/1.076832) * sqrt(0 + 1.96^2/10000) = 0.0356847... (equals center,
        // since p=0 makes center - margin land exactly at 0 before clamping)
        const result = wilsonScoreInterval(0, 50)
        expect(result).not.toBeNull()
        expect(result!.point).toBe(0)
        expect(result!.low).toBe(0) // max(0, center - margin) clamps to 0
        expect(result!.high).toBeCloseTo(0.0713500, 6)
    })

    it('produces a correspondingly wide interval for a small sample (2 replies of 5 emailed)', () => {
        // p = 0.4, n = 5 — small n means a much wider interval than the n=100 case above.
        const small = wilsonScoreInterval(2, 5)
        const large = wilsonScoreInterval(40, 100) // same point estimate, larger n
        expect(small).not.toBeNull()
        expect(large).not.toBeNull()
        expect(small!.point).toBeCloseTo(0.4, 10)
        const smallWidth = small!.high - small!.low
        const largeWidth = large!.high - large!.low
        expect(smallWidth).toBeGreaterThan(largeWidth)
        // Closed-form values for n=5 (verified against an independent computation of the
        // same formulas given in the task spec).
        expect(small!.low).toBeCloseTo(0.1176182, 6)
        expect(small!.high).toBeCloseTo(0.7692801, 6)
    })
})

describe('buildAdvisory: pool selection / scope', () => {
    it('returns scope=none with an empty warnings array when there are no prior runs at all', () => {
        const advisory = buildAdvisory([], { personTitles: ['CTO'] })
        expect(advisory).toEqual({
            similar_runs: 0,
            scope: 'none',
            sample: { imported: 0, emailed: 0, replied: 0, bounced: 0, verified_email_rate: null },
            reply_rate: null,
            hypothesis_history: null,
            warnings: [],
        })
    })

    it('matches similarity on a shared, normalized industry (organizationDomains) token', () => {
        const similar = priorRun({
            searchFilters: { organizationDomains: ['Acme.com'], personTitles: ['VP Sales'] },
            emailed: 40,
            replied: 4,
        })
        const unrelated = priorRun({
            searchFilters: { organizationDomains: ['other-co.io'], personTitles: ['Marketing Manager'] },
            emailed: 40,
            replied: 20,
        })
        const advisory = buildAdvisory([similar, unrelated], { organizationDomains: ['acme.com '] })
        expect(advisory.scope).toBe('similar')
        expect(advisory.similar_runs).toBe(1)
        // Only the similar run's stats should be in the pool.
        expect(advisory.sample.emailed).toBe(40)
        expect(advisory.sample.replied).toBe(4)
    })

    it('matches similarity on a shared, normalized location token (case/whitespace-insensitive)', () => {
        const similar = priorRun({
            searchFilters: { personLocations: ['  Austin, TX  '] },
            emailed: 35,
            replied: 5,
        })
        const advisory = buildAdvisory([similar], { organizationLocations: ['austin, tx'] })
        expect(advisory.scope).toBe('similar')
        expect(advisory.similar_runs).toBe(1)
    })

    it('falls back to scope=organization (pooling ALL prior runs) when nothing is similar', () => {
        const a = priorRun({ searchFilters: { personTitles: ['CTO'] }, emailed: 20, replied: 2 })
        const b = priorRun({ searchFilters: { personLocations: ['Berlin'] }, emailed: 15, replied: 1 })
        const advisory = buildAdvisory([a, b], { personTitles: ['Head of Growth'], personLocations: ['Tokyo'] })
        expect(advisory.scope).toBe('organization')
        expect(advisory.similar_runs).toBe(0)
        // Pool is the sum across ALL prior runs, not just one.
        expect(advisory.sample.emailed).toBe(35)
        expect(advisory.sample.replied).toBe(3)
    })
})

describe('buildAdvisory: sample aggregation', () => {
    it('denominator for reply_rate is emailed, never imported — an unemailed lead is not a non-replier', () => {
        const run = priorRun({
            searchFilters: { personTitles: ['CTO'] },
            imported: 500, // many leads imported...
            emailed: 40, // ...but only 40 actually emailed
            replied: 8,
        })
        const advisory = buildAdvisory([run], { personTitles: ['CTO'] })
        expect(advisory.sample.imported).toBe(500)
        expect(advisory.sample.emailed).toBe(40)
        expect(advisory.reply_rate).not.toBeNull()
        expect(advisory.reply_rate!.n).toBe(40)
        expect(advisory.reply_rate!.point).toBeCloseTo(8 / 40, 10)
    })

    it('computes verified_email_rate as the share of candidates verified or likely, summed across the pool', () => {
        const run = priorRun({
            searchFilters: { personTitles: ['CTO'] },
            emailed: 30,
            replied: 3,
            candidatesObserved: 50,
            candidatesVerifiedOrLikely: 40,
        })
        const advisory = buildAdvisory([run], { personTitles: ['CTO'] })
        expect(advisory.sample.verified_email_rate).toBeCloseTo(0.8, 10)
    })

    it('reports verified_email_rate as null when no candidates were observed', () => {
        const run = priorRun({ searchFilters: {}, emailed: 0, candidatesObserved: 0 })
        const advisory = buildAdvisory([run], {})
        expect(advisory.sample.verified_email_rate).toBeNull()
    })
})

describe('buildAdvisory: warnings', () => {
    it('emits insufficient_data (and nothing else) when emailed < 30, even if other conditions would otherwise fire', () => {
        // This run would otherwise trip segment_no_replies (0 replies) and a high bounce
        // rate, but n=10 emailed is under the 30 floor, so only insufficient_data fires.
        const run = priorRun({
            searchFilters: { personTitles: ['CTO'] },
            emailed: 10,
            replied: 0,
            bounced: 5,
            candidatesObserved: 25,
            candidatesVerifiedOrLikely: 2,
        })
        const advisory = buildAdvisory([run], { personTitles: ['CTO'] })
        expect(advisory.warnings).toHaveLength(1)
        expect(advisory.warnings[0].code).toBe('insufficient_data')
        expect(advisory.warnings[0].evidence).toContain('10')
    })

    it('emits segment_no_replies when emailed >= 30 and replied = 0', () => {
        const run = priorRun({ searchFilters: {}, emailed: 30, replied: 0, bounced: 0 })
        const advisory = buildAdvisory([run], {})
        const codes = advisory.warnings.map((w) => w.code)
        expect(codes).toContain('segment_no_replies')
        expect(codes).not.toContain('insufficient_data')
    })

    it('emits segment_high_bounce when bounced/emailed > 0.05 and emailed >= 30', () => {
        const run = priorRun({ searchFilters: {}, emailed: 40, replied: 4, bounced: 3 }) // 7.5%
        const advisory = buildAdvisory([run], {})
        const codes = advisory.warnings.map((w) => w.code)
        expect(codes).toContain('segment_high_bounce')
    })

    it('does not emit segment_high_bounce at exactly the 5% boundary', () => {
        const run = priorRun({ searchFilters: {}, emailed: 40, replied: 4, bounced: 2 }) // exactly 5%
        const advisory = buildAdvisory([run], {})
        const codes = advisory.warnings.map((w) => w.code)
        expect(codes).not.toContain('segment_high_bounce')
    })

    it('emits segment_low_email_yield when verified_email_rate < 0.30 with >= 25 candidates observed', () => {
        const run = priorRun({
            searchFilters: {},
            emailed: 30,
            replied: 3,
            candidatesObserved: 25,
            candidatesVerifiedOrLikely: 5, // 20%
        })
        const advisory = buildAdvisory([run], {})
        const codes = advisory.warnings.map((w) => w.code)
        expect(codes).toContain('segment_low_email_yield')
    })

    it('does not emit segment_low_email_yield when fewer than 25 candidates were observed', () => {
        const run = priorRun({
            searchFilters: {},
            emailed: 30,
            replied: 3,
            candidatesObserved: 10,
            candidatesVerifiedOrLikely: 1, // 10%, but n too small
        })
        const advisory = buildAdvisory([run], {})
        const codes = advisory.warnings.map((w) => w.code)
        expect(codes).not.toContain('segment_low_email_yield')
    })

    it('can emit multiple performance warnings together once n >= 30', () => {
        const run = priorRun({
            searchFilters: {},
            emailed: 40,
            replied: 0,
            bounced: 4, // 10%
            candidatesObserved: 40,
            candidatesVerifiedOrLikely: 5, // 12.5%
        })
        const advisory = buildAdvisory([run], {})
        const codes = advisory.warnings.map((w) => w.code).sort()
        expect(codes).toEqual(['segment_high_bounce', 'segment_low_email_yield', 'segment_no_replies'])
    })

    it('every emitted warning states its sample size in the evidence string', () => {
        const runs: AdvisoryPriorRun[] = [
            priorRun({ searchFilters: {}, emailed: 5, replied: 0, bounced: 0 }), // insufficient_data, n=5
        ]
        const insufficient = buildAdvisory(runs, {})
        for (const warning of insufficient.warnings) {
            expect(warning.evidence).toMatch(/\d/)
            expect(warning.evidence).toContain(String(insufficient.sample.emailed))
        }

        const performanceRun = priorRun({
            searchFilters: {},
            emailed: 50,
            replied: 0,
            bounced: 10, // 20%
            candidatesObserved: 50,
            candidatesVerifiedOrLikely: 5, // 10%
        })
        const performance = buildAdvisory([performanceRun], {})
        expect(performance.warnings.length).toBeGreaterThan(0)
        for (const warning of performance.warnings) {
            expect(warning.evidence).toMatch(/\d/)
        }
        // Spot-check specific sample sizes appear verbatim.
        const noReplies = performance.warnings.find((w) => w.code === 'segment_no_replies')
        expect(noReplies?.evidence).toContain('50')
        const highBounce = performance.warnings.find((w) => w.code === 'segment_high_bounce')
        expect(highBounce?.evidence).toContain('50')
        const lowYield = performance.warnings.find((w) => w.code === 'segment_low_email_yield')
        expect(lowYield?.evidence).toContain('50')
    })
})

describe('buildAdvisory: hypothesis_history', () => {
    it('is null when no prior run in the pool stated a hypothesis', () => {
        const run = priorRun({ searchFilters: {}, emailed: 40, replied: 4 })
        const advisory = buildAdvisory([run], {})
        expect(advisory.hypothesis_history).toBeNull()
    })

    it('scores each run against its OWN measured values and rolls verdicts up', () => {
        const confirmedRun = priorRun({
            searchFilters: {},
            emailed: 100,
            replied: 10,
            hypothesisExpected: { reply_rate: '>=0.05' },
        })
        const refutedRun = priorRun({
            searchFilters: {},
            emailed: 100,
            replied: 1,
            hypothesisExpected: { reply_rate: '>=0.05' },
        })
        const noHypothesisRun = priorRun({ searchFilters: {}, emailed: 50, replied: 5 })

        const advisory = buildAdvisory([confirmedRun, refutedRun, noHypothesisRun], {})
        expect(advisory.hypothesis_history).toEqual({
            scored_runs: 2,
            confirmed: 1,
            refuted: 1,
            inconclusive: 0,
        })
    })

    it('counts a hypothesis whose expectation could not be computed yet as inconclusive', () => {
        const run = priorRun({
            searchFilters: {},
            emailed: 0,
            replied: 0,
            hypothesisExpected: { reply_rate: '>=0.05' },
        })
        const advisory = buildAdvisory([run], {})
        expect(advisory.hypothesis_history).toEqual({ scored_runs: 1, confirmed: 0, refuted: 0, inconclusive: 1 })
    })

    it('does NOT emit segment_hypothesis_refuted for a single refuted run — one run is not a trend', () => {
        const run = priorRun({
            searchFilters: {},
            emailed: 100,
            replied: 0,
            hypothesisExpected: { reply_rate: '>=0.05' },
        })
        const advisory = buildAdvisory([run], {})
        expect(advisory.hypothesis_history).toMatchObject({ scored_runs: 1, refuted: 1 })
        expect(advisory.warnings.map((w) => w.code)).not.toContain('segment_hypothesis_refuted')
    })

    it('emits segment_hypothesis_refuted once at least 3 scored runs include a refutation', () => {
        const refuted = (n: number) => priorRun({
            searchFilters: {},
            emailed: 100,
            replied: n,
            hypothesisExpected: { reply_rate: '>=0.05' },
        })
        const runs = [refuted(0), refuted(10), refuted(1)] // refuted, confirmed, refuted
        const advisory = buildAdvisory(runs, {})
        expect(advisory.hypothesis_history).toEqual({ scored_runs: 3, confirmed: 1, refuted: 2, inconclusive: 0 })
        const warning = advisory.warnings.find((w) => w.code === 'segment_hypothesis_refuted')
        expect(warning).toBeDefined()
        expect(warning!.evidence).toContain('2')
        expect(warning!.evidence).toContain('3')
    })

    it('surfaces hypothesis_history even when the reply-count sample is below the insufficient_data floor', () => {
        // Below MINIMUM_SAMPLE_FOR_PERFORMANCE_WARNINGS (30 emailed), only insufficient_data
        // is emitted for the lead-count-based warnings — but hypothesis scoring is a
        // per-run signal, not a per-lead one, so it must still be surfaced additively.
        const runs = [
            priorRun({ searchFilters: {}, emailed: 5, replied: 0, hypothesisExpected: { reply_rate: '>=0.05' } }),
            priorRun({ searchFilters: {}, emailed: 5, replied: 0, hypothesisExpected: { reply_rate: '>=0.05' } }),
            priorRun({ searchFilters: {}, emailed: 5, replied: 0, hypothesisExpected: { reply_rate: '>=0.05' } }),
        ]
        const advisory = buildAdvisory(runs, {})
        expect(advisory.warnings.map((w) => w.code)).toContain('insufficient_data')
        expect(advisory.hypothesis_history).toEqual({ scored_runs: 3, confirmed: 0, refuted: 3, inconclusive: 0 })
        expect(advisory.warnings.map((w) => w.code)).toContain('segment_hypothesis_refuted')
    })
})
