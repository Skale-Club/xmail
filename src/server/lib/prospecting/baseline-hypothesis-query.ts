/**
 * IO half of Fase 35's baseline hypothesis generator. Separated from `baseline-hypothesis.ts`
 * on purpose — that module never imports `db`, so the median/slack/rounding rules stay
 * testable with plain arrays. Same split `outreach-silence-query.ts`'s header comment
 * documents for `outreach-silence.ts`.
 */

import { queryClient } from '../../../db'
import type { ProspectProviderName } from '../../../db/schema'
import { computeBaselineHypothesis, MAX_RUNS_FOR_BASELINE, type BaselineHypothesisResult, type BaselineRunSample } from './baseline-hypothesis'

interface CompletedRunRow {
    id: string
    idempotencyKey: string
    discoveredCount: number
    outcomeEmailed: number
    outcomeReplied: number
    verifiedOkCount: number | null
    enrichedCount: number
    template: string | null
}

interface CoverageRow {
    runId: string
    coverage: Record<string, number> | null
}

interface CostRow {
    runId: string
    amountMicros: string | number
}

/**
 * Builds a Fase 35 baseline hypothesis for a new run about to start in this
 * (organization, provider, template) segment, from the last `MAX_RUNS_FOR_BASELINE` completed
 * runs of that same segment.
 *
 * "Completed" here means `completed_at IS NOT NULL` — there is no `'completed'` value in
 * `prospecting_runs.status` (the terminal, successful status in this pipeline is `'imported'`,
 * see `measureProspectingOutcomes.ts`), so `completed_at` is the actual "this run is done and
 * safe to learn from" signal `POST /external-runs` already sets at creation.
 *
 * Deliberate simplification versus `measureProspectingOutcomes.ts`'s authoritative per-run
 * attribution: `verified_email_rate` here only ever uses the Phase 34 measured
 * `verified_ok_count` path, never the candidate/lead attribution-join fallback. Redoing that
 * join for a rolling median (a summary statistic, not the scorer of record for any individual
 * run) would duplicate a fair amount of `measureProspectingOutcomes.ts` for a value this
 * function only needs approximately. A completed run with no verification recorded yet simply
 * contributes no value to this metric's median rather than guessing from an un-attributed
 * lead count.
 */
export async function buildBaselineHypothesis(
    organizationId: string,
    provider: ProspectProviderName,
    template: string,
): Promise<BaselineHypothesisResult> {
    const rows = await queryClient<CompletedRunRow[]>`
        SELECT
            id::text AS "id",
            idempotency_key AS "idempotencyKey",
            discovered_count AS "discoveredCount",
            outcome_emailed AS "outcomeEmailed",
            outcome_replied AS "outcomeReplied",
            verified_ok_count AS "verifiedOkCount",
            enriched_count AS "enrichedCount",
            search_filters ->> 'template' AS "template"
        FROM prospecting_runs
        WHERE organization_id = ${organizationId}
          AND provider = ${provider}
          AND search_filters ->> 'template' = ${template}
          AND completed_at IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT ${MAX_RUNS_FOR_BASELINE}
    `

    if (rows.length === 0) {
        return computeBaselineHypothesis([], { provider, template })
    }

    const runIds = rows.map((row) => row.id)

    // One `import.external_run_registered` event per run (written once, at registration) --
    // see external-run.ts / prospecting.ts's POST /external-runs handler.
    const coverageRows = await queryClient<CoverageRow[]>`
        SELECT
            run_id::text AS "runId",
            detail -> 'coverage' -> 'byWebPresence' AS "coverage"
        FROM prospecting_run_events
        WHERE run_id = ANY(${runIds}::uuid[])
          AND code = 'import.external_run_registered'
    `
    const coverageByRun = new Map(coverageRows.map((row) => [row.runId, row.coverage]))

    const costRows = await queryClient<CostRow[]>`
        SELECT run_id::text AS "runId", sum(amount_micros)::bigint AS "amountMicros"
        FROM outreach_cost_entries
        WHERE run_id = ANY(${runIds}::uuid[]) AND category = 'lead_source'
        GROUP BY run_id
    `
    const costUsdByRun = new Map(costRows.map((row) => [row.runId, Number(row.amountMicros) / 1_000_000]))

    const samples: BaselineRunSample[] = rows.map((row) => ({
        label: row.idempotencyKey,
        discoveredCount: row.discoveredCount,
        emailedCount: row.outcomeEmailed,
        repliedCount: row.outcomeReplied,
        // See the module doc comment: deliberately not recomputing the candidate/lead
        // attribution join for a rolling baseline.
        attributedLeadCount: 0,
        verifiedOrLikelyLeadCount: 0,
        verifiedOkCount: row.verifiedOkCount,
        enrichedCount: row.enrichedCount,
        template: row.template,
        webPresenceCoverage: coverageByRun.get(row.id) ?? null,
        costUsd: costUsdByRun.get(row.id) ?? null,
    }))

    return computeBaselineHypothesis(samples, { provider, template })
}
