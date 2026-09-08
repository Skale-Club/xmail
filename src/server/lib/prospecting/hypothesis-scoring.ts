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
 *   - `discovered`              -> `discoveredCount` (the run's own, already-persisted counter)
 *   - `reply_rate`              -> repliedCount / emailedCount
 *   - `verified_email_rate`     -> Phase 34 (migration 064): when the run has an actual measured
 *                                   `verified_ok_count` (POST /external-runs/:id/verification),
 *                                   that count over `discoveredCount` is used directly — it is a
 *                                   real MillionVerifier/NeverBounce measurement, not a proxy.
 *                                   Falls back to the share of the run's attributed leads whose
 *                                   `leads.email_verification_status` is 'verified' or 'likely'
 *                                   when no verification has been recorded yet (verifiedOkCount
 *                                   is null).
 *   - `no_owned_website_rate`   -> Phase 35: `1 - owned_website / total` from the coverage carried
 *                                   in the run's `import.external_run_registered` Journey event
 *                                   (`detail.coverage.byWebPresence`, e.g. `{none, owned_website,
 *                                   booking_platform, social_profile, link_hub, directory_listing}`
 *                                   — `total` is the sum of every key present, not just the named
 *                                   ones, since the vocabulary is Xphere's and free-form). `unknown`
 *                                   when no coverage was ever recorded — an absent breakdown is
 *                                   NOT a 0% ownership rate.
 *   - `booking_platform_share`  -> Phase 35: `booking_platform / total` from the same coverage.
 *   - `email_rate`              -> Phase 35: `enriched_count / discoveredCount`, but ONLY for
 *                                   template `enriched` (read from
 *                                   `prospecting_runs.search_filters->>'template'`). The `standard`
 *                                   template never attempts email extraction at all, so this is
 *                                   `unknown` there, never `0` — a `0` would score the run as
 *                                   having failed something it was never asked to attempt.
 *   - `cost_usd`                -> Phase 35: sum of `amount_micros` (converted to USD) for the
 *                                   run's `lead_source` entries in `outreach_cost_entries`.
 *                                   `unknown` when there are no entries. Unlike every other metric
 *                                   here, this one is naturally "lower is better" — production
 *                                   hypotheses already write it as `cost_usd: "<=2.20"` — but
 *                                   `satisfiesComparator` below is comparator-driven, not
 *                                   direction-driven, so a `<=` expectation is scored correctly
 *                                   with no special-casing: `actual <= expected` either holds or
 *                                   it doesn't, the same as any other operator.
 * A metric key outside this list is `unknown` — this module never guesses a mapping for
 * a name it doesn't recognize.
 *
 * ZERO DENOMINATORS ARE `unknown`, NOT `refuted`: a reply-rate or verified-email-rate
 * expectation measured against zero emails sent / zero attributed leads has no evidence
 * behind it either way. Scoring that as a failure would teach the system that every
 * not-yet-launched campaign refutes its own premise, which is simply false.
 *
 * PHASE 35 EVIDENCE (measured 2026-09-08, three production runs): `no_owned_website_rate`,
 * `email_rate` and `cost_usd` came back `unknown` in every one of three Journey verdicts even
 * though the numbers were already sitting in the database (the import event's coverage, the
 * ledger) — because this module simply didn't know those metrics existed yet. The only real
 * miss once they ARE computed is `verified_email_rate`: Framingham (25 results) expected
 * >=15%, measured 12%; Worcester (100 results) expected >=10%, measured 7%; only Boston (330
 * results) — by far the largest sample — held at 13.6% against a >=10% floor. See
 * `buildBaselineHypothesis` (`baseline-hypothesis.ts`) for what this taught about anchoring
 * expectations on the previous run's number instead of a distribution.
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

/** Every metric key `measureProspectingOutcomes.ts` (and, for the median baseline,
 *  `baseline-hypothesis-query.ts`) can actually compute. Exported so the baseline generator
 *  can iterate "every metric this module knows how to measure" without duplicating the list. */
export const SUPPORTED_METRICS = new Set([
    'discovered',
    'reply_rate',
    'verified_email_rate',
    'no_owned_website_rate',
    'booking_platform_share',
    'email_rate',
    'cost_usd',
])

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
    /**
     * Phase 34 (migration 064): `prospecting_runs.verified_ok_count`, written by POST
     * /external-runs/:externalRunId/verification. `null` means "never measured" (the
     * column has no zero default -- see prospecting.ts/schema.ts comments), which is the
     * signal to fall back to the leads-based `attributedLeadCount`/`verifiedOrLikelyLeadCount`
     * computation instead. NOT the same thing as a measured zero, which is used as-is.
     */
    verifiedOkCount: number | null
    /**
     * Phase 35: raw web-presence coverage counts from the run's `import.external_run_registered`
     * Journey event (`detail.coverage.byWebPresence`) — the producer-defined record verbatim
     * (e.g. `{none, owned_website, booking_platform, social_profile, link_hub,
     * directory_listing}`), NOT a pre-computed rate. `total` for `no_owned_website_rate` and
     * `booking_platform_share` is the sum of every key present, so this module owns the one
     * place that arithmetic happens. `null` when no coverage was ever recorded for the run.
     */
    webPresenceCoverage: Record<string, number> | null
    /**
     * Phase 35: `prospecting_runs.search_filters->>'template'`. Only `'enriched'` runs ever
     * attempt email extraction — `email_rate` reads this to distinguish "never attempted"
     * (`standard`, `unknown`) from "attempted and yielded zero" (`enriched`, a real 0).
     */
    template: string | null
    /**
     * Phase 35: `prospecting_runs.enriched_count` — the `email_rate` numerator. Only meaningful
     * when `template === 'enriched'`; ignored otherwise.
     */
    enrichedCount: number
    /**
     * Phase 35: sum of `amount_micros` (converted to USD) for this run's `lead_source` entries
     * in `outreach_cost_entries`, or `null` when there are no such entries yet. Costs are
     * additive facts, not a rate — an absent entry means "not spent yet", never "spent zero".
     */
    costUsd: number | null
}

/** What one metric resolved to, before a comparator is applied — shared by `scoreMetric`
 *  (which turns it into a verdict) and `baseline-hypothesis.ts` (which only wants the raw
 *  numbers, across several runs, to take a median of). */
export interface MetricMeasurement {
    /** `null` when the metric has no evidence yet (zero denominator, unsupported template, no
     *  coverage/cost recorded). */
    actual: number | null
    /** When `actual` is `null`, this IS the full explanation of why. When `actual` is a number,
     *  this is the evidence fragment (e.g. "7/25 enriched") that `scoreMetric` combines with the
     *  comparator check to build its `reason`. */
    evidence: string
}

function sumCoverage(coverage: Record<string, number> | null | undefined): number {
    if (!coverage) return 0
    let total = 0
    for (const value of Object.values(coverage)) {
        if (Number.isFinite(value)) total += value
    }
    return total
}

/**
 * Resolves one metric to its measured value (or the reason it can't be measured yet),
 * independent of any expectation. `null` return means the metric key itself isn't one this
 * module knows how to compute at all (caller should treat that as `unknown` too).
 */
export function measureMetricValue(metric: string, measured: HypothesisMeasuredValues): MetricMeasurement | null {
    if (!SUPPORTED_METRICS.has(metric)) return null

    if (metric === 'discovered') {
        return { actual: measured.discoveredCount, evidence: `${measured.discoveredCount} discovered` }
    }

    if (metric === 'reply_rate') {
        if (measured.emailedCount <= 0) {
            return { actual: null, evidence: '0 leads emailed so far — a zero denominator is evidence of nothing, not a refutation' }
        }
        return { actual: measured.repliedCount / measured.emailedCount, evidence: `${measured.repliedCount}/${measured.emailedCount} replied` }
    }

    if (metric === 'verified_email_rate') {
        if (measured.verifiedOkCount !== null) {
            // Phase 34: an actual verification measurement exists (POST
            // /external-runs/:id/verification) — use it directly instead of the leads-based
            // proxy below, which only reflects leads that made it through import.
            if (measured.discoveredCount <= 0) {
                return { actual: null, evidence: '0 discovered so far — a zero denominator is evidence of nothing, not a refutation' }
            }
            return {
                actual: measured.verifiedOkCount / measured.discoveredCount,
                evidence: `${measured.verifiedOkCount}/${measured.discoveredCount} verified (measured)`,
            }
        }
        // No verification measured yet — fall back to the share of attributed leads whose
        // email_verification_status is verified/likely.
        if (measured.attributedLeadCount <= 0) {
            return { actual: null, evidence: '0 attributed leads so far — a zero denominator is evidence of nothing, not a refutation' }
        }
        return {
            actual: measured.verifiedOrLikelyLeadCount / measured.attributedLeadCount,
            evidence: `${measured.verifiedOrLikelyLeadCount}/${measured.attributedLeadCount} verified or likely`,
        }
    }

    if (metric === 'no_owned_website_rate') {
        const total = sumCoverage(measured.webPresenceCoverage)
        if (!measured.webPresenceCoverage || total <= 0) {
            return { actual: null, evidence: 'no web-presence coverage recorded for this run yet — an absent breakdown is not a 0% ownership rate' }
        }
        const owned = measured.webPresenceCoverage['owned_website'] ?? 0
        return { actual: 1 - owned / total, evidence: `${total - owned}/${total} without an owned website` }
    }

    if (metric === 'booking_platform_share') {
        const total = sumCoverage(measured.webPresenceCoverage)
        if (!measured.webPresenceCoverage || total <= 0) {
            return { actual: null, evidence: 'no web-presence coverage recorded for this run yet' }
        }
        const booking = measured.webPresenceCoverage['booking_platform'] ?? 0
        return { actual: booking / total, evidence: `${booking}/${total} on a booking platform` }
    }

    if (metric === 'email_rate') {
        // The `standard` template (and any run predating the `template` field) never attempts
        // email extraction at all — see external-run.ts's enrichedCount doc comment. Scoring
        // this as `unknown` rather than `0/discoveredCount` matters: a `0` would fail a run for
        // not doing something it was never asked to do.
        if (measured.template !== 'enriched') {
            return {
                actual: null,
                evidence: `template ${JSON.stringify(measured.template)} never attempts email extraction — email_rate is unknown, not 0`,
            }
        }
        if (measured.discoveredCount <= 0) {
            return { actual: null, evidence: '0 discovered so far — a zero denominator is evidence of nothing, not a refutation' }
        }
        return { actual: measured.enrichedCount / measured.discoveredCount, evidence: `${measured.enrichedCount}/${measured.discoveredCount} enriched` }
    }

    // metric === 'cost_usd'
    if (measured.costUsd === null) {
        return { actual: null, evidence: 'no lead_source cost entries recorded for this run yet' }
    }
    return { actual: measured.costUsd, evidence: `US$ ${measured.costUsd.toFixed(4)} spent on lead sourcing` }
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

    const measurement = measureMetricValue(metric, measured)!
    if (measurement.actual === null) {
        return {
            metric,
            expected: rawExpected,
            comparator,
            actual: null,
            verdict: 'unknown',
            reason: measurement.evidence,
        }
    }

    // Comparator-driven, not direction-driven: `satisfiesComparator` just evaluates whatever
    // operator the expectation string carries. This is what makes `cost_usd: "<=2.20"` — the
    // one "lower is better" metric here — score correctly with no special-casing at all: it is
    // simply `actual <= expected`, the same generic check every other metric already gets.
    const met = satisfiesComparator(comparator.op, measurement.actual, comparator.value)
    return {
        metric,
        expected: rawExpected,
        comparator,
        actual: measurement.actual,
        verdict: met ? 'met' : 'not_met',
        reason: `${measurement.evidence} (${measurement.actual}) ${met ? 'satisfies' : 'does not satisfy'} ${comparator.op}${comparator.value}`,
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
// Verdict fingerprint (Fase 39 -- shared by measureProspectingOutcomes.ts for both the
// existing before/after change-detection and the new deterministic `assess.verdict` event)
// ============================================================

/**
 * A verdict "fingerprint" -- the overall verdict plus each metric's CATEGORICAL verdict,
 * deliberately excluding the raw `actual`/`reason` values. Two scores with the same
 * fingerprint count as the same verdict for idempotency purposes even when the underlying
 * counts ticked up in between: a lead replying for the 40th time must not re-emit a Journey
 * event that already said "confirmed", any more than the 40th `outcome.hypothesis_confirmed`
 * emission should (this is the exact same rule `measureProspectingOutcomes.ts`'s own
 * `hypothesisSignature` already enforced for that event; this function generalizes it so
 * `assess.verdict` -- Fase 39 -- can build its own `idempotency_key` from the identical
 * definition, the same shape `verify.completed` (prospecting.ts) uses a stored
 * `detail.idempotency_key` for).
 */
export function verdictFingerprint(score: HypothesisScore): string {
    return JSON.stringify({
        overall: score.overall,
        metrics: score.metrics.map((m) => ({ metric: m.metric, verdict: m.verdict })),
    })
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
