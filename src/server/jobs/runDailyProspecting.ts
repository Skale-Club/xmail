import { queryClient } from '../../db'
import { runWithLock, JOB_TIMEOUT_BUDGETS_MS } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { sqlTimestampValue } from '../lib/sql-timestamp'
import { buildBaselineHypothesis } from '../lib/prospecting/baseline-hypothesis-query'
import type { BaselineHypothesisResult } from '../lib/prospecting/baseline-hypothesis'
import {
    decideDailyProspectingRun,
    resolveDailyBudgetUsd,
    resolveXcraperConfig,
    type DailyProspectingDecision,
    type XcraperConfig,
} from '../lib/prospecting/daily-territory-budget'
import { decideTerritoryReconciliation } from '../lib/prospecting/territory-reconciliation'

const log = createLogger('outreach.prospecting.daily_run')

/**
 * Fase 36 (docs/prospecting-engine-plan.md "Fase 36 -- Fila de territorios com orcamento
 * diario") — the daily engine that replaces the by-hand scraping done on 2026-09-08 (three
 * runs, city picked from memory, `maxResults` sized off the previous run's unit cost, nothing
 * stopping a repeat scrape of the same city — see the module doc on
 * daily-territory-budget.ts for the full evidence).
 *
 * ONE TICK, PER ORGANIZATION THAT HAS ANY TERRITORY ROW:
 *   1. Reconcile (join, no HTTP): a territory left 'running' from a PRIOR tick is checked for a
 *      matching prospecting_runs row (Xphere's POST /external-runs, keyed by the same searchId
 *      this job wrote as `last_external_run_id`) and flipped to 'done' if found.
 *   1b. Reconcile (poll — 2026-09-12 fix, see territory-reconciliation.ts's module doc for the
 *      full incident): for whatever is STILL 'running' after step 1, this job now polls
 *      Xcraper's `GET /scrape/:id` for each one. THIS POLL IS NOT AN OPTIMIZATION AND MUST NOT
 *      BE REMOVED: Xcraper only pushes a finished scrape to Xphere from inside that same GET
 *      handler (whichever request observes the Apify run finishing first) — there is no
 *      scheduler on Xcraper's side that does this on its own. Before this fix, nothing ever
 *      called that endpoint, so a completed scrape could sit un-pushed indefinitely (measured:
 *      a full day, for the two territories this fix was written to reconcile). A 'completed'
 *      poll result does NOT flip the territory to 'done' here — that still happens via step 1,
 *      once Xphere's asynchronous push creates the matching `prospecting_runs` row, possibly not
 *      until a LATER tick. This step never re-fires a scrape; see decideTerritoryReconciliation's
 *      decision shape, which has no "run"/"retry" action. Bounded by
 *      `XCRAPER_STATUS_FETCH_TIMEOUT_MS` per request and `MAX_TERRITORIES_TO_RECONCILE_PER_TICK`
 *      overall (shared across every organization in the tick) so this step can never consume the
 *      whole job budget — see those constants' own comments for the derivation.
 *   2. Read today's REAL spend (category='lead_source', occurred_at >= start of today UTC)
 *      from outreach_cost_entries. Never estimated.
 *   3. If spend already meets/exceeds the budget, stop — no territory query, no scrape.
 *   4. Otherwise pick the highest-priority (lowest `priority` number) 'queued' territory. None
 *      queued is a DIFFERENT condition from "no budget" (distinct log line — the plan calls
 *      out that the two need different human action: top up the budget vs. add territories).
 *   5. Size the run from the remaining budget and this segment's (organization, xcraper,
 *      template) last 5 completed runs' measured unit cost — see
 *      `decideDailyProspectingRun` in daily-territory-budget.ts for the exact rule, including
 *      the floor below which a run is skipped as not worth firing.
 *   6. Generate the run's hypothesis with Fase 35's `buildBaselineHypothesis` and POST to
 *      Xcraper. On success, the territory becomes 'running' carrying the returned searchId
 *      (as `last_external_run_id` — there is no `prospecting_runs` row for this run yet; see
 *      migration 065's header for why that is a separate column from `last_run_id`).
 *
 * FAILS CLOSED: `resolveXcraperConfig` requires BOTH `XCRAPER_SERVICE_URL` and
 * `XCRAPER_SERVICE_KEY` to be set — with either missing, the whole tick returns immediately,
 * before touching the database at all.
 */

