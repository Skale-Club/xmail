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
const emailAccountsFindFirstMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            campaigns: { findFirst: campaignsFindFirstMock },
            leads: { findMany: leadsFindManyMock },
            campaignLeads: { findMany: campaignLeadsFindManyMock },
            emailAccounts: { findFirst: emailAccountsFindFirstMock },
        },
        transaction: transactionMock,
        select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) }),
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachWrite: requireOutreachWriteMock,
    requireOutreachRead: vi.fn(),
}))

vi.mock('../../../lib/outreach-sequences', async (importOriginal) => ({
    // campaigns.ts builds its step schema from the real delayHoursMaxSchema at import time.
    delayHoursMaxSchema: (await importOriginal<typeof import('../../../lib/outreach-sequences')>()).delayHoursMaxSchema,
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

describe('POST /:campaignId/leads: shared enrollment service keeps the panel contract', () => {
    const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333'

    it('refuses a warm-up-only inbox with 422 and enrolls nothing', async () => {
        emailAccountsFindFirstMock.mockResolvedValue({ id: ACCOUNT_ID, email: 'agenda@tryskaleclub.test', warmupOnly: true, status: 'verified' })
        const result = await post(`/${CAMPAIGN_ID}/leads`, { leadIds: [LEGIT_LEAD_ID], emailAccountId: ACCOUNT_ID })
        expect(result.status).toBe(422)
        expect(result.body.error).toMatch(/warm-up-only/)
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('refuses an inbox on a protected company domain with the protected_sending_domain code', async () => {
        process.env.OUTREACH_PROTECTED_DOMAINS = 'xkedule.com'
        try {
            emailAccountsFindFirstMock.mockResolvedValue({ id: ACCOUNT_ID, email: 'info@xkedule.com', warmupOnly: false, status: 'verified' })
            const result = await post(`/${CAMPAIGN_ID}/leads`, { leadIds: [LEGIT_LEAD_ID], emailAccountId: ACCOUNT_ID })
            expect(result.status).toBe(422)
            expect(result.body.code).toBe('protected_sending_domain')
        } finally {
            delete process.env.OUTREACH_PROTECTED_DOMAINS
        }
    })

    it('answers 400 for an inbox that is not in the organization', async () => {
        emailAccountsFindFirstMock.mockResolvedValue(undefined)
        const result = await post(`/${CAMPAIGN_ID}/leads`, { leadIds: [LEGIT_LEAD_ID], emailAccountId: ACCOUNT_ID })
        expect(result.status).toBe(400)
    })

    it('answers 409 when the campaign finishes between the request and the lock', async () => {
        leadsFindManyMock.mockResolvedValueOnce([{ id: LEGIT_LEAD_ID, email: 'owner@realbarbershop.test', emailVerificationStatus: 'verified' }])
        transactionMock.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb({
            execute: () => Promise.resolve([{ status: 'completed' }]),
        }))
        const result = await post(`/${CAMPAIGN_ID}/leads`, { leadIds: [LEGIT_LEAD_ID] })
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('campaign_enrollment_closed')
    })

    it('still refuses a completed campaign up front', async () => {
        campaignsFindFirstMock.mockResolvedValue({ id: CAMPAIGN_ID, organizationId: ORG_ID, status: 'completed' })
        const result = await post(`/${CAMPAIGN_ID}/leads`, { leadIds: [LEGIT_LEAD_ID] })
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('campaign_enrollment_closed')
    })

    it('does not filter unsubscribed leads at enroll time (the delivery policy parks them at send time)', async () => {
        leadsFindManyMock.mockResolvedValueOnce([{ id: LEGIT_LEAD_ID, email: 'owner@realbarbershop.test', emailVerificationStatus: 'unknown', unsubscribedAt: new Date() }])
        const result = await post(`/${CAMPAIGN_ID}/leads`, { leadIds: [LEGIT_LEAD_ID] })
        expect(result.status).toBe(201)
        expect(result.body).toMatchObject({ added: 1, existing: 0, skipped_invalid: 0, skipped_platform_email: 0, unverified_count: 1 })
    })
})
