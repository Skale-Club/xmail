import { describe, expect, it, vi } from 'vitest'
import {
    formatUsd,
    microsToUsd,
    pickApplicableRate,
    recordCost,
    resolveRate,
    type DbClient,
    type RecordCostInput,
} from '../outreach-costs'
import type { OutreachCostRate } from '../../../db/schema'
import { jsonbParam } from '../jsonb'

const AT = new Date('2026-08-13T12:00:00.000Z')

function rateRow(overrides: Partial<OutreachCostRate> = {}): OutreachCostRate {
    return {
        id: 'rate-default',
        organizationId: null,
        category: 'llm_tokens',
        unit: 'token',
        provider: 'openai',
        model: 'gpt-4o',
        unitCostMicros: 75,
        currency: 'usd',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    }
}

/** Fake DbClient covering the select().from().where() and insert().values().onConflictDoNothing().returning() chains. */
function fakeDb(options: {
    rateRows?: OutreachCostRate[]
    conflict?: boolean
    throwOnSelect?: boolean
    throwOnInsert?: boolean
} = {}) {
    const where = vi.fn(async () => {
        if (options.throwOnSelect) throw new Error('select exploded')
        return options.rateRows ?? []
    })
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))

    let insertedRow: Record<string, unknown> | undefined
    const returning = vi.fn(async () => {
        if (options.throwOnInsert) throw new Error('insert exploded')
        if (options.conflict) return []
        return insertedRow ? [{ id: 'entry-1', createdAt: new Date('2026-08-13T00:00:00.000Z'), ...insertedRow }] : []
    })
    const onConflictDoNothing = vi.fn(() => ({ returning }))
    const values = vi.fn((row: Record<string, unknown>) => {
        insertedRow = row
        return { onConflictDoNothing }
    })
    const insert = vi.fn(() => ({ values }))

    return {
        db: { select, insert } as unknown as DbClient,
        select,
        from,
        where,
        insert,
        values,
        onConflictDoNothing,
        returning,
    }
}

function costInput(overrides: Partial<RecordCostInput> = {}): RecordCostInput {
    return {
        organizationId: 'org-1',
        category: 'llm_tokens',
        basis: 'actual',
        quantity: 12_000,
        unit: 'token',
        provider: 'openai',
        model: 'gpt-4o',
        dedupKey: 'assessment:cand-1',
        occurredAt: AT,
        ...overrides,
    }
}

describe('pickApplicableRate', () => {
    it('prefers an org-specific row over the platform default', () => {
        const platform = rateRow({ id: 'platform', organizationId: null })
        const org = rateRow({ id: 'org', organizationId: 'org-1' })

        expect(pickApplicableRate([platform, org], 'org-1', AT)?.id).toBe('org')
        // Order in the candidate array must not matter.
        expect(pickApplicableRate([org, platform], 'org-1', AT)?.id).toBe('org')
    })

    it('excludes a row whose validity window has expired', () => {
        const expired = rateRow({
            id: 'expired',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validTo: new Date('2026-06-01T00:00:00.000Z'),
        })

        expect(pickApplicableRate([expired], 'org-1', AT)).toBeNull()
    })

    it('excludes a row that has not started yet (validFrom in the future)', () => {
        const notYetStarted = rateRow({ id: 'future', validFrom: new Date('2027-01-01T00:00:00.000Z') })

        expect(pickApplicableRate([notYetStarted], 'org-1', AT)).toBeNull()
    })

    it('includes a row with no validTo (open-ended) as long as validFrom has passed', () => {
        const openEnded = rateRow({ id: 'open-ended', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: null })

        expect(pickApplicableRate([openEnded], 'org-1', AT)?.id).toBe('open-ended')
    })

    it('breaks a tie between overlapping same-scope rows by the greatest validFrom', () => {
        const older = rateRow({ id: 'older', organizationId: 'org-1', validFrom: new Date('2026-01-01T00:00:00.000Z') })
        const newer = rateRow({ id: 'newer', organizationId: 'org-1', validFrom: new Date('2026-07-01T00:00:00.000Z') })

        expect(pickApplicableRate([older, newer], 'org-1', AT)?.id).toBe('newer')
        expect(pickApplicableRate([newer, older], 'org-1', AT)?.id).toBe('newer')
    })

    it('returns null when nothing matches', () => {
        expect(pickApplicableRate([], 'org-1', AT)).toBeNull()
    })
})

