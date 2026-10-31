import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests, no DB: POST /campaigns/:id/enroll (Hermes feeds a campaign). The shared
 * enrollment service is mocked at its three entry points (the service itself has its own suite);
 * what is proven here is the route's contract: draft, active and paused campaigns are enrolled
 * directly (Vanildo, 2026-10-31: no approval card to feed a running campaign), a running one also
 * gets an FYI message on the outreach Telegram chat, a finished one is a 409, and the scope and the
 * 1000-lead request bound hold.
 */

const ORG = '11111111-1111-1111-1111-111111111111'
const CAMPAIGN = '22222222-2222-2222-2222-222222222222'
const LEAD_A = '44444444-4444-4444-4444-444444444441'
const LEAD_B = '44444444-4444-4444-4444-444444444442'
const SENDER = '33333333-3333-3333-3333-333333333333'
const APPROVAL = '55555555-5555-5555-5555-555555555555'

const m = vi.hoisted(() => ({
    campaignsFindFirst: vi.fn(),
    approvalsFindFirst: vi.fn(),
    principal: vi.fn(),
    enroll: vi.fn(),
    plan: vi.fn(),
    firstStep: vi.fn(),
    findOrCreateApproval: vi.fn(),
    audit: vi.fn(),
    publish: vi.fn(),
    telegram: vi.fn(),
}))

vi.mock('../../../db', () => ({
    db: {
        query: {
            campaigns: { findFirst: m.campaignsFindFirst },
            outreachActionApprovals: { findFirst: m.approvalsFindFirst },
        },
    },
}))
vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: m.principal,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))
vi.mock('../../lib/agent-audit', () => ({ writeAgentAudit: m.audit }))
vi.mock('../../lib/xphere-events', () => ({ publishOutreachEvent: m.publish }))
vi.mock('../../lib/agent-approval-request', () => ({ findOrCreateApproval: m.findOrCreateApproval }))
vi.mock('../../lib/telegram', () => ({ sendTelegram: m.telegram }))
vi.mock('../../lib/campaign-enrollment', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../lib/campaign-enrollment')>()),
    enrollCampaignLeads: m.enroll,
    planCampaignEnrollment: m.plan,
    requireCampaignFirstStep: m.firstStep,
}))

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

const plan = (toAdd = 2) => ({
    campaign: { id: CAMPAIGN, name: 'Pilot', status: 'active' },
    requested: 3,
    toAdd: [LEAD_A, LEAD_B].slice(0, toAdd).map((leadId) => ({ leadId, email: 'x@y.test', companyName: `Shop ${leadId.slice(-1)}`, assignedEmailAccountId: SENDER })),
    alreadyEnrolled: [],
    ineligible: [{ leadId: 'zz', reason: 'unsubscribed' }],
    senders: [{ emailAccountId: SENDER, email: 'a@tryskaleclub.test', count: toAdd }],
    unverifiedCount: 0,
})

const validBody = { leadIds: [LEAD_A, LEAD_B], idempotencyKey: 'enroll-batch-0001', reason: 'Fresh Hudson barbers' }

