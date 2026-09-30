import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Defeito 2 (2026-09-30): a lead whose email belongs to a scheduling/
 * marketplace platform (Booksy support etc — see ../../lib/platform-emails.ts) must never be
 * enrolled into a campaign, even through the agent gateway's own enroll-draft path — defense in
 * depth for a lead that made it into the `leads` table before this guard existed at import time.
 * Everything the route touches (db, agent-auth, agent-audit, xphere-events) is mocked; only
 * `checkProtectedSendingDomains` (real — MAIL_DOMAIN is unset in tests, so it never fires) and
 * the real `isPlatformEmail` classifier run unmocked.
 */

const ORG_ID = '11111111-1111-1111-1111-111111111111'
const CAMPAIGN_ID = '22222222-2222-2222-2222-222222222222'
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333'
const LEGIT_LEAD_ID = '44444444-4444-4444-4444-444444444444'
const PLATFORM_LEAD_ID = '55555555-5555-5555-5555-555555555555'

const campaignsFindFirstMock = vi.hoisted(() => vi.fn())
const emailAccountsFindFirstMock = vi.hoisted(() => vi.fn())
const leadsFindManyMock = vi.hoisted(() => vi.fn())
const sequencesFindFirstMock = vi.hoisted(() => vi.fn())
const transactionMock = vi.hoisted(() => vi.fn())
const getAgentPrincipalMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', () => ({
    db: {
        query: {
            campaigns: { findFirst: campaignsFindFirstMock },
            emailAccounts: { findFirst: emailAccountsFindFirstMock },
            leads: { findMany: leadsFindManyMock },
            sequences: { findFirst: sequencesFindFirstMock },
            leadLists: { findFirst: vi.fn() },
        },
        transaction: transactionMock,
    },
}))

vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: getAgentPrincipalMock,
    agentHasScope: () => true,
}))

vi.mock('../../lib/agent-audit', () => ({
    writeAgentAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/xphere-events', () => ({
    publishOutreachEvent: vi.fn().mockResolvedValue(undefined),
}))

// Sub-routers mounted by agent-outreach.ts that this suite never exercises — stub each as a
// pass-through middleware so importing the router doesn't pull in their own unrelated
// db/service dependencies.
const passthroughMiddleware = vi.hoisted(() => (_req: unknown, _res: unknown, next: () => void) => next())
vi.mock('../agent-prospecting', () => ({ default: passthroughMiddleware }))
vi.mock('../agent-approvals', () => ({ default: passthroughMiddleware }))
vi.mock('../agent-assessments', () => ({ default: passthroughMiddleware }))

let server: http.Server
let baseUrl: string

async function post(pathname: string, body: unknown) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeEach(async () => {
    // agent-outreach.ts imports checkProtectedSendingDomains from ./outreach/campaigns, which
    // transitively imports outreach-approval-preview.ts -> unsubscribe.ts -> outreach-tokens.ts;
    // that file throws at module load if neither ENCRYPTION_KEY nor JWT_SECRET is set (fails
    // loud on purpose). Never touches a real secret; only satisfies the load-time guard.
    process.env.ENCRYPTION_KEY ||= 'test-encryption-key'

    vi.clearAllMocks()
    getAgentPrincipalMock.mockReturnValue({
        credentialId: 'cred-1',
        organizationId: ORG_ID,
        principalUserId: 'user-1',
        scopes: ['campaigns:draft'],
    })
    campaignsFindFirstMock.mockResolvedValue({
        id: CAMPAIGN_ID,
        organizationId: ORG_ID,
        status: 'draft',
    })
    emailAccountsFindFirstMock.mockResolvedValue({
        id: ACCOUNT_ID,
        email: 'sender@example-outreach.test',
    })
    sequencesFindFirstMock.mockResolvedValue({
        steps: [{ id: 'step-1', stepOrder: 1 }],
    })
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
        insert: () => ({
            values: () => ({
                onConflictDoNothing: () => ({
                    returning: vi.fn().mockResolvedValue([{ leadId: LEGIT_LEAD_ID }]),
                }),
            }),
        }),
        update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    }))

    const router = (await import('../agent-outreach')).default
    const app = express()
    app.use(express.json())
    app.use('/', router)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Loading agent-outreach.ts's whole module graph cold can take longer than the default
    // 10s hook timeout on a loaded machine — this only pays that cost once per file.
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('POST /campaigns/:id/enroll-draft — platform-email defense in depth', () => {
    it('refuses enrollment when a requested lead carries a scheduling/marketplace platform email', async () => {
        leadsFindManyMock.mockResolvedValue([
            { id: LEGIT_LEAD_ID, email: 'owner@realbarbershop.test' },
            // help.us@booksy.com passes the SQL-side filter (verified, not unsubscribed) —
            // only the JS-side isPlatformEmail check catches it.
            { id: PLATFORM_LEAD_ID, email: 'help.us@booksy.com' },
        ])

        const result = await post(`/campaigns/${CAMPAIGN_ID}/enroll-draft`, {
            leadIds: [LEGIT_LEAD_ID, PLATFORM_LEAD_ID],
            emailAccountId: ACCOUNT_ID,
        })

        expect(result.status).toBe(422)
        expect(result.body.error).toMatch(/platform/i)
        expect(transactionMock).not.toHaveBeenCalled()
    })

    it('still enrolls when every requested lead has a legitimate email', async () => {
        leadsFindManyMock.mockResolvedValue([
            { id: LEGIT_LEAD_ID, email: 'owner@realbarbershop.test' },
        ])

        const result = await post(`/campaigns/${CAMPAIGN_ID}/enroll-draft`, {
            leadIds: [LEGIT_LEAD_ID],
            emailAccountId: ACCOUNT_ID,
        })

        expect(result.status).toBe(201)
        expect(result.body.added).toBe(1)
        expect(transactionMock).toHaveBeenCalledTimes(1)
    })
})
