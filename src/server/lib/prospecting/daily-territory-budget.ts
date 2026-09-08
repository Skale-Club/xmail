/**
 * Fase 36 — pure decision logic for the daily territory-queue engine.
 *
 * WHY THIS EXISTS (evidence, docs/prospecting-engine-plan.md "Fase 36"): on 2026-09-08 three
 * scrapes were run by hand. The city was picked from memory, the daily ceiling ("about two
 * dollars") lived only in a conversation, and `maxResults` for each run was sized off the
 * PREVIOUS run's unit cost rather than a distribution — the exact anchoring mistake Fase 35's
 * baseline-hypothesis.ts already documents for the reply-rate hypothesis. Nothing stopped the
 * same city from being scraped twice. This module is the deterministic replacement for that
 * by-hand judgment call, kept PURE and DB-free (same split as
 * baseline-hypothesis.ts/baseline-hypothesis-query.ts and outreach-silence.ts/
 * outreach-silence-query.ts) so the decision is unit-testable without a database or an HTTP
 * mock — `runDailyProspecting.ts` is the thin IO half that fetches today's spend, the
 * highest-priority queued territory and the last 5 completed runs' unit costs, then hands them
 * here.
 *
 * ORDER OF CHECKS MATTERS and mirrors the plan's own numbered steps:
 *   1. budget first — a spent-out day never even looks at the queue (distinct log/reason from
 *      "queue empty": the two need different human action — top up the budget vs. add
 *      territories).
 *   2. queue empty — no queued territory for this organization.
 *   3. size the run from the remaining budget and the segment's OWN measured unit-cost
 *      history (median of the last 5 completed runs), falling back to the territory's own
 *      `max_results` cap with no history (never a guess).
 *   4. a computed run too small to be worth firing (`floorResults`) is skipped, not fired
 *      anyway — a 3-result run against a $2 budget is not useful evidence.
 */

/** Matches CLAUDE.md / .env.example's documented default for `PROSPECTING_DAILY_BUDGET_USD`. */
export const DEFAULT_DAILY_BUDGET_USD = 2.0

/** Below this many results a run is not worth firing — see the module doc comment, point 4. */
export const DEFAULT_MIN_RESULTS_FLOOR = 10

export interface DailyProspectingBudgetInput {
    /** Today's REAL spend (category='lead_source', occurred_at >= start of today UTC), read
     *  from the ledger by the IO half — never estimated. See runDailyProspecting.ts. */
    spentTodayUsd: number
    /** `PROSPECTING_DAILY_BUDGET_USD`, resolved by the caller (default `DEFAULT_DAILY_BUDGET_USD`). */
    dailyBudgetUsd: number
    /** The highest-priority `queued` territory for this organization, or null when the queue
     *  is empty. Only `maxResults` is needed here — the rest of the row is IO-side bookkeeping. */
    territory: { maxResults: number } | null
    /** Cost-per-result (USD) of up to the last 5 COMPLETED runs of this organization's
     *  (provider, template) segment, in any order — median is order-independent. Non-finite or
     *  non-positive values are dropped before the median is taken (a run with a recorded cost
     *  of 0 or an un-parseable value must never silently zero out the whole median). */
    recentUnitCostsUsd: number[]
    /** Override for `DEFAULT_MIN_RESULTS_FLOOR`, exposed for tests. */
    floorResults?: number
}

export type DailyProspectingDecision =
    | { action: 'skip'; reason: 'budget_exhausted'; spentTodayUsd: number; dailyBudgetUsd: number }
    | { action: 'skip'; reason: 'queue_empty' }
    | {
        action: 'skip'
        reason: 'below_floor'
        computedMaxResults: number
        floorResults: number
        remainingBudgetUsd: number
        medianUnitCostUsd: number | null
        usedFallback: boolean
    }
    | {
        action: 'run'
        maxResults: number
        remainingBudgetUsd: number
        /** null only when `usedFallback` is true — there was no history to take a median of. */
        medianUnitCostUsd: number | null
        /** True when there was no completed-run cost history for this segment, so `maxResults`
         *  fell back to the territory's own cap unchanged rather than being sized from a budget
         *  that has nothing measured to divide by. */
        usedFallback: boolean
    }

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Decides whether the daily engine should fire a scrape today, and if so, how large. See the
 * module doc comment for the four-step order this function enforces.
 */
export function decideDailyProspectingRun(input: DailyProspectingBudgetInput): DailyProspectingDecision {
    const floorResults = input.floorResults ?? DEFAULT_MIN_RESULTS_FLOOR

    // Step 1 — budget, before anything else touches the queue.
    if (input.spentTodayUsd >= input.dailyBudgetUsd) {
        return {
            action: 'skip',
            reason: 'budget_exhausted',
            spentTodayUsd: input.spentTodayUsd,
            dailyBudgetUsd: input.dailyBudgetUsd,
        }
    }

    // Step 2 — queue.
    if (!input.territory) {
        return { action: 'skip', reason: 'queue_empty' }
    }

    const remainingBudgetUsd = input.dailyBudgetUsd - input.spentTodayUsd

    // Step 3 — size from measured history, falling back to the territory's own cap.
    const validUnitCosts = input.recentUnitCostsUsd.filter((cost) => Number.isFinite(cost) && cost > 0)
    const usedFallback = validUnitCosts.length === 0
    let medianUnitCostUsd: number | null = null
    let computedMaxResults: number
    if (usedFallback) {
        computedMaxResults = input.territory.maxResults
    } else {
        medianUnitCostUsd = median(validUnitCosts)
        const affordableResults = Math.floor(remainingBudgetUsd / medianUnitCostUsd)
        computedMaxResults = Math.min(input.territory.maxResults, affordableResults)
    }

    // Step 4 — floor.
    if (computedMaxResults < floorResults) {
        return {
            action: 'skip',
            reason: 'below_floor',
            computedMaxResults,
            floorResults,
            remainingBudgetUsd,
            medianUnitCostUsd,
            usedFallback,
        }
    }

    return {
        action: 'run',
        maxResults: computedMaxResults,
        remainingBudgetUsd,
        medianUnitCostUsd,
        usedFallback,
    }
}

export interface XcraperConfig {
    url: string
    key: string
}

/**
 * Fails closed (CLAUDE.md "Fails closed" convention, same shape as service-auth.ts's
 * `resolveServiceAuthConfig`): the engine never scrapes unless BOTH `XCRAPER_SERVICE_URL` and
 * `XCRAPER_SERVICE_KEY` are present and non-empty. Neither variable has a fallback or a
 * production default — a partially-configured environment stays disabled rather than guessing.
 */
export function resolveXcraperConfig(env: Record<string, string | undefined> = process.env): XcraperConfig | null {
    const url = env.XCRAPER_SERVICE_URL?.trim()
    const key = env.XCRAPER_SERVICE_KEY?.trim()
    if (!url || !key) return null
    return { url, key }
}

/**
 * Resolves `PROSPECTING_DAILY_BUDGET_USD`, defaulting to `DEFAULT_DAILY_BUDGET_USD` when unset
 * or unparseable. Deliberately separate from `resolveXcraperConfig`: a missing or malformed
 * budget value is a MISCONFIGURATION worth defaulting through (the engine still fails closed on
 * the URL/key), not a reason to disable the whole engine the way a missing service credential is.
 */
export function resolveDailyBudgetUsd(env: Record<string, string | undefined> = process.env): number {
    const raw = env.PROSPECTING_DAILY_BUDGET_USD?.trim()
    if (!raw) return DEFAULT_DAILY_BUDGET_USD
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD
}