beforeEach(async () => {
    vi.clearAllMocks()
    m.principal.mockReturnValue({ credentialId: 'cred-1', organizationId: ORG, principalUserId: 'user-1', scopes: ['campaigns:draft'] })
    m.campaignsFindFirst.mockResolvedValue({ id: CAMPAIGN, organizationId: ORG, name: 'Pilot', status: 'draft' })
    m.approvalsFindFirst.mockResolvedValue(undefined)
    m.firstStep.mockResolvedValue({ id: 'step-1', stepOrder: 1 })
    m.plan.mockResolvedValue(plan())
    m.enroll.mockResolvedValue({ plan: plan(), inserted: [{ leadId: LEAD_A }, { leadId: LEAD_B }] })
    m.findOrCreateApproval.mockResolvedValue({ approval: { id: APPROVAL, status: 'requested' }, idempotentReplay: false })
    m.audit.mockResolvedValue(undefined)
    m.publish.mockResolvedValue(undefined)
    m.telegram.mockResolvedValue({ ok: true })

    const router = (await import('../agent-campaign-enroll')).default
    const app = express()
    app.use(express.json())
    app.use('/', router)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 30_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('POST /campaigns/:id/enroll', () => {
    it('enrolls straight away while the campaign is a draft, through the shared service, and audits it', async () => {
        const result = await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)

        expect(result.status).toBe(201)
        expect(result.body).toMatchObject({ approvalRequired: false, added: 2, activationRequired: true })
        expect(m.enroll).toHaveBeenCalledWith(expect.objectContaining({
            organizationId: ORG, campaignId: CAMPAIGN, policy: 'agent', senders: { mode: 'auto' }, leadIds: [LEAD_A, LEAD_B],
        }))
        expect(m.findOrCreateApproval).not.toHaveBeenCalled()
        expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.campaign.enrolled', resourceId: CAMPAIGN }))
    })

    it('pins every lead to one inbox when emailAccountId is given', async () => {
        await post(`/campaigns/${CAMPAIGN}/enroll`, { ...validBody, emailAccountId: SENDER })
        expect(m.enroll).toHaveBeenCalledWith(expect.objectContaining({ senders: { mode: 'explicit', emailAccountId: SENDER } }))
    })

    for (const status of ['active', 'paused']) {
        it(`on a ${status} campaign enrolls directly (no approval card) and posts an FYI on the outreach chat`, async () => {
            m.campaignsFindFirst.mockResolvedValue({ id: CAMPAIGN, organizationId: ORG, name: 'Pilot', status })

            const result = await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)

            expect(result.status).toBe(201)
            expect(result.body).toMatchObject({ approvalRequired: false, added: 2, activationRequired: false, campaignStatus: status })
            expect(m.firstStep).toHaveBeenCalled()
            expect(m.enroll).toHaveBeenCalledWith(expect.objectContaining({ campaignId: CAMPAIGN, policy: 'agent', leadIds: [LEAD_A, LEAD_B] }))
            expect(m.findOrCreateApproval).not.toHaveBeenCalled()
            expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.campaign.enrolled', resourceId: CAMPAIGN }))
            await vi.waitFor(() => expect(m.telegram).toHaveBeenCalledTimes(1))
            const [title, body, channel] = m.telegram.mock.calls[0]
            expect(channel).toBe('outreach')
            expect(title).toContain('Hermes adicionou 2 lead(s)')
            expect(body).toContain('Pilot')
            expect(body).toContain('1 descadastrados')
            expect(body).toContain('Fresh Hudson barbers')
        })
    }

    it('does not post the FYI when nothing was added to a running campaign', async () => {
        m.campaignsFindFirst.mockResolvedValue({ id: CAMPAIGN, organizationId: ORG, name: 'Pilot', status: 'active' })
        m.enroll.mockResolvedValue({ plan: { ...plan(0), alreadyEnrolled: [LEAD_A, LEAD_B] }, inserted: [] })

        const result = await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)

        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ approvalRequired: false, added: 0 })
        expect(m.telegram).not.toHaveBeenCalled()
    })

    it('does not post the FYI for a draft (nothing is sent before activation)', async () => {
        await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)
        expect(m.telegram).not.toHaveBeenCalled()
    })

    for (const status of ['completed', 'archived']) {
        it(`refuses a ${status} campaign with 409`, async () => {
            m.campaignsFindFirst.mockResolvedValue({ id: CAMPAIGN, organizationId: ORG, name: 'Pilot', status })
            const result = await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)
            expect(result.status).toBe(409)
            expect(result.body.code).toBe('campaign_enrollment_closed')
            expect(m.enroll).not.toHaveBeenCalled()
            expect(m.findOrCreateApproval).not.toHaveBeenCalled()
        })
    }

    it('is idempotent in effect: a retry adds nothing because the leads are already on the campaign', async () => {
        m.campaignsFindFirst.mockResolvedValue({ id: CAMPAIGN, organizationId: ORG, name: 'Pilot', status: 'active' })
        m.enroll.mockResolvedValue({ plan: { ...plan(0), alreadyEnrolled: [LEAD_A, LEAD_B] }, inserted: [] })

        const result = await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)

        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ added: 0, alreadyEnrolled: 2 })
    })

    it('requires the campaigns:draft scope', async () => {
        m.principal.mockReturnValue({ credentialId: 'cred-1', organizationId: ORG, principalUserId: 'user-1', scopes: ['outreach:read'] })
        expect((await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)).status).toBe(403)
        expect(m.enroll).not.toHaveBeenCalled()
    })

    it('bounds one request at 1000 leads and demands an idempotency key', async () => {
        const many = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
        expect((await post(`/campaigns/${CAMPAIGN}/enroll`, { ...validBody, leadIds: many })).status).toBe(400)
        const exactly = many.slice(0, 1000)
        expect((await post(`/campaigns/${CAMPAIGN}/enroll`, { ...validBody, leadIds: exactly })).status).toBe(201)
        expect((await post(`/campaigns/${CAMPAIGN}/enroll`, { leadIds: [LEAD_A] })).status).toBe(400)
    })

    it('answers 404 for a malformed or foreign campaign id', async () => {
        expect((await post('/campaigns/not-a-uuid/enroll', validBody)).status).toBe(404)
        m.campaignsFindFirst.mockResolvedValue(undefined)
        expect((await post(`/campaigns/${CAMPAIGN}/enroll`, validBody)).status).toBe(404)
    })
})
