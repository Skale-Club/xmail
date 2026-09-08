import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Mirrors prospecting-external-runs.test.ts's mocking style:
 * `db.query.prospectingRuns.findFirst`, `db.transaction`, `requireOutreachWrite`,
 * `recordCost` and `recordRunEvent` are all mocked so this suite exercises the route's
 * own logic (lookup/404, idempotency-by-detail, the checked-arithmetic 400, response
 * shape) without a live database. The DB-backed guarantees this cannot cheaply cover
 * (the seeded 056 rate actually pricing the entry, the unique advisory-lock behavior
 * under real concurrency) belong in a .db.test.ts, same split as the sibling route.
 */

const findFirstRunMock = vi.hoisted(() => vi.fn())
const findFirstEventMock = vi.hoisted(() => vi.fn())
const findFirstCostEntryMock = vi.hoisted(() => vi.fn())
const transactionMock = vi.hoisted(() => vi.fn())
const txExecuteMock = vi.hoisted(() => vi.fn())
const updateSetSpy = vi.hoisted(() => vi.fn())
const requireOutreachWriteMock = vi.hoisted(() => vi.fn())
const recordCostMock = vi.hoisted(() => vi.fn())
const recordRunEventMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            prospectingRuns: { findFirst: findFirstRunMock },
        },
        transaction: transactionMock,
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachWrite: requireOutreachWriteMock,
    requireOutreachRead: vi.fn(),
}))

vi.mock('../../../lib/outreach-costs', () => ({
    recordCost: recordCostMock,
}))

vi.mock('../../../lib/prospecting/journey', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../lib/prospecting/journey')>()
    return { ...actual, recordRunEvent: recordRunEventMock }
})

let server: http.Server
let baseUrl: string

async function post(pathname: string, body: unknown, userId: string = 'user-1') {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

function runRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'run-1',
        organizationId: 'org-1',
        provider: 'xcraper',
        idempotencyKey: 'ext-run-1',
        discoveredCount: 100,
        ...overrides,
    }
}

const VALID_BODY = {
    provider: 'xcraper',
    checked: 98,
    ok: 69,
    catchAll: 9,
    unknown: 2,
    invalid: 18,
    creditsUsed: 38,
    verificationProvider: 'millionverifier',
    verifiedAt: '2026-09-08T12:00:00.000Z',
}

/** Builds the tx object handed to the `db.transaction(async (tx) => ...)` callback. */
function fakeTx() {
    return {
        execute: txExecuteMock,
        query: {
            prospectingRunEvents: { findFirst: findFirstEventMock },
            outreachCostEntries: { findFirst: findFirstCostEntryMock },
        },
        update: () => ({
            set: (row: unknown) => {
                updateSetSpy(row)
                return { where: () => Promise.resolve(undefined) }
            },
        }),
    }
}

