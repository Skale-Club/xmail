/**
 * Scores a stated pre-run hypothesis (`prospecting_runs.hypothesis.expected`, see
 * `hypothesis.ts`) against a run's later-measured outcomes.
 *
 * WHY THIS EXISTS: `hypothesis.ts` lets an agent record what it expects a run to prove
 * BEFORE the scrape/search runs, but nothing ever closed the loop by comparing that
 * prediction to what actually happened — a hypothesis nobody scores is hindsight bias
 * with extra steps. This module is the pure, DB-free comparator: `measureProspectingOutcomes.ts`
 * feeds it a run's measured counters to decide whether to emit a journey event, and
 * `advisory.ts` feeds it prior runs' final counters to summarize how often a segment's
 * stated premise has actually held up.
 *
 * GRAMMAR: `expected` values are comparator STRINGS written by an LLM, so parsing is
 * defensive by construction. Supported forms (whitespace-tolerant, optional trailing
 * `%` meaning "divide by 100"): `>=N`, `>N`, `<=N`, `<N`, `==N`/`=N`, and a bare number
 * (treated as `>=N`, since a bare number reads as a target/floor, not an exact match).
 * Anything else — an empty string, a range, a word, `NaN` — fails to parse and the
 * metric's verdict is `unknown`. **`unknown` is never silently upgraded to `met` or
 * downgraded to `not_met`** — a malformed expectation must not be scored as satisfied
 * OR refuted; it simply carries no signal.
 *
 * SUPPORTED METRICS map to exactly what `measureProspectingOutcomes.ts` computes:
 *   - `discovered`           -> `discoveredCount` (the run's own, already-persisted counter)
 *   - `reply_rate`           -> repliedCount / emailedCount
 *   - `verified_email_rate`  -> the share of the run's attributed leads whose
 *                                `leads.email_verification_status` is 'verified' or 'likely'
 * A metric key outside this list is `unknown` — this module never guesses a mapping for
 * a name it doesn't recognize.
 *
 * ZERO DENOMINATORS ARE `unknown`, NOT `refuted`: a reply-rate or verified-email-rate
 * expectation measured against zero emails sent / zero attributed leads has no evidence
 * behind it either way. Scoring that as a failure would teach the system that every
 * not-yet-launched campaign refutes its own premise, which is simply false.
 */

// ============================================================
// Comparator grammar
// ============================================================

export type ComparatorOp = '>=' | '>' | '<=' | '<' | '=='

export interface ParsedComparator {
    op: ComparatorOp
    /** Already normalized — a `%` suffix has been divided down (e.g. "8%" -> 0.08). */
    value: number
}

// Optional leading operator, a signed decimal, optional trailing `%`. Whitespace around
// any of these three pieces is tolerated (the whole string is `.trim()`'d first, and the
// pattern itself allows internal spacing too).
const COMPARATOR_PATTERN = /^(>=|<=|==|=|>|<)?\s*(-?\d+(?:\.\d+)?)\s*(%)?$/

/**
 * Parses one `expected[metric]` value into a comparator. Returns `null` — never throws —
 * for anything that doesn't match the supported grammar, including non-string/non-number
 * input, so callers can treat "unparsable" uniformly as "unknown".
 */
export function parseComparator(raw: unknown): ParsedComparator | null {
    if (typeof raw === 'number') {
        // A bare number written directly in JSON (rather than as a string) — same
        // "treat as >=" rule applies.
        return Number.isFinite(raw) ? { op: '>=', value: raw } : null
    }
    if (typeof raw !== 'string') return null

    const match = COMPARATOR_PATTERN.exec(raw.trim())
    if (!match) return null

    const [, opToken, numberToken, percentToken] = match
    const op: ComparatorOp = !opToken ? '>=' : opToken === '=' ? '==' : (opToken as ComparatorOp)

    let value = Number(numberToken)
    if (!Number.isFinite(value)) return null
    if (percentToken) value = value / 100

    return { op, value }
}

function satisfiesComparator(op: ComparatorOp, actual: number, expected: number): boolean {
    switch (op) {
        case '>=': return actual >= expected
        case '>': return actual > expected
        case '<=': return actual <= expected
        case '<': return actual < expected
        case '==': return actual === expected
    }
}

// ============================================================
// Per-metric scoring
// ============================================================

export type MetricVerdict = 'met' | 'not_met' | 'unknown'

export interface MetricScore {
    /** The key as written in `expected` (e.g. "reply_rate") — echoed back verbatim. */
    metric: string
    /** The raw, unparsed value from `expected[metric]`, so a caller can display exactly
     *  what was asked for even when it failed to parse. */
    expected: string | number
    /** The parsed comparator, or `null` when `expected` could not be parsed at all. */
    comparator: ParsedComparator | null
    /** The measured value this metric resolved to, or `null` when it could not be
     *  computed (unsupported metric, or a zero-denominator rate). */
    actual: number | null
    verdict: MetricVerdict
    /** Human-readable explanation — always states the evidence (counts), so a refutation
     *  reads as "WHICH expectation failed and by how much", not just that one did. */
    reason: string
}

/** Every metric key `measureProspectingOutcomes.ts` can actually compute. */
const SUPPORTED_METRICS = new Set(['discovered', 'reply_rate', 'verified_email_rate'])

export interface HypothesisMeasuredValues {
    /** `prospecting_runs.discovered_count` — always computable, never a rate. */
    discoveredCount: number
    /** Distinct leads attributed to the run with at least one sent outreach email. */
    emailedCount: number
    /** Distinct leads attributed to the run with at least one reply. */
    repliedCount: number
    /** Distinct leads attributed to the run at all (the verified-email-rate denominator). */
    attributedLeadCount: number
    /** Of those, how many have `email_verification_status` 'verified' or 'likely'. */
    verifiedOrLikelyLeadCount: number
}

