/**
 * Fase 40 (docs/prospecting-engine-plan.md "Fase 40 -- Silêncio do motor e resumo diário") --
 * Deliverable 4, the daily digest's engine section.
 *
 * Evidence: on 2026-09-08 this exact picture (today's runs and verdicts, the funnel, spend
 * against budget, verification-provider balances, approvals awaiting a human) was assembled
 * BY HAND in ad-hoc SQL. The digest already exists (`dailyOutreachDigest.ts`, 09:00 UTC) --
 * this module is the query half that makes the assembly unnecessary going forward.
 *
 * EVERY NUMBER HERE COMES FROM A QUERY, NEVER A CONSTANT -- with exactly one deliberate
 * exception, `creditBalances`, which is not a number at all: MillionVerifier/NeverBounce
 * credit balances live behind API keys that are configured in HERMES's environment, not
 * Xmail's (see hermes/README.md, `verification-credits.py`) -- there is no table, no env var,
 * and no endpoint in this codebase that could answer "what is the balance". Reporting a
 * fabricated or stale number would be worse than the honest "unknown, not reachable from
 * Xmail" this module returns instead. See `CREDIT_BALANCE_UNREACHABLE_NOTE`.
 *
 * Split from `dailyOutreachDigest.ts` (which stays a thin orchestrator) so this is directly
 * unit-testable the same way `measureProspectingOutcomes.ts`/`runDailyProspecting.ts` are:
 * `queryClient` is a mockable tagged-template import, not a `db.execute(sql\`...\`)` call.
 */
import { queryClient } from '../../../db'
import { resolveDailyBudgetUsd } from './daily-territory-budget'

/** The Agent Ops page (src/main.tsx) -- where a human clears `pendingApprovals`. A route
 *  string, not fabricated data; it never changes independently of the frontend routing table. */
export const AGENT_OPS_PAGE_PATH = '/outreach/agent-ops'

/**
 * MillionVerifier and NeverBounce report a CREDIT balance, not a spend total -- and Xmail's
 * ledger (`outreach_cost_entries`, category `email_verification`) only ever records spend
 * inferred from a completed batch, never the provider's own remaining-balance figure. The two
 * numbers are related but not the same, and Xmail cannot derive one from the other reliably
 * (rates, top-ups and free-tier bonuses live entirely on the provider side -- see
 * docs/prospecting-journey.md "What is priced today"). Until Hermes's env or a dedicated
 * proxy endpoint is exposed to Xmail, this stays the honest answer.
 */
export const CREDIT_BALANCE_UNREACHABLE_NOTE =
    'MillionVerifier/NeverBounce credit balances are unknown from Xmail — the provider API keys '
    + "live in Hermes' environment (see hermes/README.md, verification-credits.py), not in Xmail. "
    + 'Xmail only sees derived spend via outreach_cost_entries (category=email_verification), '
    + "never the providers' own remaining-balance endpoints."

/** Same UTC-midnight boundary runDailyProspecting.ts's `startOfTodayUtc` and
 *  outreach-silence-query.ts use for "today" -- all three must agree. */
function startOfTodayUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export interface EngineDigestRunVerdict {
    runId: string
    provider: string
    externalRunId: string
    /** From the latest `assess.verdict` Journey event for this run (Fase 39), or `null` when
     *  none has been recorded yet -- e.g. the run just started, or its hypothesis has no
     *  computable expectation yet. Never fabricated when absent. */
    overall: 'confirmed' | 'refuted' | 'inconclusive' | null
}

export interface EngineDigestFunnel {
    discovered: number
    verified: number
    sendable: number
    imported: number
    enrolled: number
    emailed: number
}

export interface EngineDigestSpend {
    spentTodayUsd: number
    dailyBudgetUsd: number
}

export interface EngineDigestCreditBalances {
    millionVerifier: 'unknown_not_reachable_from_xmail'
    neverBounce: 'unknown_not_reachable_from_xmail'
    note: string
}

export interface EngineDigestApprovals {
    pendingCount: number
    agentOpsUrl: string
}

export interface EngineDigestSection {
    runsToday: EngineDigestRunVerdict[]
    funnel: EngineDigestFunnel
    spend: EngineDigestSpend
    creditBalances: EngineDigestCreditBalances
    approvals: EngineDigestApprovals
}

interface RunVerdictRow {
    runId: string
    provider: string
    externalRunId: string
    overall: string | null
}

interface AggregateRow {
    discovered: number | string
    verified: number | string
    sendable: number | string
    imported: number | string
    emailed: number | string
    enrolled: number | string
    spentTodayMicros: number | string
    pendingApprovals: number | string
}

