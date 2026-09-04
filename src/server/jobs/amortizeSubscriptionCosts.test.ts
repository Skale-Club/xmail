import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. `queryClient` (account listing) and `recordCost` (ledger
 * write) are both mocked; see src/server/lib/__tests__/outreach-costs.test.ts for
 * recordCost's own coverage and src/server/jobs/enforceDeliverabilityGuardrails.test.ts
 * for the sibling job-test placement convention this file follows.
 */

const queryClientMock = vi.hoisted(() => vi.fn())
const recordCostMock = vi.hoisted(() => vi.fn())

vi.mock('../../db', () => ({ db: {}, queryClient: queryClientMock }))
vi.mock('../lib/outreach-costs', () => ({ recordCost: recordCostMock }))

import {
    amortizeSubscriptionCosts,
    inboxSubscriptionDedupKey,
    monthKeyUtc,
    startOfMonthUtc,
} from './amortizeSubscriptionCosts'

interface FakeAccountRow {
    id: string
    organizationId: string
    email: string
    provider: string
    mailboxProvider: string | null
}

function accountRow(overrides: Partial<FakeAccountRow> = {}): FakeAccountRow {
    return {
        id: 'acct-1',
        organizationId: 'org-1',
        email: 'a@example.com',
        provider: 'smtp',
        mailboxProvider: 'icemail',
        ...overrides,
    }
}

function costResult(overrides: Partial<{ written: boolean; rateMissing: boolean }> = {}) {
    return {
        written: true,
        rateMissing: false,
        unitCostMicros: 2_500_000,
        amountMicros: 2_500_000,
        entry: {},
        ...overrides,
    }
}

beforeEach(() => {
    queryClientMock.mockReset()
    recordCostMock.mockReset()
})

