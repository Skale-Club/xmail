/**
 * Append-only narrative of a prospecting run (Phase 31, migration 051).
 *
 * `prospecting_run_events` is written to but never updated or deleted — every phase
 * transition of a run (search, score, enrich, assess, import, outcome) appends one row.
 * Callers cannot invent ad-hoc event strings: they pick a code from `RUN_EVENT_CODES`,
 * and the row's `phase`/`level` are derived from that code rather than accepted as
 * free-form parameters, so a caller can never write a mismatched phase/code pair or an
 * inconsistent severity for a well-known failure code.
 *
 * This module is telemetry, not a source of truth: `recordRunEvent`/`recordRunEvents`
 * NEVER throw. A failed insert is caught and logged so a broken events table can never
 * take down a prospecting run.
 */

import { db } from '../../../db'
import { prospectingRunEvents, type ProspectingRunEventLevel, type ProspectingRunEventPhase } from '../../../db/schema'
import { jsonbParam } from '../jsonb'

// ============================================================
// db/tx parameter typing
// ============================================================

// Matches the convention in src/server/lib/outreach-sequences.ts (`TransactionClient`),
// extended to a union so callers can pass either the module-level `db` or an in-flight
// `tx` from `db.transaction(...)` — recording a run event is frequently the last step of
// a larger transactional write (e.g. persisting a candidate) and must not force a second
// round-trip outside it.
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type DbClient = typeof db | TransactionClient

// ============================================================
// Namespaced event codes
// ============================================================

/**
 * Frozen, namespaced event codes grouped by phase. This is the only way to name a run
 * event — there is no way to pass a raw string, so the phase/code pairing recorded on
 * the row can never drift from this table.
 */
export const RUN_EVENT_CODES = Object.freeze({
    search: Object.freeze({
        QUERY_ISSUED: 'provider.query_issued',
        ZERO_RESULTS: 'provider.zero_results',
        PARTIAL_PAGE: 'provider.partial_page',
        RATE_LIMITED: 'provider.rate_limited',
        FAILED: 'provider.failed',
    }),
    score: Object.freeze({
        CANDIDATE_QUALIFIED: 'score.candidate_qualified',
        CANDIDATE_BELOW_THRESHOLD: 'score.candidate_below_threshold',
        NO_CRITERIA: 'score.no_criteria',
    }),
    enrich: Object.freeze({
        REQUESTED: 'enrich.requested',
        NO_EMAIL: 'enrich.no_email',
        EMAIL_UNVERIFIABLE: 'enrich.email_unverifiable',
        FAILED: 'enrich.failed',
        CREDIT_CEILING_REACHED: 'enrich.credit_ceiling_reached',
    }),
    assess: Object.freeze({
        RECORDED: 'assess.recorded',
        REJECTED: 'assess.rejected',
        ORCHESTRATOR_NOTE: 'assess.orchestrator_note',
    }),
    import: Object.freeze({
        LEAD_CREATED: 'import.lead_created',
        LEAD_EXISTING: 'import.lead_existing',
        SKIPPED_INELIGIBLE: 'import.skipped_ineligible',
        // Phase 32 (migration 054): an externally-run prospecting run (e.g. xcraper/Apify,
        // registered via POST /api/outreach/prospecting/external-runs) was recorded after
        // the fact — the run already completed and imported leads outside xmail's own
        // search/score/enrich flow, so none of the other import.* codes (which describe a
        // single candidate's fate during xmail-driven import) fit.
        EXTERNAL_RUN_REGISTERED: 'import.external_run_registered',
    }),
    outcome: Object.freeze({
        EMAILED: 'outcome.emailed',
        REPLIED: 'outcome.replied',
        BOUNCED: 'outcome.bounced',
        UNSUBSCRIBED: 'outcome.unsubscribed',
        // Phase 31 follow-up (hypothesis scoring, src/server/lib/prospecting/hypothesis-scoring.ts):
        // a run's stated `hypothesis.expected` was scored against its measured outcomes and the
        // OVERALL verdict changed since the last measurement pass. Emitted only on a verdict
        // transition, never on every 6-hourly recompute, and never for 'inconclusive' (there is
        // nothing to narrate about "we still don't know").
        HYPOTHESIS_CONFIRMED: 'outcome.hypothesis_confirmed',
        HYPOTHESIS_REFUTED: 'outcome.hypothesis_refuted',
    }),
} satisfies Record<ProspectingRunEventPhase, Record<string, string>>)