describe('resolveRate', () => {
    it('delegates to pickApplicableRate over whatever the query returns', async () => {
        const platform = rateRow({ id: 'platform', organizationId: null })
        const org = rateRow({ id: 'org', organizationId: 'org-1' })
        const { db, select } = fakeDb({ rateRows: [platform, org] })

        const resolved = await resolveRate(db, {
            organizationId: 'org-1',
            category: 'llm_tokens',
            unit: 'token',
            provider: 'openai',
            model: 'gpt-4o',
            at: AT,
        })

        expect(select).toHaveBeenCalledTimes(1)
        expect(resolved?.id).toBe('org')
    })

    it('returns null when the query finds nothing', async () => {
        const { db } = fakeDb({ rateRows: [] })

        const resolved = await resolveRate(db, {
            organizationId: 'org-1',
            category: 'lead_source',
            unit: 'credit',
            at: AT,
        })

        expect(resolved).toBeNull()
    })
})

describe('recordCost', () => {
    it('computes amountMicros = round(quantity * unitCostMicros), including a fractional case', async () => {
        const { db, values } = fakeDb({ rateRows: [rateRow({ id: 'rate-1', unitCostMicros: 75 })] })

        const result = await recordCost(db, costInput({ quantity: 12_000 }))

        expect(result.written).toBe(true)
        expect(result.rateMissing).toBe(false)
        expect(result.unitCostMicros).toBe(75)
        expect(result.amountMicros).toBe(900_000)
        expect(values).toHaveBeenCalledWith(expect.objectContaining({
            unitCostMicros: 75,
            amountMicros: 900_000,
            quantity: '12000',
        }))
    })

    it('rounds a fractional product to the nearest whole micro', async () => {
        const { db } = fakeDb({ rateRows: [rateRow({ id: 'rate-1', unitCostMicros: 3 })] })

        // 100.5 * 3 = 301.5 -> rounds to 302
        const result = await recordCost(db, costInput({ quantity: 100.5 }))

        expect(result.amountMicros).toBe(302)
    })

    it('accepts a string quantity (as Drizzle numeric columns read back)', async () => {
        const { db } = fakeDb({ rateRows: [rateRow({ id: 'rate-1', unitCostMicros: 75 })] })

        const result = await recordCost(db, costInput({ quantity: '12000' }))

        expect(result.amountMicros).toBe(900_000)
    })

    it('writes a zero-priced entry with rate_missing=true when no rate resolves, without throwing', async () => {
        const { db, values } = fakeDb({ rateRows: [] })

        const result = await recordCost(db, costInput())

        expect(result.written).toBe(true)
        expect(result.rateMissing).toBe(true)
        expect(result.unitCostMicros).toBe(0)
        expect(result.amountMicros).toBe(0)
        expect(values).toHaveBeenCalledWith(expect.objectContaining({
            unitCostMicros: 0,
            amountMicros: 0,
            detail: jsonbParam({ rate_missing: true }),
        }))
    })

    it('preserves caller-supplied detail alongside rate_missing', async () => {
        const { db, values } = fakeDb({ rateRows: [] })

        await recordCost(db, costInput({ detail: { note: 'pre-launch estimate' } }))

        expect(values).toHaveBeenCalledWith(expect.objectContaining({
            detail: jsonbParam({ note: 'pre-launch estimate', rate_missing: true }),
        }))
    })

    it('reports written=false (no throw) when onConflictDoNothing skips a duplicate dedupKey', async () => {
        const { db } = fakeDb({ rateRows: [rateRow()], conflict: true })

        const result = await recordCost(db, costInput())

        expect(result.written).toBe(false)
        expect(result.entry).toBeNull()
    })

    it('never throws: a DB failure is caught and reported as an unwritten result', async () => {
        const { db } = fakeDb({ throwOnSelect: true })

        const result = await recordCost(db, costInput())

        expect(result.written).toBe(false)
        expect(result.entry).toBeNull()
        expect(result.error).toBeInstanceOf(Error)
    })

    it('never throws on an insert-time failure either', async () => {
        const { db } = fakeDb({ rateRows: [rateRow()], throwOnInsert: true })

        const result = await recordCost(db, costInput())

        expect(result.written).toBe(false)
        expect(result.error).toBeInstanceOf(Error)
    })

    describe('amountMicrosOverride (provider-reported actual cost)', () => {
        it('uses the override verbatim as amountMicros instead of quantity * rate, and never queries the price book', async () => {
            const { db, select, values } = fakeDb({ rateRows: [rateRow({ unitCostMicros: 999_999 })] })

            const result = await recordCost(db, costInput({
                category: 'lead_source',
                unit: 'result',
                provider: 'apify',
                quantity: 40,
                amountMicrosOverride: 215_300,
            }))

            expect(select).not.toHaveBeenCalled()
            expect(result.written).toBe(true)
            expect(result.amountMicros).toBe(215_300)
            // unitCostMicros is derived from the override, never from the (unused) rate row.
            expect(result.unitCostMicros).toBe(Math.round(215_300 / 40))
            expect(values).toHaveBeenCalledWith(expect.objectContaining({
                amountMicros: 215_300,
                rateId: null,
            }))
        })

        it('converts a USD cost to micros correctly (0.2153 USD -> 215300 micros)', async () => {
            const { db, values } = fakeDb()
            const costUsd = 0.2153
            const amountMicrosOverride = Math.round(costUsd * 1_000_000)

            const result = await recordCost(db, costInput({
                category: 'lead_source',
                unit: 'result',
                provider: 'apify',
                quantity: 25,
                amountMicrosOverride,
            }))

            expect(amountMicrosOverride).toBe(215_300)
            expect(result.amountMicros).toBe(215_300)
            expect(values).toHaveBeenCalledWith(expect.objectContaining({ amountMicros: 215_300 }))
        })

        it('derives unitCostMicros as round(amountMicrosOverride / quantity)', async () => {
            const { db } = fakeDb()

            // 100 / 3 = 33.33... -> rounds to 33
            const result = await recordCost(db, costInput({ quantity: 3, amountMicrosOverride: 100 }))

            expect(result.unitCostMicros).toBe(33)
            expect(result.amountMicros).toBe(100)
        })

        it('sets unitCostMicros to 0 (not NaN/Infinity) when quantity is 0', async () => {
            const { db, values } = fakeDb()

            const result = await recordCost(db, costInput({ quantity: 0, amountMicrosOverride: 50_000 }))

            expect(result.unitCostMicros).toBe(0)
            expect(result.amountMicros).toBe(50_000)
            expect(values).toHaveBeenCalledWith(expect.objectContaining({ unitCostMicros: 0, amountMicros: 50_000 }))
        })

        it('never sets detail.rate_missing, and instead sets detail.cost_source = provider_reported', async () => {
            const { db, values } = fakeDb()

            await recordCost(db, costInput({ amountMicrosOverride: 12_345, detail: { runId: 'run-1' } }))

            expect(values).toHaveBeenCalledWith(expect.objectContaining({
                detail: jsonbParam({ runId: 'run-1', cost_source: 'provider_reported' }),
            }))
        })

        it('still dedupes via onConflictDoNothing (idempotent replay never double-bills)', async () => {
            const { db } = fakeDb({ conflict: true })

            const result = await recordCost(db, costInput({ amountMicrosOverride: 215_300 }))

            expect(result.written).toBe(false)
            expect(result.entry).toBeNull()
        })
    })
})

describe('microsToUsd / formatUsd', () => {
    it('converts micros to dollars', () => {
        expect(microsToUsd(900_000)).toBe(0.9)
        expect(microsToUsd(1_000_000)).toBe(1)
        expect(microsToUsd(0)).toBe(0)
    })

    it('formats micros as a USD string with 4 decimal places', () => {
        expect(formatUsd(900_000)).toBe('$0.9000')
        expect(formatUsd(1_000_000)).toBe('$1.0000')
        expect(formatUsd(0)).toBe('$0.0000')
        expect(formatUsd(12_345)).toBe('$0.0123')
    })
})