describe('startOfMonthUtc', () => {
    it('returns the first instant of the month, in UTC, regardless of day/time passed in', () => {
        expect(startOfMonthUtc(new Date('2026-08-13T23:59:59.999Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z')
        expect(startOfMonthUtc(new Date('2026-08-01T00:00:00.001Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z')
        expect(startOfMonthUtc(new Date('2026-08-31T23:59:59.999Z')).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    })
})

describe('monthKeyUtc / inboxSubscriptionDedupKey', () => {
    it('formats the month key as YYYY-MM in UTC, zero-padded', () => {
        expect(monthKeyUtc(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01')
        expect(monthKeyUtc(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12')
    })

    it('produces exactly inbox:<emailAccountId>:<YYYY-MM>', () => {
        expect(inboxSubscriptionDedupKey('acct-1', new Date('2026-08-13T12:00:00.000Z'))).toBe('inbox:acct-1:2026-08')
    })

    it('is stable for two dates in the same month and differs across months', () => {
        const early = inboxSubscriptionDedupKey('acct-1', new Date('2026-08-01T00:00:00.000Z'))
        const late = inboxSubscriptionDedupKey('acct-1', new Date('2026-08-31T23:59:59.999Z'))
        const nextMonth = inboxSubscriptionDedupKey('acct-1', new Date('2026-09-01T00:00:00.000Z'))

        expect(early).toBe(late)
        expect(early).not.toBe(nextMonth)
    })
})

describe('amortizeSubscriptionCosts', () => {
    it('passes a null mailboxProvider through as null rather than defaulting it', async () => {
        queryClientMock.mockResolvedValue([accountRow({ mailboxProvider: null })])
        recordCostMock.mockResolvedValue(costResult())

        await amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))

        expect(recordCostMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: null }))
    })

    it('records a native account (provider=native) with cost-provider "native", regardless of mailboxProvider', async () => {
        // mailbox_provider defaults to 'manual' in the schema for every native account (it was
        // never set to anything else) — the job must key off `provider`, not this label.
        queryClientMock.mockResolvedValue([accountRow({ provider: 'native', mailboxProvider: 'manual' })])
        recordCostMock.mockResolvedValue(costResult())

        await amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))

        expect(recordCostMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: 'native' }))
    })

    it('still records an icemail (provider=smtp) account with cost-provider "icemail"', async () => {
        queryClientMock.mockResolvedValue([accountRow({ provider: 'smtp', mailboxProvider: 'icemail' })])
        recordCostMock.mockResolvedValue(costResult())

        await amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))

        expect(recordCostMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ provider: 'icemail' }))
    })

    it('does not let mailbox_provider="manual" leak into the cost entry for a native account', async () => {
        queryClientMock.mockResolvedValue([accountRow({ provider: 'native', mailboxProvider: 'manual' })])
        recordCostMock.mockResolvedValue(costResult())

        await amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))

        const call = recordCostMock.mock.calls[0][1]
        expect(call.provider).not.toBe('manual')
        expect(call.provider).toBe('native')
    })

    it('pins occurredAt to the first instant of the billing month, not now()', async () => {
        queryClientMock.mockResolvedValue([accountRow({ id: 'acct-1' })])
        recordCostMock.mockResolvedValue(costResult())

        await amortizeSubscriptionCosts(new Date('2026-08-13T18:30:00.000Z'))

        expect(recordCostMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            occurredAt: new Date('2026-08-01T00:00:00.000Z'),
            dedupKey: 'inbox:acct-1:2026-08',
            category: 'inbox_subscription',
            basis: 'amortized',
            quantity: 1,
            unit: 'month',
            emailAccountId: 'acct-1',
            organizationId: 'org-1',
        }))
    })

    it('re-running within the same month resolves the same occurredAt/dedupKey (idempotent input)', async () => {
        queryClientMock.mockResolvedValue([accountRow({ id: 'acct-1' })])
        recordCostMock.mockResolvedValue(costResult())

        await amortizeSubscriptionCosts(new Date('2026-08-02T01:00:00.000Z'))
        await amortizeSubscriptionCosts(new Date('2026-08-29T23:00:00.000Z'))

        const calls = recordCostMock.mock.calls.map((call) => call[1])
        expect(calls[0].occurredAt).toEqual(calls[1].occurredAt)
        expect(calls[0].dedupKey).toBe(calls[1].dedupKey)
    })

    it('counts written vs duplicate-skipped and rate-missing entries correctly', async () => {
        queryClientMock.mockResolvedValue([
            accountRow({ id: 'acct-1' }),
            accountRow({ id: 'acct-2' }),
            accountRow({ id: 'acct-3' }),
        ])
        recordCostMock
            .mockResolvedValueOnce(costResult({ written: true, rateMissing: false }))
            .mockResolvedValueOnce(costResult({ written: false, rateMissing: false }))
            .mockResolvedValueOnce(costResult({ written: true, rateMissing: true }))

        const summary = await amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ accounts: 3, written: 2, duplicates: 1, rateMissing: 1 })
    })

    it('does not throw when recordCost reports an error result (never propagates)', async () => {
        queryClientMock.mockResolvedValue([accountRow()])
        recordCostMock.mockResolvedValue({
            written: false,
            rateMissing: false,
            unitCostMicros: 0,
            amountMicros: 0,
            entry: null,
            error: new Error('boom'),
        })

        await expect(amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))).resolves.toEqual({
            accounts: 1, written: 0, duplicates: 1, rateMissing: 0,
        })
    })

    it('does not throw and reports zero counts when the account-listing query itself fails', async () => {
        queryClientMock.mockRejectedValue(new Error('db unreachable'))

        await expect(amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))).resolves.toEqual({
            accounts: 0, written: 0, duplicates: 0, rateMissing: 0,
        })
        expect(recordCostMock).not.toHaveBeenCalled()
    })

    it('processes zero accounts cleanly when the account list is empty', async () => {
        queryClientMock.mockResolvedValue([])

        const summary = await amortizeSubscriptionCosts(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ accounts: 0, written: 0, duplicates: 0, rateMissing: 0 })
        expect(recordCostMock).not.toHaveBeenCalled()
    })
})
