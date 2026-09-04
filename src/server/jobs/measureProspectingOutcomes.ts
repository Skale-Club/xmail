import { db, queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { sqlTimestampValue } from '../lib/sql-timestamp'
import { extractExpectedMetrics, scoreHypothesis, type HypothesisScore } from '../lib/prospecting/hypothesis-scoring'
import { recordRunEvents, RUN_EVENT_CODES, type RecordRunEventInput } from '../lib/prospecting/journey'

const log = createLogger('outreach.prospecting.measure_outcomes')

/**
 * Phase 31 follow-up — closes the feedback loop from prospecting run to outreach outcome.
 *
 * RECOMPUTE, DO NOT INCREMENT: every pass reads the current source-of-truth tables and
 * overwrites each run's outcome_* counters with a freshly computed total. It does NOT
 * consume the event outbox and keeps NO cursor. Recomputation is idempotent and
 * self-healing — a missed or replayed event can never corrupt the totals, and there is no
 * cursor position to lose. Prospecting runs are few (one row per prospecting search, not
 * per lead or per email), so the cost of recomputing from scratch on every 6-hourly tick is
 * trivial compared to the correctness gained.
 *
 * TWO ATTRIBUTION PATHS (Phase 32 follow-up): a run's attributable leads are the UNION of
 *   (a) prospect_candidates -> leads -> campaign_leads -> outreach_emails, for candidates
 *       with imported_as = 'created' — the Apollo/agent-prospecting.ts path, which has never
 *       run in production.
 *   (b) leads -> campaign_leads -> outreach_emails, where leads.custom_fields->>'source_run_id'
 *       equals the run's idempotency_key — the real production path: xcraper scrapes leads,
 *       Xphere calls POST /api/outreach/leads/bulk-import (never touching prospect_candidates
 *       at all) stamping custom_fields.source_run_id, and separately calls POST
 *       /external-runs to register the run itself. Without path (b) every real run's
 *       outcome_* counters stay 0 forever and cost-per-reply is cost / 0.
 * A lead reachable via both paths (or via path (a) more than once) is counted exactly ONCE —
 * see aggregateRunOutcomes below, which dedupes per (runId, leadId) regardless of which
 * attribution path produced the row.
 *
 * ATTRIBUTION RULE for path (a) (the crux of the original job): only candidates with
 * imported_as = 'created' are credited to a run. A candidate with imported_as = 'existing'
 * resolved to a lead some EARLIER run already sourced — crediting it here would let two runs
 * claim the same human and inflate both runs' numbers. Candidates with imported_as IS NULL
 * (rows imported before this column existed, migration 051) are ALSO excluded, for the
 * identical reason: we cannot prove those rows were new leads rather than matches against an
 * existing one. Path (b) has an analogous first-touch rule enforced at write time instead of
 * read time: POST /leads/bulk-import (leads.ts) only ever sets custom_fields.source_run_id
 * once per lead and never lets a later re-import overwrite it, so every row this job reads
 * from path (b) is already the first (and only) run that can claim that lead.
 */

// ============================================================
// Raw source rows (one query, joined but NOT aggregated) — kept
// separate from aggregation so the attribution/dedup rules below
// are exercised by pure unit tests without touching a database.
// ============================================================

interface RunOutcomeSourceRow {
    runId: string
    organizationId: string
    // Which attribution path (see the module doc comment above) produced this row. The
    // `imported_as` filter below only applies to the 'candidate' path — the 'custom_field'
    // path has no prospect_candidates row at all, so importedAs is always null for it and is
    // not consulted.
    attributionPath: 'candidate' | 'custom_field'
    importedAs: 'created' | 'existing' | null
    leadId: string | null
    leadStatus: string | null
    // Hypothesis-scoring follow-up: feeds the `verified_email_rate` metric in
    // hypothesis-scoring.ts. Read straight off `leads.email_verification_status` for
    // whichever lead this row resolved to — 'unknown'/'unavailable'/'invalid'/null all
    // count as "not verified or likely" the same way.
    emailVerificationStatus: string | null
    sentAt: string | Date | null
    repliedAt: string | Date | null
    bouncedAt: string | Date | null
    unsubscribedAt: string | Date | null
}

export interface RunOutcomeCounters {
    outcomeEmailed: number
    outcomeReplied: number
    outcomePositiveReplied: number
    outcomeBounced: number
    outcomeUnsubscribed: number
}

/**
 * Hypothesis-scoring follow-up: the run's attributed-lead counts that back the
 * `verified_email_rate` metric. Kept separate from `RunOutcomeCounters` because these
 * two fields have no corresponding `prospecting_runs` column — they are recomputed fresh
 * on every pass from `leads.email_verification_status` and never written back to the DB.
 */
export interface RunLeadAttribution {
    attributedLeadCount: number
    verifiedOrLikelyLeadCount: number
}

export interface RunAggregate extends RunOutcomeCounters, RunLeadAttribution {}

const ZERO_COUNTERS: RunOutcomeCounters = {
    outcomeEmailed: 0,
    outcomeReplied: 0,
    outcomePositiveReplied: 0,
    outcomeBounced: 0,
    outcomeUnsubscribed: 0,
}

const ZERO_AGGREGATE: RunAggregate = {
    ...ZERO_COUNTERS,
    attributedLeadCount: 0,
    verifiedOrLikelyLeadCount: 0,
}

const VERIFIED_OR_LIKELY = new Set(['verified', 'likely'])

/**
 * Reduces raw joined (candidate|custom-field x outreach-email) rows into per-run outcome
 * counters.
 *
 * - For `attributionPath === 'candidate'` rows, excludes any row whose `importedAs` is not
 *   exactly 'created' (covers both 'existing' and null) — see the attribution-rule comment
 *   above. `attributionPath === 'custom_field'` rows are never filtered on `importedAs` —
 *   the SQL that produces them already scoped the join to this run's idempotency_key and
 *   organization, and the first-touch write-time rule in leads.ts (bulk-import) guarantees
 *   only one run can ever be the source_run_id for a given lead.
 * - Excludes rows with no `leadId` (candidate never resolved to a lead).
 * - Dedupes by (runId, leadId) so a lead with several sent/replied outreach_emails rows is
 *   still counted once per metric — DISTINCT-lead semantics, not row-count semantics. This
 *   dedup is also what collapses a lead reachable via BOTH attribution paths down to a
 *   single counted lead: both rows land under the same (runId, leadId) key and merge into
 *   one LeadState.
 * - `outcomeEmailed` only counts leads with at least one `sentAt` — a lead that was
 *   imported but never emailed contributes to no counter, keeping the denominator honest.
 * - `outcomePositiveReplied` additionally requires the lead's current `status === 'interested'`.
 * - Also rolls up `RunLeadAttribution` (attributed-lead count + verified-or-likely count)
 *   for the hypothesis-scoring `verified_email_rate` metric — every distinct attributed
 *   lead counts toward the denominator regardless of whether it was ever emailed, since
 *   the question that metric answers is "how enrichable was this segment", not "how well
 *   did the campaign perform".
 */
export function aggregateRunOutcomes(rows: RunOutcomeSourceRow[]): Map<string, RunAggregate> {
    interface LeadState {
        leadStatus: string | null
        emailVerificationStatus: string | null
        emailed: boolean
        replied: boolean
        bounced: boolean
        unsubscribed: boolean
    }

    const leadsByRun = new Map<string, Map<string, LeadState>>()

    for (const row of rows) {
        if (row.attributionPath === 'candidate' && row.importedAs !== 'created') continue
        if (!row.leadId) continue

        let leads = leadsByRun.get(row.runId)
        if (!leads) {
            leads = new Map<string, LeadState>()
            leadsByRun.set(row.runId, leads)
        }

        let state = leads.get(row.leadId)
        if (!state) {
            state = {
                leadStatus: row.leadStatus,
                emailVerificationStatus: row.emailVerificationStatus,
                emailed: false,
                replied: false,
                bounced: false,
                unsubscribed: false,
            }
            leads.set(row.leadId, state)
        }
        if (row.leadStatus) state.leadStatus = row.leadStatus
        if (row.emailVerificationStatus) state.emailVerificationStatus = row.emailVerificationStatus
        if (row.sentAt) state.emailed = true
        if (row.repliedAt) state.replied = true
        if (row.bouncedAt) state.bounced = true
        if (row.unsubscribedAt) state.unsubscribed = true
    }

    const result = new Map<string, RunAggregate>()
    for (const [runId, leads] of leadsByRun) {
        const aggregate: RunAggregate = { ...ZERO_AGGREGATE }
        for (const state of leads.values()) {
            if (state.emailed) aggregate.outcomeEmailed++
            if (state.replied) aggregate.outcomeReplied++
            if (state.replied && state.leadStatus === 'interested') aggregate.outcomePositiveReplied++
            if (state.bounced) aggregate.outcomeBounced++
            if (state.unsubscribed) aggregate.outcomeUnsubscribed++
            aggregate.attributedLeadCount++
            if (state.emailVerificationStatus && VERIFIED_OR_LIKELY.has(state.emailVerificationStatus)) {
                aggregate.verifiedOrLikelyLeadCount++
            }
        }
        result.set(runId, aggregate)
    }
    return result
}

// ============================================================
// Orchestration
// ============================================================

interface RunSnapshotRow extends RunOutcomeCounters {
    id: string
    organizationId: string
    // Hypothesis-scoring follow-up. `discoveredCount` never changes once a run reaches
    // 'imported' (this job doesn't recompute it), but it's read alongside the outcome
    // counters so both the "before" and "after" hypothesis score are built from a single
    // consistent row shape. `hypothesis` is the raw jsonb blob (see hypothesis.ts) —
    // `extractExpectedMetrics` pulls `expected` out of it defensively.
    discoveredCount: number
    hypothesis: Record<string, unknown> | null
}

export interface MeasureProspectingOutcomesSummary {
    examined: number
    updated: number
}

/** Builds the outcome.* events for runs whose counters changed since the last measurement. */
function buildOutcomeEvents(before: Map<string, RunSnapshotRow>, after: RunSnapshotRow[]): RecordRunEventInput[] {
    const events: RecordRunEventInput[] = []
    for (const row of after) {
        const prev = before.get(row.id)
        if (!prev) continue

        const detail = {
            outcomeEmailed: row.outcomeEmailed,
            outcomeReplied: row.outcomeReplied,
            outcomePositiveReplied: row.outcomePositiveReplied,
            outcomeBounced: row.outcomeBounced,
            outcomeUnsubscribed: row.outcomeUnsubscribed,
        }

        if (row.outcomeEmailed !== prev.outcomeEmailed) {
            events.push({ organizationId: row.organizationId, runId: row.id, code: RUN_EVENT_CODES.outcome.EMAILED, detail })
        }
        // A reply-status change (e.g. a lead moving to 'interested' after it already replied)
        // can move outcomePositiveReplied without moving outcomeReplied itself — either one
        // changing is a reply-outcome change worth narrating.
        if (row.outcomeReplied !== prev.outcomeReplied || row.outcomePositiveReplied !== prev.outcomePositiveReplied) {
            events.push({ organizationId: row.organizationId, runId: row.id, code: RUN_EVENT_CODES.outcome.REPLIED, detail })
        }
        if (row.outcomeBounced !== prev.outcomeBounced) {
            events.push({ organizationId: row.organizationId, runId: row.id, code: RUN_EVENT_CODES.outcome.BOUNCED, detail })
        }
        if (row.outcomeUnsubscribed !== prev.outcomeUnsubscribed) {
            events.push({ organizationId: row.organizationId, runId: row.id, code: RUN_EVENT_CODES.outcome.UNSUBSCRIBED, detail })
        }
    }
    return events
}

/**
 * A verdict "signature" used only to decide whether to emit — the overall verdict plus
 * each metric's categorical verdict, deliberately EXCLUDING the raw `actual`/`reason`
 * values. Those drift on every single incremental reply/send even when nothing about the
 * verdict itself has changed, and diffing on them would re-emit on almost every 6-hourly
 * pass — exactly the "drowns the narrative" failure this function exists to avoid.
 */
function hypothesisSignature(score: HypothesisScore): string {
    return JSON.stringify({
        overall: score.overall,
        metrics: score.metrics.map((m) => ({ metric: m.metric, verdict: m.verdict })),
    })
}

/**
 * Builds `outcome.hypothesis_*` events for runs whose stated hypothesis verdict changed
 * since the last measurement pass.
 *
 * Reconstructs the "before" score from the previously-persisted outcome counters (the
 * same `before` snapshot `buildOutcomeEvents` uses) and the "after" score from the
 * freshly-written ones. `discoveredCount` and the lead-attribution counts
 * (`attributedLeadCount`/`verifiedOrLikelyLeadCount`) have no historical "before" value —
 * `discoveredCount` never changes after import, and the attribution counts are recomputed
 * fresh every pass rather than persisted — so the same current values are used on both
 * sides; only `outcomeEmailed`/`outcomeReplied` actually differ between before and after.
 * This still correctly catches every real transition, since a run only starts confirming
 * or refuting its reply-rate/verified-email-rate expectations as emailed/replied counts
 * accumulate across passes.
 */
function buildHypothesisEvents(
    before: Map<string, RunSnapshotRow>,
    after: RunSnapshotRow[],
    aggregates: Map<string, RunAggregate>,
): RecordRunEventInput[] {
    const events: RecordRunEventInput[] = []

    for (const row of after) {
        const prev = before.get(row.id)
        if (!prev) continue

        const expected = extractExpectedMetrics(row.hypothesis)
        if (!expected) continue

        const attribution = aggregates.get(row.id) ?? ZERO_AGGREGATE

        const beforeScore = scoreHypothesis(expected, {
            discoveredCount: row.discoveredCount,
            emailedCount: prev.outcomeEmailed,
            repliedCount: prev.outcomeReplied,
            attributedLeadCount: attribution.attributedLeadCount,
            verifiedOrLikelyLeadCount: attribution.verifiedOrLikelyLeadCount,
        })
        const afterScore = scoreHypothesis(expected, {
            discoveredCount: row.discoveredCount,
            emailedCount: row.outcomeEmailed,
            repliedCount: row.outcomeReplied,
            attributedLeadCount: attribution.attributedLeadCount,
            verifiedOrLikelyLeadCount: attribution.verifiedOrLikelyLeadCount,
        })

        // No journey code fits "we no longer know" (see the module doc above), and outcome
        // counters never decrease, so a transition INTO 'inconclusive' should not occur in
        // practice — skip it defensively rather than guess a code for it.
        if (afterScore.overall === 'inconclusive') continue
        if (hypothesisSignature(beforeScore) === hypothesisSignature(afterScore)) continue

        const code = afterScore.overall === 'confirmed'
            ? RUN_EVENT_CODES.outcome.HYPOTHESIS_CONFIRMED
            : RUN_EVENT_CODES.outcome.HYPOTHESIS_REFUTED

        // Name WHICH expectation failed (or held) and by how much, not merely that one did.
        const failing = afterScore.metrics.filter((m) => m.verdict === 'not_met')
        const met = afterScore.metrics.filter((m) => m.verdict === 'met')
        const summary = failing.length > 0
            ? `hypothesis refuted: ${failing.map((m) => `${m.metric} expected ${m.expected}, ${m.reason}`).join('; ')}`
            : `hypothesis confirmed: ${met.map((m) => `${m.metric} expected ${m.expected}, ${m.reason}`).join('; ')}`

        events.push({
            organizationId: row.organizationId,
            runId: row.id,
            code,
            summary,
            detail: { overall: afterScore.overall, metrics: afterScore.metrics },
        })
    }

    return events
}

/**
 * Recomputes outcome_* counters for every 'imported' prospecting run from source-of-truth
 * tables and writes them back in one batched UPDATE. Never throws — every failure mode is
 * caught, logged, and returns a summary reflecting whatever partial progress was made.
 */
export async function measureProspectingOutcomes(now: Date = new Date()): Promise<MeasureProspectingOutcomesSummary> {
    const summary: MeasureProspectingOutcomesSummary = { examined: 0, updated: 0 }

    let before: RunSnapshotRow[]
    try {
        before = await queryClient<RunSnapshotRow[]>`
            SELECT
                id::text,
                organization_id::text AS "organizationId",
                outcome_emailed AS "outcomeEmailed",
                outcome_replied AS "outcomeReplied",
                outcome_positive_replied AS "outcomePositiveReplied",
                outcome_bounced AS "outcomeBounced",
                outcome_unsubscribed AS "outcomeUnsubscribed",
                discovered_count AS "discoveredCount",
                hypothesis
            FROM prospecting_runs
            WHERE status = 'imported'
        `
    } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error))
        log.error({
            action: 'outreach.prospecting.measure_outcomes_list_failed',
            error: { message: e.message, stack: e.stack },
        }, 'failed to list imported prospecting runs')
        return summary
    }

    summary.examined = before.length
    if (before.length === 0) {
        log.info({ action: 'outreach.prospecting.measure_outcomes_summary', ...summary }, 'measured prospecting run outcomes')
        return summary
    }

    const beforeById = new Map(before.map((row) => [row.id, row]))

    let sourceRows: RunOutcomeSourceRow[]
    try {
        sourceRows = await queryClient<RunOutcomeSourceRow[]>`
            -- Path (a): Apollo/agent-prospecting.ts — candidate rows explicitly created by a
            -- prospecting run. Never run in production, but kept for completeness/parity.
            SELECT
                pr.id::text AS "runId",
                pr.organization_id::text AS "organizationId",
                'candidate'::text AS "attributionPath",
                pc.imported_as AS "importedAs",
                pc.lead_id::text AS "leadId",
                l.status::text AS "leadStatus",
                l.email_verification_status AS "emailVerificationStatus",
                oe.sent_at AS "sentAt",
                oe.replied_at AS "repliedAt",
                oe.bounced_at AS "bouncedAt",
                oe.unsubscribed_at AS "unsubscribedAt"
            FROM prospecting_runs pr
            JOIN prospect_candidates pc ON pc.run_id = pr.id
            LEFT JOIN leads l ON l.id = pc.lead_id
            LEFT JOIN campaign_leads cl ON cl.lead_id = l.id
            LEFT JOIN outreach_emails oe ON oe.campaign_lead_id = cl.id
            WHERE pr.status = 'imported'

            UNION ALL

            -- Path (b): the real production path — xcraper/Xphere leads that were never
            -- routed through prospect_candidates at all. A lead is attributed to this run
            -- when its custom_fields.source_run_id (stamped by POST /leads/bulk-import,
            -- first-touch only — see leads.ts) matches this run's idempotency_key, scoped to
            -- the same organization so a stray/duplicate key in another tenant can't match.
            SELECT
                pr.id::text AS "runId",
                pr.organization_id::text AS "organizationId",
                'custom_field'::text AS "attributionPath",
                NULL::text AS "importedAs",
                l.id::text AS "leadId",
                l.status::text AS "leadStatus",
                l.email_verification_status AS "emailVerificationStatus",
                oe.sent_at AS "sentAt",
                oe.replied_at AS "repliedAt",
                oe.bounced_at AS "bouncedAt",
                oe.unsubscribed_at AS "unsubscribedAt"
            FROM prospecting_runs pr
            JOIN leads l
                ON l.organization_id = pr.organization_id
                AND l.custom_fields ->> 'source_run_id' = pr.idempotency_key
            LEFT JOIN campaign_leads cl ON cl.lead_id = l.id
            LEFT JOIN outreach_emails oe ON oe.campaign_lead_id = cl.id
            WHERE pr.status = 'imported'
        `
    } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error))
        log.error({
            action: 'outreach.prospecting.measure_outcomes_source_failed',
            error: { message: e.message, stack: e.stack },
        }, 'failed to read prospecting outcome source rows')
        return summary
    }

    const aggregates = aggregateRunOutcomes(sourceRows)

    // Every run in `before` gets an update row, defaulting to zero counters when it has no
    // attributable ('created', non-null leadId) candidates at all — that run was genuinely
    // examined and should still get outcome_last_measured_at bumped.
    const updateRows: (RunAggregate & { id: string })[] = before.map((run) => ({
        id: run.id,
        ...(aggregates.get(run.id) ?? ZERO_AGGREGATE),
    }))

    const ids = updateRows.map((r) => r.id)
    const emailedArr = updateRows.map((r) => r.outcomeEmailed)
    const repliedArr = updateRows.map((r) => r.outcomeReplied)
    const positiveArr = updateRows.map((r) => r.outcomePositiveReplied)
    const bouncedArr = updateRows.map((r) => r.outcomeBounced)
    const unsubscribedArr = updateRows.map((r) => r.outcomeUnsubscribed)

    const nowIso = sqlTimestampValue(now)

    let after: RunSnapshotRow[]
    try {
        after = await queryClient<RunSnapshotRow[]>`
            UPDATE prospecting_runs SET
                outcome_emailed = data.emailed,
                outcome_replied = data.replied,
                outcome_positive_replied = data.positive_replied,
                outcome_bounced = data.bounced,
                outcome_unsubscribed = data.unsubscribed,
                outcome_last_measured_at = ${nowIso},
                updated_at = ${nowIso}
            FROM unnest(
                ${ids}::uuid[],
                ${emailedArr}::int[],
                ${repliedArr}::int[],
                ${positiveArr}::int[],
                ${bouncedArr}::int[],
                ${unsubscribedArr}::int[]
            ) AS data(id, emailed, replied, positive_replied, bounced, unsubscribed)
            WHERE prospecting_runs.id = data.id
            RETURNING
                prospecting_runs.id::text,
                prospecting_runs.organization_id::text AS "organizationId",
                prospecting_runs.outcome_emailed AS "outcomeEmailed",
                prospecting_runs.outcome_replied AS "outcomeReplied",
                prospecting_runs.outcome_positive_replied AS "outcomePositiveReplied",
                prospecting_runs.outcome_bounced AS "outcomeBounced",
                prospecting_runs.outcome_unsubscribed AS "outcomeUnsubscribed",
                prospecting_runs.discovered_count AS "discoveredCount",
                prospecting_runs.hypothesis
        `
    } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error))
        log.error({
            action: 'outreach.prospecting.measure_outcomes_update_failed',
            error: { message: e.message, stack: e.stack },
        }, 'failed to write recomputed prospecting outcome counters')
        return summary
    }

    summary.updated = after.length

    const events = [
        ...buildOutcomeEvents(beforeById, after),
        ...buildHypothesisEvents(beforeById, after, aggregates),
    ]
    if (events.length > 0) {
        await recordRunEvents(db, events)
    }

    log.info({ action: 'outreach.prospecting.measure_outcomes_summary', ...summary }, 'measured prospecting run outcomes')
    return summary
}

export async function runMeasureProspectingOutcomesWithLock(): Promise<void> {
    await runWithLock('measureProspectingOutcomes', measureProspectingOutcomes)
}
