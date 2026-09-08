/**
 * Fase 35 — generates a run's `hypothesis` (premise/expected/basis) from its segment's own
 * recent history, instead of an agent hand-writing one from memory.
 *
 * WHY: on 2026-09-08, three hand-written hypotheses got `verified_email_rate` wrong in two of
 * three tries, and the mistake had a single shape both times — each one anchored on the
 * PREVIOUS run's number rather than on a distribution. Framingham (25 results) expected
 * `>=15%`, measured 12%; Worcester (100 results) expected `>=10%`, measured 7%; only Boston
 * (330 results) — by far the largest sample — held at 13.6% against a `>=10%` floor. The
 * lesson `docs/prospecting-engine-plan.md` records for this phase: sample size, not the city,
 * drove the swing. A median over several completed runs is a steadier anchor than "whatever
 * the last run happened to do".
 *
 * SLACK, AND WHY IT'S RELATIVE AND DIRECTIONAL: the median of a segment's own history is, by
 * definition, a value half of that segment's runs fell short of. Turning the raw median
 * straight into a `>=` floor would make roughly half of all future *typical* runs refute their
 * own hypothesis on arrival — not because anything changed, but because "median" means half
 * the population sits below it. A 20% relative margin in the FORGIVING direction fixes this:
 * a `>=` metric (higher is better — every metric here except `cost_usd`) is floored at
 * `median * 0.8`, so a run merely typical of its segment still confirms; a `<=` metric (lower
 * is better — `cost_usd`) is capped at `median * 1.2` for the same reason in the other
 * direction.
 *
 * PURE AND DB-FREE BY DESIGN — same split `outreach-silence.ts`/`outreach-silence-query.ts`
 * document and use: this module never imports `db`, so the median/slack/rounding rules are
 * unit-testable with plain arrays. `baseline-hypothesis-query.ts` is the thin IO half that
 * fetches the last 5 completed runs of a (provider, template) segment and hands their measured
 * values here.
 */

import { measureMetricValue, SUPPORTED_METRICS, type HypothesisMeasuredValues } from './hypothesis-scoring'
import type { ProspectingHypothesis } from './hypothesis'

/**
 * Metrics scored as "lower is better" — only `cost_usd` today (see hypothesis-scoring.ts's
 * header comment). Every other key in `SUPPORTED_METRICS` is generated as a `>=` floor.
 */
const LOWER_IS_BETTER_METRICS = new Set(['cost_usd'])

/** 20% relative margin — see the module header comment for why it exists and why it's relative
 *  (a fixed absolute margin would be meaningless across metrics ranging from single-digit
 *  counts to sub-cent dollar amounts) rather than absolute. */
const RELATIVE_SLACK = 0.2

/** Fewer than this many prior completed runs and there is no distribution to take a median
 *  of — see `computeBaselineHypothesis`'s "first run" branch. */
const MIN_RUNS_FOR_BASELINE = 3

/** Up to this many of the most recent completed runs feed the median — recent enough that a
 *  segment which has genuinely changed (a new territory, a provider swap) isn't still anchored
 *  on stale history, but enough (once `MIN_RUNS_FOR_BASELINE` is met) for a median to mean
 *  something. Enforced by the IO half's `LIMIT`; kept here too as the contract this module
 *  assumes its caller upholds. */
export const MAX_RUNS_FOR_BASELINE = 5

/** One completed run's measured values, for the baseline generator specifically — the same
 *  shape `measureMetricValue` already consumes, plus a human-readable label (the run's
 *  external run id / idempotency key, NOT its internal uuid) for `basis`. */
export interface BaselineRunSample extends HypothesisMeasuredValues {
    label: string
}

export interface BaselineHypothesisResult {
    premise: string
    expected: Record<string, string>
    basis: string
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Sensible rounding per metric shape: whole units for a count, cents for a dollar amount,
 * tenths-of-a-percent (3 decimals) for a 0..1 rate — precise enough to be a meaningful floor,
 * not falsely precise the way an unrounded median (e.g. `0.28571428571428575`) would be.
 */
function roundForMetric(metric: string, value: number): number {
    if (metric === 'discovered') return Math.round(value)
    if (metric === 'cost_usd') return Math.round(value * 100) / 100
    return Math.round(value * 1000) / 1000
}

/**
 * Median-of-history + forgiving-slack generator. Pure: takes already-measured samples (see
 * `baseline-hypothesis-query.ts` for how those are fetched) and a label for the segment they
 * came from, and returns a hypothesis shaped exactly like a human-written one
 * (`hypothesis.ts`'s `hypothesisSchema`).
 *
 * Fewer than `MIN_RUNS_FOR_BASELINE` samples: refuses to invent numbers from a near-empty
 * distribution. A "median of 2 runs" is really just "one of two arbitrary numbers", which is
 * not meaningfully different from the anchoring-on-the-previous-run mistake this module exists
 * to fix.
 *
 * Per metric: skips it entirely (never guesses) when NONE of the samples could measure it —
 * e.g. a segment with zero verification events yet contributes no `verified_email_rate`.
 */
export function computeBaselineHypothesis(
    samples: BaselineRunSample[],
    context: { provider: string; template: string },
): BaselineHypothesisResult {
    if (samples.length < MIN_RUNS_FOR_BASELINE) {
        return {
            premise: `first run in this segment (${context.provider}/${context.template}) for this organization`,
            expected: {},
            basis: 'first run in this segment; no baseline yet',
        }
    }

    const expected: Record<string, string> = {}
    const basisLines: string[] = []

    for (const metric of SUPPORTED_METRICS) {
        const values: number[] = []
        for (const sample of samples) {
            const measurement = measureMetricValue(metric, sample)
            if (measurement && measurement.actual !== null) values.push(measurement.actual)
        }
        // Zero evidence across every sample -- never invent a number for a metric this
        // segment's history has never actually measured (e.g. no run in it has been verified
        // yet, so verified_email_rate has nothing to take a median of).
        if (values.length === 0) continue

        const med = median(values)
        const lowerIsBetter = LOWER_IS_BETTER_METRICS.has(metric)
        const slacked = lowerIsBetter ? med * (1 + RELATIVE_SLACK) : med * (1 - RELATIVE_SLACK)
        const roundedFloor = roundForMetric(metric, slacked)

        expected[metric] = `${lowerIsBetter ? '<=' : '>='}${roundedFloor}`
        basisLines.push(`${metric}=${roundForMetric(metric, med)} (n=${values.length})`)
    }

    const runLabels = samples.map((sample) => sample.label).join(', ')
    const basis = `median of ${samples.length} completed ${context.provider}/${context.template} runs `
        + `(${runLabels}): ${basisLines.join(', ')} — expected values are the median with `
        + `${Math.round(RELATIVE_SLACK * 100)}% forgiving slack in the direction that keeps a typical run passing`

    return {
        premise: `based on the last ${samples.length} completed ${context.provider}/${context.template} runs for this organization`,
        expected,
        basis,
    }
}

/**
 * A hypothesis a human actually wrote always wins over the generated baseline — it can encode
 * domain judgment a median cannot ("this vertical skews mobile-only, expect low owned-website
 * coverage this run specifically"). The generated baseline exists ONLY to fill the gap when
 * nobody stated one, never to override one that was.
 */
export function resolveHypothesis(
    human: ProspectingHypothesis | undefined,
    generated: BaselineHypothesisResult,
): ProspectingHypothesis | BaselineHypothesisResult {
    return human ?? generated
}
