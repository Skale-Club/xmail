/**
 * Outreach cost price book + append-only ledger (Phase 31, migration 051).
 *
 * `outreach_cost_rates` is a price book: a NULL organization_id row is the platform
 * default rate for its category/provider/model, an org-specific row overrides it.
 * `outreach_cost_entries` is an append-only ledger — `unitCostMicros`/`amountMicros` are
 * frozen at write time so a later rate change never rewrites the historical cost of a
 * past entry. All money is USD micros (1e-6 USD) so per-token/per-credit prices don't
 * round to zero.
 *
 * Like src/server/lib/prospecting/journey.ts, this is telemetry/accounting support:
 * `recordCost` NEVER throws. A failed write is caught, logged, and reported back to the
 * caller as an unwritten result rather than propagated.
 */

import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../../db'
import {
    outreachCostEntries,
    outreachCostRates,
    type OutreachCostBasis,
    type OutreachCostCategory,
    type OutreachCostEntry,
    type OutreachCostRate,
    type OutreachCostUnit,
} from '../../db/schema'
import { jsonbParam } from './jsonb'

// ============================================================
// db/tx parameter typing
// ============================================================

// Same convention as src/server/lib/outreach-sequences.ts (`TransactionClient`) and
// src/server/lib/prospecting/journey.ts (`DbClient`): accept either the module-level
// `db` or an in-flight `tx` from `db.transaction(...)` so recording a cost entry can be
// folded into a larger transactional write (e.g. alongside the run/assessment row it
// bills for) without forcing a second round-trip.
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type DbClient = typeof db | TransactionClient

// ============================================================
// Rate resolution
// ============================================================

export interface ResolveRateInput {
    organizationId: string
    category: OutreachCostCategory
    unit: OutreachCostUnit
    provider?: string | null
    model?: string | null
    /** Point in time to resolve against. Defaults to now. */
    at?: Date
}

/**
 * Resolve the applicable price-book row for a category/unit/provider/model at a point
 * in time.
 *
 * Resolution order:
 *   1. An org-specific row (organization_id = organizationId) beats a platform default
 *      row (organization_id IS NULL).
 *   2. A row only matches if valid_from <= at AND (valid_to IS NULL OR valid_to > at).
 *   3. If several rows still match (same scope, overlapping windows), the one with the
 *      greatest valid_from wins.
 *
 * `outreach_cost_rates` intentionally has no database constraint preventing overlapping
 * validity windows for the same category/provider/model — see the column comment on the
 * table in src/db/schema.ts. This function's deterministic tie-break (org beats
 * platform, then latest valid_from) is what makes resolution unambiguous despite that;
 * it must stay in sync with any future change to that resolution policy.
 */
export async function resolveRate(db: DbClient, input: ResolveRateInput): Promise<OutreachCostRate | null> {
    const at = input.at ?? new Date()
    const provider = input.provider ?? null
    const model = input.model ?? null

    // Scope the query to category/unit/provider/model and organization-or-platform rows;
    // the validity-window match and org-vs-platform/tie-break resolution itself happen in
    // pickApplicableRate below (kept pure/synchronous so it is unit-testable without a
    // live database).
    const candidates = await db
        .select()
        .from(outreachCostRates)
        .where(and(
            or(eq(outreachCostRates.organizationId, input.organizationId), isNull(outreachCostRates.organizationId)),
            eq(outreachCostRates.category, input.category),
            eq(outreachCostRates.unit, input.unit),
            provider === null ? isNull(outreachCostRates.provider) : eq(outreachCostRates.provider, provider),
            model === null ? isNull(outreachCostRates.model) : eq(outreachCostRates.model, model),
        ))

    return pickApplicableRate(candidates, input.organizationId, at)
}

/**
 * Applies the deterministic resolution policy documented on `resolveRate` to an
 * already category/unit/provider/model/scope-filtered candidate set: excludes rows
 * outside their validity window, prefers an org-specific row over a platform default,
 * then breaks any remaining tie by the greatest `validFrom`.
 *
 * Exported and kept pure/synchronous (no I/O) specifically so this policy — the part
 * that matters given `outreach_cost_rates` allows overlapping validity windows — can be
 * unit-tested directly, without mocking a database round-trip.
 */
export function pickApplicableRate(
    candidates: OutreachCostRate[],
    organizationId: string,
    at: Date,
): OutreachCostRate | null {
    const withinWindow = candidates.filter(
        (row) => row.validFrom <= at && (row.validTo === null || row.validTo > at),
    )
    if (withinWindow.length === 0) return null

    const orgSpecific = withinWindow.filter((row) => row.organizationId === organizationId)
    const pool = orgSpecific.length > 0 ? orgSpecific : withinWindow.filter((row) => row.organizationId === null)
    if (pool.length === 0) return null

    return [...pool].sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime())[0]
}

// ============================================================
// Ledger writes
// ============================================================