type RunEventCodeGroups = typeof RUN_EVENT_CODES

/** Union of every valid event code, e.g. 'provider.query_issued' | 'score.candidate_qualified' | ... */
export type RunEventCode = {
    [Phase in keyof RunEventCodeGroups]: RunEventCodeGroups[Phase][keyof RunEventCodeGroups[Phase]]
}[keyof RunEventCodeGroups]

/** code -> phase, built once from RUN_EVENT_CODES so it can never disagree with it. */
const CODE_TO_PHASE: Record<RunEventCode, ProspectingRunEventPhase> = (() => {
    const map = {} as Record<RunEventCode, ProspectingRunEventPhase>
    for (const phase of Object.keys(RUN_EVENT_CODES) as ProspectingRunEventPhase[]) {
        for (const code of Object.values(RUN_EVENT_CODES[phase])) {
            map[code as RunEventCode] = phase
        }
    }
    return map
})()

/** Returns the phase a code belongs to. Exported mainly so tests can assert exhaustiveness. */
export function phaseForCode(code: RunEventCode): ProspectingRunEventPhase {
    return CODE_TO_PHASE[code]
}

// ============================================================
// Level defaulting
// ============================================================

/**
 * Explicit code -> default-level overrides. Anything not listed here defaults to 'info'.
 * Deliberately a lookup table, not a suffix/substring heuristic, so a future code named
 * e.g. 'import.failed_something_else' does not silently inherit 'error' by accident.
 */
const DEFAULT_LEVEL_OVERRIDES: Partial<Record<RunEventCode, ProspectingRunEventLevel>> = {
    [RUN_EVENT_CODES.search.RATE_LIMITED]: 'error',
    [RUN_EVENT_CODES.search.FAILED]: 'error',
    [RUN_EVENT_CODES.enrich.FAILED]: 'error',
    [RUN_EVENT_CODES.search.ZERO_RESULTS]: 'warn',
    [RUN_EVENT_CODES.enrich.NO_EMAIL]: 'warn',
    [RUN_EVENT_CODES.score.CANDIDATE_BELOW_THRESHOLD]: 'warn',
    [RUN_EVENT_CODES.enrich.CREDIT_CEILING_REACHED]: 'warn',
    // A refutation is worth a warn — it says a stated premise did not hold up. A
    // confirmation stays at the 'info' default (no override needed).
    [RUN_EVENT_CODES.outcome.HYPOTHESIS_REFUTED]: 'warn',
}

/** Returns the default level for a code (used when the caller does not pass one explicitly). */
export function defaultLevelForCode(code: RunEventCode): ProspectingRunEventLevel {
    return DEFAULT_LEVEL_OVERRIDES[code] ?? 'info'
}

// ============================================================
// Recording
// ============================================================

export interface RecordRunEventInput {
    organizationId: string
    runId: string
    candidateId?: string | null
    code: RunEventCode
    level?: ProspectingRunEventLevel
    summary?: string | null
    detail?: Record<string, unknown>
}

function toRow(input: RecordRunEventInput) {
    return {
        organizationId: input.organizationId,
        runId: input.runId,
        candidateId: input.candidateId ?? null,
        phase: phaseForCode(input.code),
        level: input.level ?? defaultLevelForCode(input.code),
        code: input.code,
        summary: input.summary ?? null,
        detail: jsonbParam(input.detail ?? {}),
    }
}

/**
 * Append one run event. Never throws: a failed insert is logged and swallowed so
 * telemetry can never break the caller's actual work.
 */
export async function recordRunEvent(db: DbClient, input: RecordRunEventInput): Promise<void> {
    try {
        await db.insert(prospectingRunEvents).values(toRow(input))
    } catch (error) {
        console.error('[prospecting/journey] failed to record run event', {
            runId: input.runId,
            code: input.code,
            error,
        })
    }
}

/**
 * Append many run events in a single round-trip (e.g. a run scoring 100 candidates at
 * once). Never throws, for the same reason as recordRunEvent.
 */
export async function recordRunEvents(db: DbClient, inputs: RecordRunEventInput[]): Promise<void> {
    if (inputs.length === 0) return
    try {
        await db.insert(prospectingRunEvents).values(inputs.map(toRow))
    } catch (error) {
        console.error('[prospecting/journey] failed to record run events batch', {
            count: inputs.length,
            error,
        })
    }
}
