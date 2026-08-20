import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyAdvisory } from '../../../lib/prospecting/advisory'

/**
 * Pure unit tests — no DB. Everything the route touches through `db` (insert/query/update
 * chains), `requireOutreachWrite`, `recordCost`, `recordRunEvent`, and `loadAdvisory` is
 * mocked, following the vi.hoisted + vi.mock('../../../db', ...) convention from
 * measureProspectingOutcomes.test.ts. This suite exercises what the DB-backed
 * prospecting-external-runs.db.test.ts cannot cheaply cover: the `ingestedCount`/
 * `importedCount` resolution actually reaching storage, and the advisory field's
 * never-break contract (TASK 3) on both the created (201) and idempotent-replay (200)
 * response paths.
 */

const insertReturningMock = vi.hoisted(() => vi.fn())
const findFirstMock = vi.hoisted(() => vi.fn())
const updateReturningMock = vi.hoisted(() => vi.fn())
const requireOutreachWriteMock = vi.hoisted(() => vi.fn())
const recordCostMock = vi.hoisted(() => vi.fn())
const recordRunEventMock = vi.hoisted(() => vi.fn())
const loadAdvisoryMock = vi.hoisted(() => vi.fn())
const insertValuesSpy = vi.hoisted(() => vi.fn())
const updateSetSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        insert: () => ({
            values: (row: unknown) => {
                insertValuesSpy(row)
                return {
                    onConflictDoNothing: () => ({
                        returning: insertReturningMock,
                    }),
                }
            },
        }),
        query: {
            prospectingRuns: {
                findFirst: findFirstMock,
            },
        },
        update: () => ({
            set: (row: unknown) => {
                updateSetSpy(row)
                return {
                    where: () => ({
                        returning: updateReturningMock,
                    }),
                }
            },
        }),
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

vi.mock('../../../lib/prospecting/advisory', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../lib/prospecting/advisory')>()
    return { ...actual, loadAdvisory: loadAdvisoryMock }
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

const FAKE_ADVISORY = {
    similar_runs: 2,
    scope: 'similar' as const,
    sample: { imported: 10, emailed: 40, replied: 3, bounced: 1, verified_email_rate: 0.5 },
    reply_rate: { point: 0.075, low: 0.02, high: 0.18, n: 40 },
    warnings: [],
}

function createdRun(overrides: Record<string, unknown> = {}) {
    return {
        id: 'run-created-1',
        organizationId: 'org-1',
        provider: 'xcraper',
        idempotencyKey: 'run-alpha',
        status: 'imported',
        searchFilters: { label: 'Bakeries in Denver' },
        discoveredCount: 40,
        importedCount: 30,
        ...overrides,
    }
}

beforeEach(async () => {
    requireOutreachWriteMock.mockResolvedValue({ role: 'admin' })
    recordCostMock.mockResolvedValue(undefined)
    recordRunEventMock.mockResolvedValue(undefined)
    loadAdvisoryMock.mockResolvedValue(FAKE_ADVISORY)
    insertReturningMock.mockResolvedValue([createdRun()])
    updateReturningMock.mockResolvedValue([])
    findFirstMock.mockResolvedValue(undefined)

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

describe('POST /external-runs — ingestedCount / importedCount resolution', () => {
    it('stores ingestedCount into the importedCount column', async () => {
        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            ingestedCount: 30,
        })
        expect(result.status).toBe(201)
        expect(insertValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ importedCount: 30 }))
    })

    it('still accepts the deprecated importedCount alias', async () => {
        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            importedCount: 12,
        })
        expect(result.status).toBe(201)
        expect(insertValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ importedCount: 12 }))
    })

    it('prefers ingestedCount over importedCount when both are sent', async () => {
        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            ingestedCount: 30,
            importedCount: 12,
        })
        expect(result.status).toBe(201)
        expect(insertValuesSpy).toHaveBeenCalledWith(expect.objectContaining({ importedCount: 30 }))
    })
})

describe('POST /external-runs — advisory (TASK 3)', () => {
    it('returns the advisory on the 201 created path', async () => {
        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            ingestedCount: 30,
        })
        expect(result.status).toBe(201)
        expect(result.body.advisory).toEqual(FAKE_ADVISORY)
        expect(loadAdvisoryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            organizationId: 'org-1',
            excludeRunId: 'run-created-1',
        }))
        // Existing response fields are untouched.
        expect(result.body.idempotentReplay).toBe(false)
        expect(result.body.run).toEqual(createdRun())
    })

    it('falls back to the empty advisory shape when loadAdvisory throws, without failing the request', async () => {
        loadAdvisoryMock.mockRejectedValueOnce(new Error('boom'))
        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            ingestedCount: 30,
        })
        expect(result.status).toBe(201)
        expect(result.body.advisory).toEqual(emptyAdvisory())
        expect(result.body.run).toEqual(createdRun())
    })

    it('returns the advisory on the 200 idempotent-replay path too', async () => {
        insertReturningMock.mockResolvedValueOnce([])
        const replayRow = createdRun({ id: 'run-existing-1', importedCount: 5 })
        findFirstMock.mockResolvedValueOnce(replayRow)
        updateReturningMock.mockResolvedValueOnce([{ ...replayRow, importedCount: 30 }])

        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            ingestedCount: 30,
        })
        expect(result.status).toBe(200)
        expect(result.body.idempotentReplay).toBe(true)
        expect(result.body.advisory).toEqual(FAKE_ADVISORY)
        expect(loadAdvisoryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            organizationId: 'org-1',
            excludeRunId: 'run-existing-1',
        }))
    })

    it('falls back to the empty advisory shape on the replay path when loadAdvisory throws', async () => {
        insertReturningMock.mockResolvedValueOnce([])
        const replayRow = createdRun({ id: 'run-existing-1', importedCount: 5 })
        findFirstMock.mockResolvedValueOnce(replayRow)
        updateReturningMock.mockResolvedValueOnce([{ ...replayRow, importedCount: 30 }])
        loadAdvisoryMock.mockRejectedValueOnce(new Error('boom'))

        const result = await post('/external-runs?organizationId=org-1', {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            ingestedCount: 30,
        })
        expect(result.status).toBe(200)
        expect(result.body.idempotentReplay).toBe(true)
        expect(result.body.advisory).toEqual(emptyAdvisory())
    })
})