const XCRAPER_FETCH_TIMEOUT_MS = 15_000

/** Per-request timeout for the reconciliation poll's `GET /scrape/:id` status read (step 1b
 *  above). 10s is generous for a single JSON status read — this is NOT the scrape itself, which
 *  runs for minutes on Xcraper's side and this call never waits for (see the module doc). */
export const XCRAPER_STATUS_FETCH_TIMEOUT_MS = 10_000

/**
 * Hard cap, SHARED ACROSS THE WHOLE TICK (every organization, not per-organization), on how many
 * 'running' territories the reconciliation poll (step 1b) will call Xcraper for. Any territory
 * beyond this count is simply left for the next tick — it is a read-only status check with no
 * side effect on Xcraper's side, so deferring it for one tick costs nothing and never risks a
 * duplicate scrape.
 *
 * Sized generously above the currently-known 2 stuck territories (Hudson + Maynard, the incident
 * this fix was written for) rather than left to grow with however many organizations or
 * territories exist later — 10 is a deliberate cap, not a guess at "how many could there be".
 * At `XCRAPER_STATUS_FETCH_TIMEOUT_MS` (10s) per poll, worst case this step costs
 * 10 x 10s = 100s — see `JOB_TIMEOUT_BUDGETS_MS.runDailyProspecting` in cron-lock.ts for how that
 * combines with the rest of the tick's budget.
 */
export const MAX_TERRITORIES_TO_RECONCILE_PER_TICK = 10

interface OrganizationRow {
    organizationId: string
}

interface ReconciledTerritoryRow {
    id: string
    query: string
    location: string
}

interface SpendRow {
    amountMicros: string | number | null
}

interface TerritoryRow {
    id: string
    query: string
    location: string
    template: string
    maxResults: number
}

interface UnitCostRow {
    discoveredCount: number
    amountMicros: string | number
}

interface RunningTerritoryRow {
    id: string
    lastExternalRunId: string
    lastAttemptedAt: string | Date | null
}

export type DailyProspectingOrgSummary =
    | {
        organizationId: string
        reconciled: number
        decision: DailyProspectingDecision
        searchId?: string
        scrapeError?: string
    }
    | {
        organizationId: string
        reconciled: number
        error: string
    }

function startOfTodayUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Step 1 — one-shot reconciliation, not polling. A territory only ever reaches 'running' via
 * `markTerritoryRunning` below, stamped with the Xcraper searchId as `last_external_run_id`.
 * Once Xphere registers that same searchId as a `prospecting_runs.idempotency_key` (provider
 * 'xcraper' — see prospecting.ts's POST /external-runs), this UPDATE...FROM finds the match
 * and flips the territory straight to 'done' in one statement.
 */
async function reconcileTerritories(organizationId: string): Promise<number> {
    const rows = await queryClient<ReconciledTerritoryRow[]>`
        UPDATE prospecting_territories AS t
        SET status = 'done', last_run_id = pr.id, updated_at = now()
        FROM prospecting_runs AS pr
        WHERE t.organization_id = ${organizationId}
          AND t.status = 'running'
          AND t.last_external_run_id IS NOT NULL
          AND pr.organization_id = t.organization_id
          AND pr.provider = 'xcraper'
          AND pr.idempotency_key = t.last_external_run_id
        RETURNING t.id::text AS "id", t.query AS "query", t.location AS "location"
    `
    return rows.length
}

/**
 * Step 1b input — territories still 'running' after the join-based check above, oldest attempt
 * first (the longest-stuck ones are both the most valuable to resolve and the closest to the
 * stall threshold). `limit` is whatever remains of the whole tick's shared
 * `MAX_TERRITORIES_TO_RECONCILE_PER_TICK` budget — see `reconcilePollRunningTerritories`.
 */
async function fetchRunningTerritoriesToPoll(organizationId: string, limit: number): Promise<RunningTerritoryRow[]> {
    if (limit <= 0) return []
    return queryClient<RunningTerritoryRow[]>`
        SELECT
            id::text AS "id",
            last_external_run_id AS "lastExternalRunId",
            last_attempted_at AS "lastAttemptedAt"
        FROM prospecting_territories
        WHERE organization_id = ${organizationId} AND status = 'running' AND last_external_run_id IS NOT NULL
        ORDER BY last_attempted_at ASC
        LIMIT ${limit}
    `
}

type ScrapeStatusPollResult =
    | { ok: true; status: string; xphere?: unknown }
    | { ok: false; error: string }

/**
 * Step 1b — the actual completion mechanism. See this file's module doc and
 * territory-reconciliation.ts's module doc for why this GET is not optional: Xcraper only pushes
 * a finished scrape to Xphere from inside its own `GET /scrape/:id` handler, so this call is what
 * makes that push happen (or confirms it already did, returning "already pushed" harmlessly).
 */
async function pollXcraperScrapeStatus(config: XcraperConfig, searchId: string): Promise<ScrapeStatusPollResult> {
    try {
        const response = await fetch(`${config.url}/scrape/${encodeURIComponent(searchId)}`, {
            method: 'GET',
            headers: { 'X-Service-Key': config.key },
            signal: AbortSignal.timeout(XCRAPER_STATUS_FETCH_TIMEOUT_MS),
        })
        if (!response.ok) {
            const text = await response.text().catch(() => '')
            return { ok: false, error: `xcraper responded ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}` }
        }
        const json = await response.json().catch(() => null) as { status?: string; xphere?: unknown } | null
        if (!json?.status) {
            return { ok: false, error: 'xcraper scrape status response did not include a status' }
        }
        return { ok: true, status: json.status, xphere: json.xphere }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}

/** Applied on a 'failed' reconciliation decision. `paused`, not `failed` — migration 065's
 *  `prospecting_territories_status_check` has no 'failed' value (queued/running/done/paused
 *  only) — with the reason recorded in `notes` so a human sees why it stopped. */
async function markTerritoryFailed(territoryId: string, reason: string): Promise<void> {
    await queryClient`
        UPDATE prospecting_territories
        SET status = 'paused', notes = ${reason}, updated_at = now()
        WHERE id = ${territoryId}
    `
}

interface ReconcilePollSummary {
    polled: number
    completed: number
    failedMarked: number
    stillRunning: number
    stalled: number
    pollErrors: number
}

/**
 * Step 1b orchestration — polls up to `budget.remaining` still-'running' territories for this
 * organization, applies `decideTerritoryReconciliation`'s decision, and decrements the shared
 * cross-organization budget as it goes. Never re-fires a scrape: the decision type this switches
 * on (territory-reconciliation.ts) has no "run"/"retry" action, only completed/failed/
 * still_running/stalled.
 */
async function reconcilePollRunningTerritories(
    organizationId: string,
    config: XcraperConfig,
    now: Date,
    budget: { remaining: number },
): Promise<ReconcilePollSummary> {
    const summary: ReconcilePollSummary = { polled: 0, completed: 0, failedMarked: 0, stillRunning: 0, stalled: 0, pollErrors: 0 }
    if (budget.remaining <= 0) return summary

    const territories = await fetchRunningTerritoriesToPoll(organizationId, budget.remaining)

    for (const territory of territories) {
        if (budget.remaining <= 0) break
        budget.remaining -= 1
        summary.polled += 1

        const pollResult = await pollXcraperScrapeStatus(config, territory.lastExternalRunId)
        if (!pollResult.ok) {
            summary.pollErrors += 1
            log.warn(
                {
                    action: 'prospecting.daily.reconcile_poll_failed',
                    organizationId,
                    territoryId: territory.id,
                    searchId: territory.lastExternalRunId,
                    error: pollResult.error,
                },
                'xcraper scrape status GET failed -- will retry on a later tick',
            )
            continue
        }

        const lastAttemptedAtMs = territory.lastAttemptedAt ? new Date(territory.lastAttemptedAt).getTime() : now.getTime()
        const decision = decideTerritoryReconciliation({
            scrapeStatus: pollResult.status,
            elapsedSinceAttemptMs: Math.max(0, now.getTime() - lastAttemptedAtMs),
        })

        switch (decision.action) {
            case 'completed':
                summary.completed += 1
                log.info(
                    {
                        action: 'prospecting.daily.reconcile_completed',
                        organizationId,
                        territoryId: territory.id,
                        searchId: territory.lastExternalRunId,
                        xphere: pollResult.xphere,
                    },
                    'xcraper reports the scrape completed -- xphere push result logged; territory stays running until its prospecting_runs row appears (see reconcileTerritories)',
                )
                break
            case 'failed':
                summary.failedMarked += 1
                await markTerritoryFailed(territory.id, decision.reason)
                log.error(
                    {
                        action: 'prospecting.daily.reconcile_failed',
                        organizationId,
                        territoryId: territory.id,
                        searchId: territory.lastExternalRunId,
                        reason: decision.reason,
                    },
                    'xcraper reports the scrape failed -- territory paused so it stops blocking the queue',
                )
                break
            case 'stalled':
                summary.stalled += 1
                log.warn(
                    {
                        action: 'prospecting.daily.reconcile_stalled',
                        organizationId,
                        territoryId: territory.id,
                        searchId: territory.lastExternalRunId,
                    },
                    'territory has been running past the stall threshold with no terminal xcraper status -- skipping, NOT re-firing (a paid scrape must never be duplicated)',
                )
                break
            case 'still_running':
            default:
                summary.stillRunning += 1
                log.info(
                    {
                        action: 'prospecting.daily.reconcile_still_running',
                        organizationId,
                        territoryId: territory.id,
                        searchId: territory.lastExternalRunId,
                    },
                    'xcraper scrape still in progress',
                )
                break
        }
    }

    return summary
}

/** Step 2 — read, never estimate. */
async function fetchSpentTodayUsd(organizationId: string, now: Date): Promise<number> {
    const startOfDayIso = sqlTimestampValue(startOfTodayUtc(now))
    const [row] = await queryClient<SpendRow[]>`
        SELECT sum(amount_micros)::bigint AS "amountMicros"
        FROM outreach_cost_entries
        WHERE organization_id = ${organizationId}
          AND category = 'lead_source'
          AND occurred_at >= ${startOfDayIso}
    `
    return Number(row?.amountMicros ?? 0) / 1_000_000
}

/** Step 4 — lower `priority` number runs first; see migration 065. */
async function fetchNextQueuedTerritory(organizationId: string): Promise<TerritoryRow | null> {
    const [row] = await queryClient<TerritoryRow[]>`
        SELECT
            id::text AS "id",
            query AS "query",
            location AS "location",
            template AS "template",
            max_results AS "maxResults"
        FROM prospecting_territories
        WHERE organization_id = ${organizationId} AND status = 'queued'
        ORDER BY priority ASC, created_at ASC
        LIMIT 1
    `
    return row ?? null
}

/**
 * Step 5 input — cost-per-result (USD) of the last 5 COMPLETED runs of this organization's
 * (xcraper, template) segment. Same segment shape `baseline-hypothesis-query.ts` uses for its
 * own median, but this needs cost PER RESULT, not the run's raw total cost, so it is queried
 * separately rather than reusing that module's cost rows.
 */
async function fetchRecentUnitCostsUsd(organizationId: string, template: string): Promise<number[]> {
    const rows = await queryClient<UnitCostRow[]>`
        SELECT
            pr.discovered_count AS "discoveredCount",
            coalesce(sum(oce.amount_micros), 0)::bigint AS "amountMicros"
        FROM prospecting_runs pr
        LEFT JOIN outreach_cost_entries oce ON oce.run_id = pr.id AND oce.category = 'lead_source'
        WHERE pr.organization_id = ${organizationId}
          AND pr.provider = 'xcraper'
          AND pr.search_filters ->> 'template' = ${template}
          AND pr.completed_at IS NOT NULL
          AND pr.discovered_count > 0
        GROUP BY pr.id, pr.discovered_count
        ORDER BY pr.completed_at DESC
        LIMIT 5
    `
    return rows.map((row) => Number(row.amountMicros) / 1_000_000 / row.discoveredCount)
}

async function markTerritoryRunning(territoryId: string, searchId: string): Promise<void> {
    await queryClient`
        UPDATE prospecting_territories
        SET status = 'running', last_external_run_id = ${searchId}, last_attempted_at = now(), updated_at = now()
        WHERE id = ${territoryId}
    `
}

/** A failed POST leaves the territory 'queued' so it is retried on a later tick, but still
 *  records that an attempt happened. */
async function markTerritoryAttemptFailed(territoryId: string): Promise<void> {
    await queryClient`
        UPDATE prospecting_territories
        SET last_attempted_at = now(), updated_at = now()
        WHERE id = ${territoryId}
    `
}

interface ScrapeRequestBody {
    query: string
    location: string
    maxResults: number
    scrapeType: string
    hypothesis: BaselineHypothesisResult
}

type ScrapeCallResult =
    | { ok: true; searchId: string }
    | { ok: false; error: string }

/** Step 6 — the POST itself. Xcraper returns a searchId immediately; the scrape runs on its
 *  side for minutes afterward (measured 3-12min for the three 2026-09-08 runs) — this call
 *  never waits for that. */
async function callXcraperScrape(config: XcraperConfig, body: ScrapeRequestBody): Promise<ScrapeCallResult> {
    try {
        const response = await fetch(`${config.url}/scrape`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': config.key },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(XCRAPER_FETCH_TIMEOUT_MS),
        })
        if (!response.ok) {
            const text = await response.text().catch(() => '')
            return { ok: false, error: `xcraper responded ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}` }
        }
        const json = await response.json().catch(() => null) as { searchId?: string } | null
        if (!json?.searchId) {
            return { ok: false, error: 'xcraper response did not include a searchId' }
        }
        return { ok: true, searchId: json.searchId }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}

async function runForOrganization(
    organizationId: string,
    config: XcraperConfig,
    dailyBudgetUsd: number,
    now: Date,
    reconciliationBudget: { remaining: number },
): Promise<DailyProspectingOrgSummary> {
    const reconciled = await reconcileTerritories(organizationId)
    if (reconciled > 0) {
        log.info({ action: 'prospecting.daily.reconciled', organizationId, reconciled }, 'territory(ies) matched to a registered run')
    }

    // Step 1b — poll whatever is still 'running' after the join-based check above. See this
    // file's module doc for why this poll is the actual completion mechanism, not an
    // optimization. Bounded by the shared `reconciliationBudget` across the whole tick.
    const pollSummary = await reconcilePollRunningTerritories(organizationId, config, now, reconciliationBudget)
    if (pollSummary.polled > 0) {
        log.info(
            { action: 'prospecting.daily.reconcile_poll_summary', organizationId, ...pollSummary },
            'reconciliation poll summary for this organization',
        )
    }

    const spentTodayUsd = await fetchSpentTodayUsd(organizationId, now)

    if (spentTodayUsd >= dailyBudgetUsd) {
        const decision = decideDailyProspectingRun({ spentTodayUsd, dailyBudgetUsd, territory: null, recentUnitCostsUsd: [] })
        log.info(
            { action: 'prospecting.daily.no_budget', organizationId, spentTodayUsd, dailyBudgetUsd },
            'daily prospecting budget already spent -- not scraping today',
        )
        return { organizationId, reconciled, decision }
    }

    const territory = await fetchNextQueuedTerritory(organizationId)
    if (!territory) {
        const decision = decideDailyProspectingRun({ spentTodayUsd, dailyBudgetUsd, territory: null, recentUnitCostsUsd: [] })
        log.info({ action: 'prospecting.daily.queue_empty', organizationId }, 'no queued territory -- add more territories')
        return { organizationId, reconciled, decision }
    }

    const recentUnitCostsUsd = await fetchRecentUnitCostsUsd(organizationId, territory.template)
    const decision = decideDailyProspectingRun({
        spentTodayUsd,
        dailyBudgetUsd,
        territory: { maxResults: territory.maxResults },
        recentUnitCostsUsd,
    })

    if (decision.action === 'skip' && decision.reason === 'below_floor') {
        log.info(
            {
                action: 'prospecting.daily.below_floor',
                organizationId,
                territoryId: territory.id,
                query: territory.query,
                location: territory.location,
                computedMaxResults: decision.computedMaxResults,
                floorResults: decision.floorResults,
            },
            'computed run too small to be worth firing -- skipping',
        )
        return { organizationId, reconciled, decision }
    }

    if (decision.action !== 'run') {
        // Unreachable in practice (territory is non-null and budget already checked above),
        // but keeps the switch exhaustive without a cast.
        return { organizationId, reconciled, decision }
    }

    if (decision.usedFallback) {
        log.info(
            { action: 'prospecting.daily.no_cost_history', organizationId, territoryId: territory.id, template: territory.template },
            'no completed-run cost history for this segment -- falling back to the territory\'s own max_results cap',
        )
    }

    const hypothesis = await buildBaselineHypothesis(organizationId, 'xcraper', territory.template)

    const result = await callXcraperScrape(config, {
        query: territory.query,
        location: territory.location,
        maxResults: decision.maxResults,
        scrapeType: territory.template,
        hypothesis,
    })

    if (!result.ok) {
        await markTerritoryAttemptFailed(territory.id)
        log.error(
            { action: 'prospecting.daily.scrape_failed', organizationId, territoryId: territory.id, query: territory.query, location: territory.location, error: result.error },
            'xcraper scrape POST failed -- territory stays queued for a later tick',
        )
        return { organizationId, reconciled, decision, scrapeError: result.error }
    }

    await markTerritoryRunning(territory.id, result.searchId)
    log.info(
        {
            action: 'prospecting.daily.scrape_started',
            organizationId,
            territoryId: territory.id,
            query: territory.query,
            location: territory.location,
            maxResults: decision.maxResults,
            searchId: result.searchId,
        },
        'daily prospecting scrape started',
    )
    return { organizationId, reconciled, decision, searchId: result.searchId }
}

export async function runDailyProspecting(now: Date = new Date()): Promise<DailyProspectingOrgSummary[]> {
    const config = resolveXcraperConfig()
    if (!config) {
        log.warn(
            { action: 'prospecting.daily.missing_configuration' },
            'XCRAPER_SERVICE_URL/XCRAPER_SERVICE_KEY not configured -- daily prospecting engine stays disabled (fails closed)',
        )
        return []
    }

    const dailyBudgetUsd = resolveDailyBudgetUsd()

    const orgRows = await queryClient<OrganizationRow[]>`
        SELECT DISTINCT organization_id::text AS "organizationId" FROM prospecting_territories
    `

    // Shared across every organization in this tick -- see MAX_TERRITORIES_TO_RECONCILE_PER_TICK's
    // own comment for why this cap is global, not per-organization.
    const reconciliationBudget = { remaining: MAX_TERRITORIES_TO_RECONCILE_PER_TICK }

    const summaries: DailyProspectingOrgSummary[] = []
    for (const { organizationId } of orgRows) {
        try {
            summaries.push(await runForOrganization(organizationId, config, dailyBudgetUsd, now, reconciliationBudget))
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.error({ action: 'prospecting.daily.organization_failed', organizationId, error: message }, 'daily prospecting tick failed for this organization')
            summaries.push({ organizationId, reconciled: 0, error: message })
        }
    }
    return summaries
}

export async function runDailyProspectingWithLock(): Promise<void> {
    // Scheduled once a day (jobs/index.ts) — see JOB_TIMEOUT_BUDGETS_MS.runDailyProspecting's
    // comment in cron-lock.ts for why this is not sized by the usual 5x-measured-latency rule.
    await runWithLock('runDailyProspecting', () => runDailyProspecting(), { timeoutMs: JOB_TIMEOUT_BUDGETS_MS.runDailyProspecting })
}