export interface RecordCostInput {
    organizationId: string
    category: OutreachCostCategory
    basis: OutreachCostBasis
    /**
     * Number of units consumed. Accepts a number or a string because callers sometimes
     * pass a value that came straight back out of Drizzle (Postgres `numeric` columns —
     * outreach_cost_entries.quantity itself included — are typed as `string` by Drizzle
     * on both insert and select, not `number`; see the schema comment).
     */
    quantity: number | string
    unit: OutreachCostUnit
    provider?: string | null
    model?: string | null
    runId?: string | null
    campaignId?: string | null
    emailAccountId?: string | null
    aiRunId?: string | null
    assessmentId?: string | null
    /** Unique per organization; makes the write idempotent (see onConflictDoNothing below). */
    dedupKey: string
    occurredAt?: Date
    detail?: Record<string, unknown>
    /**
     * Use when the caller already knows the ACTUAL total cost of this unit of work (e.g. a
     * provider like Apify reports back what a scrape run really cost), rather than a
     * quantity to be priced against the local price book. When set, `amountMicros` is
     * taken verbatim from this value instead of `round(quantity * unitCostMicros)` — a
     * provider that reports its own actual spend is a better source of truth than any
     * local rate row, and the ledger must not overwrite that known figure with an
     * estimate. `unitCostMicros` is still derived (round(amountMicrosOverride / quantity),
     * or 0 when quantity is 0) purely so the per-unit figure stays meaningful for
     * reporting; it is never used to compute `amountMicros` in this path. `rate_missing`
     * is deliberately NOT set even though no price-book rate is resolved/used — the cost
     * isn't missing, it's just not sourced from the price book.
     */
    amountMicrosOverride?: number
}

export interface RecordCostResult {
    /** True only if this call actually inserted a new row (false on dedup no-op or error). */
    written: boolean
    /** True if no price-book rate could be resolved; the entry (if written) was zero-priced. */
    rateMissing: boolean
    unitCostMicros: number
    amountMicros: number
    entry: OutreachCostEntry | null
    error?: unknown
}

/**
 * Resolve the rate, compute and freeze amountMicros = round(quantity * unitCostMicros),
 * and insert one append-only ledger row.
 *
 * - Idempotent: `dedupKey` is unique per organization, and the insert uses
 *   `onConflictDoNothing` on (organizationId, dedupKey), so re-recording the same unit
 *   of work (e.g. a retried job) never double-bills it.
 * - If no rate is found, still writes the entry with unitCostMicros=0, amountMicros=0
 *   and detail.rate_missing=true, so unpriced usage is visible in the ledger rather than
 *   silently dropped.
 * - If `amountMicrosOverride` is set, the price book is not consulted at all: the caller
 *   already knows the actual total cost (e.g. a provider like Apify reporting back what a
 *   run really cost), which is a better source than any local rate, so it is written
 *   verbatim instead of being estimated. See `RecordCostInput.amountMicrosOverride`.
 * - Never throws: telemetry/accounting must not be able to break the caller's actual
 *   work. A failure is caught, logged, and returned as an unwritten result.
 */
export async function recordCost(db: DbClient, input: RecordCostInput): Promise<RecordCostResult> {
    try {
        const quantity = typeof input.quantity === 'string' ? Number(input.quantity) : input.quantity
        if (!Number.isFinite(quantity)) {
            throw new Error(`recordCost: quantity did not parse to a finite number (got ${JSON.stringify(input.quantity)})`)
        }

        const occurredAt = input.occurredAt ?? new Date()

        let rate: OutreachCostRate | null = null
        let rateMissing = false
        let unitCostMicros: number
        let amountMicros: number
        let detail: Record<string, unknown>

        if (input.amountMicrosOverride !== undefined) {
            // Provider-reported actual cost: never resolve/consult the price book, and never
            // invent a unit price — unitCostMicros here is derived purely for reporting.
            amountMicros = input.amountMicrosOverride
            unitCostMicros = quantity > 0 ? Math.round(amountMicros / quantity) : 0
            detail = { ...(input.detail ?? {}), cost_source: 'provider_reported' }
        } else {
            rate = await resolveRate(db, {
                organizationId: input.organizationId,
                category: input.category,
                unit: input.unit,
                provider: input.provider ?? null,
                model: input.model ?? null,
                at: occurredAt,
            })

            rateMissing = rate === null
            unitCostMicros = rate ? rate.unitCostMicros : 0
            amountMicros = rateMissing ? 0 : Math.round(quantity * unitCostMicros)

            detail = rateMissing
                ? { ...(input.detail ?? {}), rate_missing: true }
                : (input.detail ?? {})
        }

        const inserted = await db
            .insert(outreachCostEntries)
            .values({
                organizationId: input.organizationId,
                occurredAt,
                category: input.category,
                basis: input.basis,
                quantity: String(quantity),
                unit: input.unit,
                unitCostMicros,
                amountMicros,
                rateId: rate?.id ?? null,
                provider: input.provider ?? null,
                model: input.model ?? null,
                runId: input.runId ?? null,
                campaignId: input.campaignId ?? null,
                emailAccountId: input.emailAccountId ?? null,
                aiRunId: input.aiRunId ?? null,
                assessmentId: input.assessmentId ?? null,
                dedupKey: input.dedupKey,
                detail: jsonbParam(detail),
            })
            .onConflictDoNothing({ target: [outreachCostEntries.organizationId, outreachCostEntries.dedupKey] })
            .returning()

        const entry = inserted[0] ?? null
        return { written: entry !== null, rateMissing, unitCostMicros, amountMicros, entry }
    } catch (error) {
        console.error('[outreach-costs] failed to record cost entry', {
            organizationId: input.organizationId,
            dedupKey: input.dedupKey,
            error,
        })
        return { written: false, rateMissing: false, unitCostMicros: 0, amountMicros: 0, entry: null, error }
    }
}

// ============================================================
// Formatting helpers
// ============================================================

export function microsToUsd(micros: number): number {
    return micros / 1_000_000
}

export function formatUsd(micros: number): string {
    return `$${microsToUsd(micros).toFixed(4)}`
}
