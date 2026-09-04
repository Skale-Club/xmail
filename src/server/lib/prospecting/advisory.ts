/**
 * Prior-run learning advisory for prospecting searches (Phase 32-ish follow-on to the
 * outcome rollup added in migration 051).
 *
 * The problem this solves: `prospecting_runs.outcome*` columns and `prospect_candidates`
 * already record what happened to past searches, but nothing surfaces that history back
 * to the agent at the one moment it matters — when it is about to spend credits on
 * another search. An `/insights` endpoint the agent has to remember to call is easy to
 * skip. Instead, `POST /prospecting/searches` folds this module's output straight into
 * its own response as an additive `advisory` field.
 *
 * `buildAdvisory` is a PURE function (no I/O) so the pool-selection, Wilson-interval, and
 * warning logic can be unit-tested without a database. `loadAdvisory` is the thin
 * fetch-then-delegate wrapper the route actually calls.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { prospectCandidates, prospectingRuns } from '../../../db/schema'
import { extractExpectedMetrics, scoreHypothesis } from './hypothesis-scoring'

// ============================================================
// db parameter typing
// ============================================================

// Same convention as outreach-costs.ts / journey.ts: accept either the module-level `db`
// or an in-flight `tx`, though in practice this module only ever reads.
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type DbClient = typeof db | TransactionClient

// ============================================================
// Public shape
// ============================================================

export type AdvisoryScope = 'similar' | 'organization' | 'none'

export type AdvisoryWarningCode =
    | 'insufficient_data'
    | 'segment_low_email_yield'
    | 'segment_no_replies'
    | 'segment_high_bounce'
    | 'segment_hypothesis_refuted'

export interface AdvisoryWarning {
    code: AdvisoryWarningCode
    /** Always states the sample size the warning was computed over. */
    evidence: string
}

export interface AdvisorySample {
    imported: number
    emailed: number
    replied: number
    bounced: number
    verified_email_rate: number | null
}

export interface AdvisoryReplyRate {
    point: number
    low: number
    high: number
    n: number
}

/**
 * Rollup of how often the pool's PRIOR runs' own stated hypotheses (see hypothesis.ts /
 * hypothesis-scoring.ts) turned out to hold up. Only runs that stated an `expected`
 * (scored via `scoreHypothesis`) count toward `scored_runs` — a run with no hypothesis at
 * all contributes nothing here, the same way it contributes nothing to `warnings`.
 */
export interface AdvisoryHypothesisHistory {
    scored_runs: number
    confirmed: number
    refuted: number
    inconclusive: number
}

export interface Advisory {
    similar_runs: number
    scope: AdvisoryScope
    sample: AdvisorySample
    reply_rate: AdvisoryReplyRate | null
    /** `null` when no prior run in the pool stated a scoreable hypothesis — additive
     *  field, never required. */
    hypothesis_history: AdvisoryHypothesisHistory | null
    warnings: AdvisoryWarning[]
}

/** Fallback returned by the route when advisory computation fails; exported so the route
 *  (and tests) can assert against the exact same shape rather than re-typing it. */
export function emptyAdvisory(): Advisory {
    return {
        similar_runs: 0,
        scope: 'none',
        sample: { imported: 0, emailed: 0, replied: 0, bounced: 0, verified_email_rate: null },
        reply_rate: null,
        hypothesis_history: null,
        warnings: [],
    }
}

/**
 * Already-aggregated stats for one prior run, as consumed by `buildAdvisory`. `loadAdvisory`
 * assembles these from `prospectingRuns` (outcome columns) + a grouped count over
 * `prospectCandidates` (email status) per run.
 */
export interface AdvisoryPriorRun {
    /** The run's own search filters, as stored — used for similarity matching. */
    searchFilters: unknown
    imported: number
    emailed: number
    replied: number
    bounced: number
    /** Total candidates discovered for this run (denominator for verified_email_rate). */
    candidatesObserved: number
    /** Candidates whose emailStatus is 'verified' or 'likely'. */
    candidatesVerifiedOrLikely: number
    /** `prospecting_runs.discovered_count` — feeds the "discovered" hypothesis metric. */
    discoveredCount: number
    /** This run's own stated `hypothesis.expected` (see hypothesis-scoring.ts's
     *  `extractExpectedMetrics`), or `null` when the run never stated one. */
    hypothesisExpected: Record<string, string | number> | null
}

