import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Covers Fase 37's GET /api/outreach/leads/lookup: the endpoint that
 * lets Xphere's prospects_enroll_in_campaign resolve an existing lead id from an email address
 * without calling the bulk-import endpoint (which also enrols and can activate). See
 * docs/xphere-xmail-contract.md "Endpoint 5".
 */

const findManyMock = vi.hoisted(() => vi.fn())
const requireOutreachReadMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            leads: { findMany: findManyMock },
            leadLists: { findMany: vi.fn() },
        },
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachRead: requireOutreachReadMock,
    requireOutreachWrite: vi.fn(),
}))

const ORG_ID = '11111111-1111-1111-1111-111111111111'

let server: http.Server
let baseUrl: string

// `userId` defaults to a header-bearing request. Pass `null` explicitly (not `undefined` — a
// default parameter treats an explicit `undefined` the same as omitting the argument) to send
// the request with no x-user-id header at all.
async function get(pathname: string, userId: string | null = 'user-1') {
    const headers: Record<string, string> = {}
    if (userId) headers['x-user-id'] = userId
    const response = await fetch(`${baseUrl}${pathname}`, { headers })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeEach(async () => {
    requireOutreachReadMock.mockResolvedValue({ role: 'admin' })
    findManyMock.mockResolvedValue([])

    const leadsRouter = (await import('../leads')).default
    const app = express()
    app.use(express.json())
    app.use('/', leadsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
    vi.clearAllMocks()
})

describe('GET /leads/lookup', () => {
    it('splits requested emails into found and missing', async () => {
        findManyMock.mockResolvedValue([
            { id: 'lead-1', email: 'a@b.com', status: 'new', emailVerificationStatus: 'verified' },
        ])

        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=a@b.com,c@d.com`)

        expect(result.status).toBe(200)
        expect(result.body).toEqual({
            found: [{ email: 'a@b.com', leadId: 'lead-1', status: 'new', emailVerificationStatus: 'verified' }],
            missing: ['c@d.com'],
        })
    })

    it('matches case-insensitively and normalizes the returned email to lowercase', async () => {
        findManyMock.mockResolvedValue([
            { id: 'lead-1', email: 'a@b.com', status: 'new', emailVerificationStatus: 'verified' },
        ])

        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=${encodeURIComponent('A@B.com')}`)

        expect(result.status).toBe(200)
        expect(result.body.found).toEqual([{ email: 'a@b.com', leadId: 'lead-1', status: 'new', emailVerificationStatus: 'verified' }])
        // The query sent to the DB layer must already be lowercased, since leads.email is
        // stored lowercased (migration 052 CHECK constraint) and the match is exact.
        expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }))
    })

    it('deduplicates a repeated email in the request', async () => {
        findManyMock.mockResolvedValue([])

        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=a@b.com,a@b.com,A@B.COM`)

        expect(result.status).toBe(200)
        expect(result.body.missing).toEqual(['a@b.com'])
    })

    it('rejects more than 100 emails with 400', async () => {
        const emails = Array.from({ length: 101 }, (_, i) => `user${i}@example.com`).join(',')

        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=${emails}`)

        expect(result.status).toBe(400)
        expect(findManyMock).not.toHaveBeenCalled()
    })

    it('accepts exactly 100 emails', async () => {
        findManyMock.mockResolvedValue([])
        const emails = Array.from({ length: 100 }, (_, i) => `user${i}@example.com`).join(',')

        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=${emails}`)

        expect(result.status).toBe(200)
    })

    it('requires an authenticated user', async () => {
        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=a@b.com`, null)

        expect(result.status).toBe(401)
        expect(findManyMock).not.toHaveBeenCalled()
    })

    it('enforces the same outreach-read authorization as its siblings (service-key principal supported by requireOutreachRead)', async () => {
        requireOutreachReadMock.mockImplementation(async (_req: unknown, res: any) => {
            res.status(403).json({ error: 'Forbidden' })
            return null
        })

        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=a@b.com`)

        expect(result.status).toBe(403)
        expect(findManyMock).not.toHaveBeenCalled()
    })

    it('rejects an empty emails value', async () => {
        const result = await get(`/lookup?organizationId=${ORG_ID}&emails=,,`)

        expect(result.status).toBe(400)
    })

    it('requires a valid organizationId', async () => {
        const result = await get('/lookup?organizationId=not-a-uuid&emails=a@b.com')

        expect(result.status).toBe(400)
    })
})
