import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Defeito 2 (2026-09-30) defense in depth: POST /:campaignId/leads
 * must refuse to enroll a lead whose email belongs to a scheduling/marketplace platform (Booksy
 * support etc — see ../../../lib/platform-emails.ts), even when that lead already made it into
 * the `leads` table before this guard existed at import time. Mirrors the enrollmentBreakdown
 * pattern already used for `skipped_invalid`.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111'
const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222'
const LEGIT_LEAD_ID = '44444444-4444-4444-4444-444444444444'
const PLATFORM_LEAD_ID = '55555555-5555-5555-5555-555555555555'

const campaignsFindFirstMock = vi.hoisted(() => vi.fn())
const leadsFindManyMock = vi.hoisted(() => vi.fn())
const campaignLeadsFindManyMock = vi.hoisted(() => vi.fn())
const transactionMock = vi.hoisted(() => vi.fn())
const requireOutreachWriteMock = vi.hoisted(() => vi.fn())
const getCanonicalSequenceMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            campaigns: { findFirst: campaignsFindFirstMock },
            leads: { findMany: leadsFindManyMock },
            campaignLeads: { findMany: campaignLeadsFindManyMock },
            emailAccounts: { findFirst: vi.fn() },
        },
        transaction: transactionMock,
        select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) }),
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachWrite: requireOutreachWriteMock,
    requireOutreachRead: vi.fn(),
}))

vi.mock('../../../lib/outreach-sequences', () => ({
    getCanonicalSequence: getCanonicalSequenceMock,
    replaceCanonicalSequence: vi.fn(),
    deleteSequenceStep: vi.fn(),
    sequencePayloadSchema: { parse: vi.fn() },
}))

let server: http.Server
let baseUrl: string

async function post(pathname: string, body: unknown) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeEach(async () => {
    // campaigns.ts transitively imports outreach-approval-preview.ts -> unsubscribe.ts ->
    // outreach-tokens.ts, which throws at module load if neither ENCRYPTION_KEY nor
    // JWT_SECRET is set (it fails loud on purpose — see that file's own comment). Never
    // touches a real secret; this only satisfies the module's load-time guard.
    process.env.ENCRYPTION_KEY ||= 'test-encryption-key'

    vi.clearAllMocks()
    requireOutreachWriteMock.mockResolvedValue({ role: 'admin' })
    campaignsFindFirstMock.mockResolvedValue({
        id: CAMPAIGN_ID,
        organizationId: ORG_ID,
        status: 'draft',
    })
    campaignLeadsFindManyMock.mockResolvedValue([]) // no pre-existing enrollment
    getCanonicalSequenceMock.mockResolvedValue({ steps: [{ id: 'step-1', stepOrder: 1 }] })
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
        execute: () => Promise.resolve([{ status: 'draft' }]),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        insert: () => ({
            values: () => ({
                returning: () => Promise.resolve([{ id: 'cl-1', leadId: LEGIT_LEAD_ID }]),
            }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    }))

    const campaignsRouter = (await import('../campaigns')).default
    const app = express()
    app.use(express.json())
    app.use('/', campaignsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Loading campaigns.ts's whole module graph cold can take longer than the default 10s
    // hook timeout on a loaded machine — this only pays that cost once per file.
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('POST /:campaignId/leads — platform-email defense in depth', () => {
    it('skips a platform-email lead (help.us@booksy.com) and reports it separately, enrolling only the legitimate lead', async () => {
        leadsFindManyMock.mockResolvedValueOnce([
            { id: LEGIT_LEAD_ID, email: 'owner@realbarbershop.test', emailVerificationStatus: 'verified' },
            { id: PLATFORM_LEAD_ID, email: 'help.us@booksy.com', emailVerificationStatus: 'verified' },
        ])

        const result = await post(`/${CAMPAIGN_ID}/leads`, {
            leadIds: [LEGIT_LEAD_ID, PLATFORM_LEAD_ID],
        })

        expect(result.status).toBe(201)
        expect(result.body.added).toBe(1)
        expect(result.body.skipped_platform_email).toBe(1)
        expect(result.body.campaignLeads).toEqual([{ id: 'cl-1', leadId: LEGIT_LEAD_ID }])
    })

    it('reports 200 with zero added when every requested lead is a platform email (idempotent, no 500)', async () => {
        leadsFindManyMock.mockResolvedValueOnce([
            { id: PLATFORM_LEAD_ID, email: 'help.us@booksy.com', emailVerificationStatus: 'verified' },
        ])

        const result = await post(`/${CAMPAIGN_ID}/leads`, {
            leadIds: [PLATFORM_LEAD_ID],
        })

        expect(result.status).toBe(200)
        expect(result.body.added).toBe(0)
        expect(result.body.skipped_platform_email).toBe(1)
        expect(transactionMock).not.toHaveBeenCalled()
    })
})