// Loose shape of the `filters` object accepted by POST /prospecting/searches
// (searchFiltersSchema in agent-prospecting.ts). Kept structurally permissive here rather
// than importing the zod schema, since prior runs' persisted `search_filters` jsonb can
// contain whatever shape was valid at write time.
export interface ProspectSearchFiltersLike {
    personTitles?: unknown
    personLocations?: unknown
    organizationLocations?: unknown
    organizationDomains?: unknown
    keywords?: unknown
    [key: string]: unknown
}

// ============================================================
// Similarity
// ============================================================

const MINIMUM_SAMPLE_FOR_PERFORMANCE_WARNINGS = 30
const MINIMUM_CANDIDATES_FOR_YIELD_WARNING = 25
const LOW_EMAIL_YIELD_THRESHOLD = 0.30
const HIGH_BOUNCE_RATE_THRESHOLD = 0.05
const WILSON_Z = 1.96

// Hypothesis-history warning: a single refuted run is not a trend — a stated hypothesis
// is recorded once PER RUN (not per lead), so this floor is deliberately much lower than
// MINIMUM_SAMPLE_FOR_PERFORMANCE_WARNINGS (which counts leads). Below this many SCORED
// runs, refutations are surfaced in `hypothesis_history` for inspection but never promoted
// to a `warnings` entry.
const MINIMUM_SCORED_RUNS_FOR_HYPOTHESIS_WARNING = 3

function normalizeToken(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase()
    return normalized.length > 0 ? normalized : null
}

function addNormalizedTokens(target: Set<string>, values: unknown): void {
    if (!Array.isArray(values)) return
    for (const value of values) {
        const token = normalizeToken(value)
        if (token) target.add(token)
    }
}

/**
 * Extracts a bag of normalized tokens spanning the industry/title/location dimensions of
 * a search-filters object: person titles (title), person + organization locations
 * (location), and organization domains + comma/semicolon-split keywords (industry — the
 * closest proxy available on `searchFilters`, which has no dedicated industry field; see
 * `scoringCriteria.targetIndustries` for the field that does exist, which is deliberately
 * NOT used here since similarity is defined over `searchFilters`, not scoring criteria).
 */
function tokensForFilters(filters: unknown): Set<string> {
    const tokens = new Set<string>()
    if (!filters || typeof filters !== 'object') return tokens
    const f = filters as ProspectSearchFiltersLike

    // Title dimension.
    addNormalizedTokens(tokens, f.personTitles)

    // Location dimension.
    addNormalizedTokens(tokens, f.personLocations)
    addNormalizedTokens(tokens, f.organizationLocations)

    // Industry dimension (proxy fields).
    addNormalizedTokens(tokens, f.organizationDomains)
    if (typeof f.keywords === 'string') {
        for (const part of f.keywords.split(/[,;]+/)) {
            const token = normalizeToken(part)
            if (token) tokens.add(token)
        }
    }

    return tokens
}

function shareAnyToken(a: Set<string>, b: Set<string>): boolean {
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
    for (const token of smaller) {
        if (larger.has(token)) return true
    }
    return false
}

// ============================================================
// Wilson score interval
// ============================================================

/**
 * Wilson score interval for a binomial proportion (z = 1.96, i.e. ~95% confidence).
 * Returns null when n = 0 — there is nothing to estimate.
 */
export function wilsonScoreInterval(successes: number, n: number, z: number = WILSON_Z): AdvisoryReplyRate | null {
    if (n <= 0) return null
    const p = successes / n
    const zSquared = z * z
    const denom = 1 + zSquared / n
    const center = (p + zSquared / (2 * n)) / denom
    const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))
    const low = Math.max(0, center - margin)
    const high = Math.min(1, center + margin)
    return { point: p, low, high, n }
}

// ============================================================
// Pool aggregation + warnings
// ============================================================

function sumBy(rows: AdvisoryPriorRun[], pick: (row: AdvisoryPriorRun) => number): number {
    return rows.reduce((total, row) => total + pick(row), 0)
}