/**
 * Fase 40, Deliverable 4. Two round trips: the per-run verdict list (one row per run created
 * today) and one aggregate row for everything else. Never throws internally is NOT guaranteed
 * here on purpose -- unlike the silence/outcome jobs, a digest that silently produced a wrong
 * "zero" would be indistinguishable from an actually-quiet day (exactly the failure mode this
 * whole fase exists to close); the caller (`dailyOutreachDigest.ts`) already wraps its own
 * `Promise.all` in a try/catch and logs `outreach.digest.failed` instead of guessing a payload.
 */
export async function computeEngineDigestSection(now: Date = new Date()): Promise<EngineDigestSection> {
    const startOfTodayIso = startOfTodayUtc(now).toISOString()
    const dailyBudgetUsd = resolveDailyBudgetUsd()

    const runRows = await queryClient<RunVerdictRow[]>`
        SELECT
            r.id::text AS "runId",
            r.provider AS "provider",
            r.idempotency_key AS "externalRunId",
            v.overall AS "overall"
        FROM prospecting_runs r
        LEFT JOIN LATERAL (
            SELECT detail ->> 'overall' AS overall
            FROM prospecting_run_events
            WHERE run_id = r.id AND code = 'assess.verdict'
            ORDER BY sequence_number DESC
            LIMIT 1
        ) v ON true
        WHERE r.created_at >= ${startOfTodayIso}
        ORDER BY r.created_at ASC
    `

    const [aggregateRow] = await queryClient<AggregateRow[]>`
        SELECT
            (SELECT coalesce(sum(discovered_count), 0)::bigint FROM prospecting_runs
                WHERE created_at >= ${startOfTodayIso}) AS "discovered",
            (SELECT coalesce(sum(verified_ok_count), 0)::bigint FROM prospecting_runs
                WHERE created_at >= ${startOfTodayIso}) AS "verified",
            (SELECT coalesce(sum(imported_count), 0)::bigint FROM prospecting_runs
                WHERE created_at >= ${startOfTodayIso}) AS "imported",
            (SELECT coalesce(sum(outcome_emailed), 0)::bigint FROM prospecting_runs
                WHERE created_at >= ${startOfTodayIso}) AS "emailed",
            -- Leads attributable to today's runs (same custom_fields.source_run_id join
            -- measureProspectingOutcomes.ts uses) whose email is verified/likely -- ready to
            -- be sent to, whether or not a campaign has picked them up yet.
            (SELECT count(DISTINCT l.id) FROM prospecting_runs r
                JOIN leads l ON l.organization_id = r.organization_id
                    AND l.custom_fields ->> 'source_run_id' = r.idempotency_key
                WHERE r.created_at >= ${startOfTodayIso}
                  AND l.email_verification_status IN ('verified', 'likely')) AS "sendable",
            -- Of those attributable leads, how many have actually been enrolled in a campaign.
            (SELECT count(DISTINCT l.id) FROM prospecting_runs r
                JOIN leads l ON l.organization_id = r.organization_id
                    AND l.custom_fields ->> 'source_run_id' = r.idempotency_key
                JOIN campaign_leads cl ON cl.lead_id = l.id
                WHERE r.created_at >= ${startOfTodayIso}) AS "enrolled",
            (SELECT coalesce(sum(amount_micros), 0)::bigint FROM outreach_cost_entries
                WHERE category = 'lead_source' AND occurred_at >= ${startOfTodayIso}) AS "spentTodayMicros",
            (SELECT count(*) FROM outreach_action_approvals WHERE status = 'requested') AS "pendingApprovals"
    `

    const n = (value: number | string | undefined | null) => Number(value ?? 0)
    const row = aggregateRow ?? {
        discovered: 0, verified: 0, sendable: 0, imported: 0, emailed: 0, enrolled: 0,
        spentTodayMicros: 0, pendingApprovals: 0,
    }

    return {
        runsToday: runRows.map((r) => ({
            runId: r.runId,
            provider: r.provider,
            externalRunId: r.externalRunId,
            overall: (r.overall as EngineDigestRunVerdict['overall']) ?? null,
        })),
        funnel: {
            discovered: n(row.discovered),
            verified: n(row.verified),
            sendable: n(row.sendable),
            imported: n(row.imported),
            enrolled: n(row.enrolled),
            emailed: n(row.emailed),
        },
        spend: {
            spentTodayUsd: n(row.spentTodayMicros) / 1_000_000,
            dailyBudgetUsd,
        },
        creditBalances: {
            millionVerifier: 'unknown_not_reachable_from_xmail',
            neverBounce: 'unknown_not_reachable_from_xmail',
            note: CREDIT_BALANCE_UNREACHABLE_NOTE,
        },
        approvals: {
            pendingCount: n(row.pendingApprovals),
            agentOpsUrl: AGENT_OPS_PAGE_PATH,
        },
    }
}