beforeEach(async () => {
    requireOutreachWriteMock.mockResolvedValue({ role: 'admin' })
    findFirstRunMock.mockResolvedValue(runRow())
    txExecuteMock.mockResolvedValue(undefined)
    findFirstEventMock.mockResolvedValue(undefined)
    findFirstCostEntryMock.mockResolvedValue(undefined)
    recordRunEventMock.mockResolvedValue(undefined)
    recordCostMock.mockResolvedValue({ written: true, rateMissing: false, unitCostMicros: 3700, amountMicros: 140_600, entry: { id: 'cost-1' } })
    transactionMock.mockImplementation((fn: (tx: unknown) => unknown) => fn(fakeTx()))

    const prospectingRouter = (await import('../prospecting')).default
    const app = express()
    app.use(express.json())
    app.use('/', prospectingRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('POST /external-runs/:externalRunId/verification', () => {
    it('404s when no prospecting run matches provider + externalRunId in this organization', async () => {
        findFirstRunMock.mockResolvedValueOnce(undefined)
        const result = await post('/external-runs/ext-run-1/verification?organizationId=org-1', VALID_BODY)
        expect(result.status).toBe(404)
        expect(result.body.error).toBeTruthy()
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('rejects a body where checked does not equal ok + catchAll + unknown + invalid, naming the mismatch', async () => {
        const result = await post('/external-runs/ext-run-1/verification?organizationId=org-1', {
            ...VALID_BODY,
            checked: 99,
        })
        expect(result.status).toBe(400)
        const messages = JSON.stringify(result.body.details)
        expect(messages).toContain('checked')
        expect(messages).toContain('99')
        expect(messages).toContain('98')
    })

    it('201s on first call: records the journey event, the cost entry, and the run counters, inside one transaction', async () => {
        findFirstEventMock.mockResolvedValueOnce(undefined) // no existing event yet
        findFirstEventMock.mockResolvedValueOnce({ id: 'event-1' }) // post-insert lookup

        const result = await post('/external-runs/ext-run-1/verification?organizationId=org-1', VALID_BODY)

        expect(result.status).toBe(201)
        expect(result.body).toEqual({ runId: 'run-1', eventId: 'event-1', costEntryId: 'cost-1' })
        expect(result.body.idempotentReplay).toBeUndefined()

        expect(recordRunEventMock).toHaveBeenCalledTimes(1)
        expect(recordRunEventMock.mock.calls[0][1]).toMatchObject({
            organizationId: 'org-1',
            runId: 'run-1',
            code: 'verify.completed',
            summary: expect.stringContaining('98 checked'),
        })
        expect(recordRunEventMock.mock.calls[0][1].detail).toMatchObject({
            checked: 98,
            ok: 69,
            verifiedEmailRate: 0.69,
        })

        expect(recordCostMock).toHaveBeenCalledTimes(1)
        expect(recordCostMock.mock.calls[0][1]).toMatchObject({
            organizationId: 'org-1',
            category: 'email_verification',
            unit: 'credit',
            basis: 'actual',
            quantity: 38,
            provider: 'millionverifier',
            runId: 'run-1',
            dedupKey: 'email_verification:millionverifier:ext-run-1:2026-09-08T12:00:00.000Z',
        })

        expect(updateSetSpy).toHaveBeenCalledWith(expect.objectContaining({ verifiedOkCount: 69 }))
    })

    it('uses "estimated" basis and quantity=checked when creditsUsed is null', async () => {
        findFirstEventMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'event-2' })

        await post('/external-runs/ext-run-1/verification?organizationId=org-1', { ...VALID_BODY, creditsUsed: null })

        expect(recordCostMock.mock.calls[0][1]).toMatchObject({ basis: 'estimated', quantity: 98 })
    })

    it('collapses verificationProvider "mixed" to millionverifier for the ledger provider, noting it in detail', async () => {
        findFirstEventMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: 'event-3' })

        await post('/external-runs/ext-run-1/verification?organizationId=org-1', { ...VALID_BODY, verificationProvider: 'mixed' })

        expect(recordCostMock.mock.calls[0][1]).toMatchObject({ provider: 'millionverifier' })
        expect(recordCostMock.mock.calls[0][1].detail).toMatchObject({ verification_provider_mixed_collapsed_to: 'millionverifier' })
    })

    it('200s with idempotentReplay on an identical repeat, writing nothing again', async () => {
        findFirstEventMock.mockResolvedValueOnce({ id: 'event-1' })
        findFirstCostEntryMock.mockResolvedValueOnce({ id: 'cost-1' })

        const result = await post('/external-runs/ext-run-1/verification?organizationId=org-1', VALID_BODY)

        expect(result.status).toBe(200)
        expect(result.body).toEqual({ runId: 'run-1', eventId: 'event-1', costEntryId: 'cost-1', idempotentReplay: true })
        expect(recordRunEventMock).not.toHaveBeenCalled()
        expect(recordCostMock).not.toHaveBeenCalled()
        expect(updateSetSpy).not.toHaveBeenCalled()
    })

    it('requires organizationId', async () => {
        const result = await post('/external-runs/ext-run-1/verification', VALID_BODY)
        expect(result.status).toBe(400)
    })
})