function buildWarnings(pool: {
    emailed: number
    replied: number
    bounced: number
    candidatesObserved: number
    verifiedEmailRate: number | null
}): AdvisoryWarning[] {
    const { emailed, replied, bounced, candidatesObserved, verifiedEmailRate } = pool

    // 'insufficient_data' is emitted INSTEAD OF any performance warning, never alongside
    // one: with too small a sample, a confident performance warning would be superstition
    // the system then repeats forever.
    if (emailed < MINIMUM_SAMPLE_FOR_PERFORMANCE_WARNINGS) {
        return [{
            code: 'insufficient_data',
            evidence: `Only ${emailed} prior lead${emailed === 1 ? '' : 's'} emailed (n=${emailed}); at least ${MINIMUM_SAMPLE_FOR_PERFORMANCE_WARNINGS} are needed before reply-rate signal is meaningful.`,
        }]
    }

    const warnings: AdvisoryWarning[] = []

    if (verifiedEmailRate !== null && verifiedEmailRate < LOW_EMAIL_YIELD_THRESHOLD && candidatesObserved >= MINIMUM_CANDIDATES_FOR_YIELD_WARNING) {
        warnings.push({
            code: 'segment_low_email_yield',
            evidence: `Verified/likely email rate was ${(verifiedEmailRate * 100).toFixed(1)}% across ${candidatesObserved} observed candidates (n=${candidatesObserved}).`,
        })
    }

    if (replied === 0) {
        warnings.push({
            code: 'segment_no_replies',
            evidence: `0 replies out of ${emailed} emailed (n=${emailed}).`,
        })
    }

    if (bounced / emailed > HIGH_BOUNCE_RATE_THRESHOLD) {
        warnings.push({
            code: 'segment_high_bounce',
            evidence: `${bounced} of ${emailed} emailed bounced (${((bounced / emailed) * 100).toFixed(1)}%, n=${emailed}).`,
        })
    }

    return warnings
}

/**
 * Scores each pool run's OWN stated hypothesis (if any) against that run's own final
 * counters, and rolls the verdicts up into a summary. Returns `null` when no run in the
 * pool ever stated a scoreable `expected` — the same "nothing to say" signal
 * `hypothesis_history: null` carries on `Advisory`.
 *
 * This intentionally scores each run against ITS OWN measured values (not the pool's
 * combined sample) — a hypothesis is a claim about that one run's segment, and averaging
 * it into the pool sum would blur which run(s) actually confirmed or refuted it.
 */
function summarizeHypothesisHistory(pool: AdvisoryPriorRun[]): AdvisoryHypothesisHistory | null {
    let confirmed = 0
    let refuted = 0
    let inconclusive = 0

    for (const run of pool) {
        if (!run.hypothesisExpected) continue

        const score = scoreHypothesis(run.hypothesisExpected, {
            discoveredCount: run.discoveredCount,
            emailedCount: run.emailed,
            repliedCount: run.replied,
            attributedLeadCount: run.candidatesObserved,
            verifiedOrLikelyLeadCount: run.candidatesVerifiedOrLikely,
        })

        if (score.overall === 'confirmed') confirmed++
        else if (score.overall === 'refuted') refuted++
        else inconclusive++
    }

    const scoredRuns = confirmed + refuted + inconclusive
    if (scoredRuns === 0) return null

    return { scored_runs: scoredRuns, confirmed, refuted, inconclusive }
}

/**
 * Pure core: given already-fetched prior-run stats and the filters for the run about to
 * be issued, decides which pool of history to learn from and summarizes it.
 *
 * Pool selection: prefer prior runs "similar" to `currentFilters` (sharing at least one
 * normalized industry/title/location token); if none are similar, fall back to ALL prior
 * runs for the organization (scope='organization'); if there are no prior runs at all,
 * scope='none' with empty warnings and a zeroed sample.
 */
