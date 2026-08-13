import { db, queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { sqlTimestampValue } from '../lib/sql-timestamp'
import { recordRunEvents, RUN_EVENT_CODES, type RecordRunEventInput } from '../lib/prospecting/journey'

const log = createLogger('outreach.prospecting.measure_outcomes')

/**
 * Phase 31 follow-up — closes the feedback loop from prospecting run to outreach outcome.
 *
 * RECOMPUTE, DO NOT INCREMENT: every pass reads the current source-of-truth tables
 * (prospect_candidates -> leads -> campaign_leads -> outreach_emails) and overwrites each
 * run's outcome_* counters with a freshly computed total. It does NOT consume the event
 * outbox and keeps NO cursor. Recomputation is idempotent and self-healing — a missed or
 * replayed event can never corrupt the totals, and there is no cursor position to lose.
 * Prospecting runs are few (one row per prospecting search, not per lead or per email), so
 * the cost of recomputing from scratch on every 6-hourly tick is trivial compared to the
 * correctness gained.
 *
 * ATTRIBUTION RULE (the crux): only candidates with imported_as = 'created' are credited to
 * a run. A candidate with imported_as = 'existing' resolved to a lead some EARLIER run
 * already sourced — crediting it here would let two runs claim the same human and inflate
 * both runs' numbers. Candidates with imported_as IS NULL (rows imported before this column
 * existed, migration 051) are ALSO excluded, for the identical reason: we cannot prove those
 * rows were new leads rather than matches against an existing one.
 */

// ============================================================
// Raw source rows (one query, joined but NOT aggregated) — kept
// separate from aggregation so the attribution/dedup rules below
// are exercised by pure unit tests without touching a database.
// ============================================================

interface RunOutcomeSourceRow {
    runId: string
    organizationId: string
    importedAs: 'created' | 'existing' | null
    leadId: string | null
    leadStatus: string | null
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

const ZERO_COUNTERS: RunOutcomeCounters = {
    outcomeEmailed: 0,
    outcomeReplied: 0,
    outcomePositiveReplied: 0,
    outcomeBounced: 0,
    outcomeUnsubscribed: 0,
}

/**
 * Reduces raw joined (candidate x outreach-email) rows into per-run outcome counters.
 *
 * - Excludes any row whose `importedAs` is not exactly 'created' (covers both 'existing'
 *   and null) — see the attribution-rule comment above.
 * - Excludes rows with no `leadId` (candidate never resolved to a lead).
 * - Dedupes by (runId, leadId) so a lead with several sent/replied outreach_emails rows is
 *   still counted once per metric — DISTINCT-lead semantics, not row-count semantics.
 * - `outcomeEmailed` only counts leads with at least one `sentAt` — a lead that was
 *   imported but never emailed contributes to no counter, keeping the denominator honest.
 * - `outcomePositiveReplied` additionally requires the lead's current `status === 'interested'`.
 */
export function aggregateRunOutcomes(rows: RunOutcomeSourceRow[]): Map<string, RunOutcomeCounters> {
    interface LeadState {
        leadStatus: string | null
        emailed: boolean
        replied: boolean
        bounced: boolean
        unsubscribed: boolean
    }

    const leadsByRun = new Map<string, Map<string, LeadState>>()

    for (const row of rows) {
        if (row.importedAs !== 'created') continue
        if (!row.leadId) continue

        let leads = leadsByRun.get(row.runId)
        if (!leads) {
            leads = new Map<string, LeadState>()
            leadsByRun.set(row.runId, leads)
        }

        let state = leads.get(row.leadId)
        if (!state) {
            state = { leadStatus: row.leadStatus, emailed: false, replied: false, bounced: false, unsubscribed: false }
            leads.set(row.leadId, state)
        }
        if (row.leadStatus) state.leadStatus = row.leadStatus
        if (row.sentAt) state.emailed = true
        if (row.repliedAt) state.replied = true
        if (row.bouncedAt) state.bounced = true
        if (row.unsubscribedAt) state.unsubscribed = true
    }

    const result = new Map<string, RunOutcomeCounters>()
    for (const [runId, leads] of leadsByRun) {
        const counters: RunOutcomeCounters = { ...ZERO_COUNTERS }
        for (const state of leads.values()) {
            if (state.emailed) counters.outcomeEmailed++
            if (state.replied) counters.outcomeReplied++
            if (state.replied && state.leadStatus === 'interested') counters.outcomePositiveReplied++
            if (state.bounced) counters.outcomeBounced++
            if (state.unsubscribed) counters.outcomeUnsubscribed++
        }
        result.set(runId, counters)
    }
    return result
}

// ============================================================
// Orchestration
// ============================================================

interface RunSnapshotRow extends RunOutcomeCounters {
    id: string
    organizationId: string
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
                outcome_unsubscribed AS "outcomeUnsubscribed"
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
            SELECT
                pr.id::text AS "runId",
                pr.organization_id::text AS "organizationId",
                pc.imported_as AS "importedAs",
                pc.lead_id::text AS "leadId",
                l.status::text AS "leadStatus",
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
    const updateRows: (RunOutcomeCounters & { id: string })[] = before.map((run) => ({
        id: run.id,
        ...(aggregates.get(run.id) ?? ZERO_COUNTERS),
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
                prospecting_runs.outcome_unsubscribed AS "outcomeUnsubscribed"
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

    const events = buildOutcomeEvents(beforeById, after)
    if (events.length > 0) {
        await recordRunEvents(db, events)
    }

    log.info({ action: 'outreach.prospecting.measure_outcomes_summary', ...summary }, 'measured prospecting run outcomes')
    return summary
}

export async function runMeasureProspectingOutcomesWithLock(): Promise<void> {
    await runWithLock('measureProspectingOutcomes', measureProspectingOutcomes)
}