function scoreMetric(metric: string, rawExpected: string | number, measured: HypothesisMeasuredValues): MetricScore {
    const comparator = parseComparator(rawExpected)

    if (!SUPPORTED_METRICS.has(metric)) {
        return {
            metric,
            expected: rawExpected,
            comparator,
            actual: null,
            verdict: 'unknown',
            reason: `"${metric}" is not a metric the outcome job computes — no mapping guessed`,
        }
    }

    if (!comparator) {
        return {
            metric,
            expected: rawExpected,
            comparator: null,
            actual: null,
            verdict: 'unknown',
            reason: `expectation ${JSON.stringify(rawExpected)} could not be parsed as a comparator`,
        }
    }

    let actual: number
    let evidence: string

    if (metric === 'discovered') {
        actual = measured.discoveredCount
        evidence = `${measured.discoveredCount} discovered`
    } else if (metric === 'reply_rate') {
        if (measured.emailedCount <= 0) {
            return {
                metric,
                expected: rawExpected,
                comparator,
                actual: null,
                verdict: 'unknown',
                reason: '0 leads emailed so far — a zero denominator is evidence of nothing, not a refutation',
            }
        }
        actual = measured.repliedCount / measured.emailedCount
        evidence = `${measured.repliedCount}/${measured.emailedCount} replied`
    } else {
        // metric === 'verified_email_rate'
        if (measured.attributedLeadCount <= 0) {
            return {
                metric,
                expected: rawExpected,
                comparator,
                actual: null,
                verdict: 'unknown',
                reason: '0 attributed leads so far — a zero denominator is evidence of nothing, not a refutation',
            }
        }
        actual = measured.verifiedOrLikelyLeadCount / measured.attributedLeadCount
        evidence = `${measured.verifiedOrLikelyLeadCount}/${measured.attributedLeadCount} verified or likely`
    }

    const met = satisfiesComparator(comparator.op, actual, comparator.value)
    return {
        metric,
        expected: rawExpected,
        comparator,
        actual,
        verdict: met ? 'met' : 'not_met',
        reason: `${evidence} (${actual}) ${met ? 'satisfies' : 'does not satisfy'} ${comparator.op}${comparator.value}`,
    }
}

// ============================================================
// Overall verdict
// ============================================================

export type HypothesisOverallVerdict = 'confirmed' | 'refuted' | 'inconclusive'

export interface HypothesisScore {
    overall: HypothesisOverallVerdict
    metrics: MetricScore[]
}

/**
 * Scores every key in `expected` against `measured`.
 *
 * Overall verdict:
 *   - `refuted`      — at least one expectation is definitively NOT met. Takes priority
 *                       over `confirmed`: one broken promise refutes the hypothesis even
 *                       if other parts of it held up.
 *   - `confirmed`     — every computable expectation is met AND at least one expectation
 *                       was computable (an empty or all-unknown `expected` can never
 *                       "confirm" anything — there must be at least one real signal).
 *   - `inconclusive`  — nothing could be computed (no `expected` keys at all, or every
 *                       key was unsupported/unparsable/zero-denominator).
 */
export function scoreHypothesis(
    expected: Record<string, string | number> | null | undefined,
    measured: HypothesisMeasuredValues,
): HypothesisScore {
    const metrics = expected
        ? Object.entries(expected).map(([metric, rawExpected]) => scoreMetric(metric, rawExpected, measured))
        : []

    const hasNotMet = metrics.some((m) => m.verdict === 'not_met')
    const hasMet = metrics.some((m) => m.verdict === 'met')
    const hasUnknown = metrics.some((m) => m.verdict === 'unknown')

    // `confirmed` requires that NOTHING was left unmeasured. A single unknown downgrades the
    // whole verdict to `inconclusive`, even when every metric we could compute passed.
    //
    // The worked example is the real Cape Cod run: 50 businesses discovered, zero emails ever
    // sent. `discovered: >=30` is met, while `reply_rate` and `verified_email_rate` are both
    // `unknown` because their denominator is zero. Under a "confirmed if anything passed" rule
    // that run emits `outcome.hypothesis_confirmed` -- and since the event CODE is what gets
    // aggregated (`GROUP BY code`, see docs/prospecting-journey.md), a later tally of confirmed
    // hypotheses would be counting runs that never tested their own premise. The trivial half of
    // a prediction passing is not the prediction holding up.
    //
    // `refuted` still outranks everything: one broken promise refutes the hypothesis however
    // much else was unmeasurable.
    const overall: HypothesisOverallVerdict = hasNotMet
        ? 'refuted'
        : (hasMet && !hasUnknown) ? 'confirmed' : 'inconclusive'

    return { overall, metrics }
}

// ============================================================
// Extraction helper (shared by measureProspectingOutcomes.ts and advisory.ts)
// ============================================================

/**
 * Pulls the `expected` sub-object out of a run's persisted `hypothesis` jsonb blob,
 * keeping only string/number leaves (matching what `hypothesisSchema` accepts) and
 * dropping anything else defensively. Returns `null` when there is no usable `expected`
 * at all (no hypothesis stated, or an `expected` with zero valid keys) so callers have a
 * single, uniform "nothing to score" signal.
 */
export function extractExpectedMetrics(hypothesis: unknown): Record<string, string | number> | null {
    if (!hypothesis || typeof hypothesis !== 'object') return null
    const expected = (hypothesis as Record<string, unknown>).expected
    if (!expected || typeof expected !== 'object') return null

    const result: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
        if (typeof value === 'string' || typeof value === 'number') result[key] = value
    }
    return Object.keys(result).length > 0 ? result : null
}