export function buildAdvisory(priorRuns: AdvisoryPriorRun[], currentFilters: unknown): Advisory {
    if (priorRuns.length === 0) return emptyAdvisory()

    const currentTokens = tokensForFilters(currentFilters)
    const similarRuns = priorRuns.filter((run) => shareAnyToken(tokensForFilters(run.searchFilters), currentTokens))

    const scope: AdvisoryScope = similarRuns.length > 0 ? 'similar' : 'organization'
    const pool = similarRuns.length > 0 ? similarRuns : priorRuns

    const imported = sumBy(pool, (row) => row.imported)
    const emailed = sumBy(pool, (row) => row.emailed)
    const replied = sumBy(pool, (row) => row.replied)
    const bounced = sumBy(pool, (row) => row.bounced)
    const candidatesObserved = sumBy(pool, (row) => row.candidatesObserved)
    const candidatesVerifiedOrLikely = sumBy(pool, (row) => row.candidatesVerifiedOrLikely)
    const verifiedEmailRate = candidatesObserved > 0 ? candidatesVerifiedOrLikely / candidatesObserved : null

    const warnings = buildWarnings({ emailed, replied, bounced, candidatesObserved, verifiedEmailRate })

    const hypothesisHistory = summarizeHypothesisHistory(pool)
    // A single refuted run is not a trend: below MINIMUM_SCORED_RUNS_FOR_HYPOTHESIS_WARNING,
    // the refutation is still visible in `hypothesis_history` for inspection, but it is not
    // promoted to a `warnings` entry that reads as an established pattern.
    if (hypothesisHistory && hypothesisHistory.refuted > 0 && hypothesisHistory.scored_runs >= MINIMUM_SCORED_RUNS_FOR_HYPOTHESIS_WARNING) {
        warnings.push({
            code: 'segment_hypothesis_refuted',
            evidence: `${hypothesisHistory.refuted} of ${hypothesisHistory.scored_runs} prior run(s) with a stated hypothesis in this segment refuted it (n=${hypothesisHistory.scored_runs}).`,
        })
    }

    return {
        similar_runs: similarRuns.length,
        scope,
        sample: { imported, emailed, replied, bounced, verified_email_rate: verifiedEmailRate },
        reply_rate: wilsonScoreInterval(replied, emailed),
        hypothesis_history: hypothesisHistory,
        warnings,
    }
}

// ============================================================
// DB-backed wrapper
// ============================================================

export interface LoadAdvisoryInput {
    organizationId: string
    searchFilters: unknown
    /** Excludes this run (the one just created) from the prior-runs pool. */
    excludeRunId?: string
}

/**
 * Thin fetch-then-delegate wrapper: pulls every other prior prospecting run for the
 * organization (outcome columns) plus a grouped candidate email-status count per run, and
 * hands both to the pure `buildAdvisory`.
 */
export async function loadAdvisory(dbClient: DbClient, input: LoadAdvisoryInput): Promise<Advisory> {
    const runConditions = [eq(prospectingRuns.organizationId, input.organizationId)]
    if (input.excludeRunId) runConditions.push(ne(prospectingRuns.id, input.excludeRunId))

    const runs = await dbClient
        .select({
            id: prospectingRuns.id,
            searchFilters: prospectingRuns.searchFilters,
            importedCount: prospectingRuns.importedCount,
            outcomeEmailed: prospectingRuns.outcomeEmailed,
            outcomeReplied: prospectingRuns.outcomeReplied,
            outcomeBounced: prospectingRuns.outcomeBounced,
            discoveredCount: prospectingRuns.discoveredCount,
            hypothesis: prospectingRuns.hypothesis,
        })
        .from(prospectingRuns)
        .where(and(...runConditions))

    if (runs.length === 0) return buildAdvisory([], input.searchFilters)

    const runIds = runs.map((run) => run.id)
    const candidateCounts = await dbClient
        .select({
            runId: prospectCandidates.runId,
            total: sql<number>`count(*)::int`,
            verifiedOrLikely: sql<number>`count(*) filter (where ${prospectCandidates.emailStatus} in ('verified', 'likely'))::int`,
        })
        .from(prospectCandidates)
        .where(and(
            eq(prospectCandidates.organizationId, input.organizationId),
            inArray(prospectCandidates.runId, runIds),
        ))
        .groupBy(prospectCandidates.runId)

    const countsByRunId = new Map(candidateCounts.map((row) => [row.runId, row]))

    const priorRuns: AdvisoryPriorRun[] = runs.map((run) => {
        const counts = countsByRunId.get(run.id)
        return {
            searchFilters: run.searchFilters,
            imported: run.importedCount,
            emailed: run.outcomeEmailed,
            replied: run.outcomeReplied,
            bounced: run.outcomeBounced,
            candidatesObserved: counts?.total ?? 0,
            candidatesVerifiedOrLikely: counts?.verifiedOrLikely ?? 0,
            discoveredCount: run.discoveredCount,
            hypothesisExpected: extractExpectedMetrics(run.hypothesis),
        }
    })

    return buildAdvisory(priorRuns, input.searchFilters)
}
