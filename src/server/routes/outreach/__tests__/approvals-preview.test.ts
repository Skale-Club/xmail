import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. Everything the route touches through `db`, `requireOutreachWrite`
 * and `buildCampaignActivationPreview` is mocked, following the vi.hoisted + vi.mock convention
 * from prospecting-external-runs.test.ts. Covers Fase 37 / audit finding 2: GET /approvals must
 * attach a rendered campaign preview to a pending `campaign_activation` request — and must not
 * silently omit or corrupt it when the preview itself fails to build.
 */

const findManyMock = vi.hoisted(() => vi.fn())
const requireOutreachWriteMock = vi.hoisted(() => vi.fn())
const buildPreviewMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({
    db: {
        query: {
            outreachActionApprovals: {
                findMany: findManyMock,
            },
        },
    },
}))

vi.mock('../../../lib/outreach-access', () => ({
    requireOutreachWrite: requireOutreachWriteMock,
    requireOutreachRead: vi.fn(),
    SERVICE_PRINCIPAL_HEADER: 'x-service-principal',
}))

vi.mock('../../../lib/xphere-events', () => ({
    publishOutreachEvent: vi.fn(),
}))

vi.mock('../../../lib/outreach-approval-preview', () => ({
    buildCampaignActivationPreview: buildPreviewMock,
}))

const ORG_ID = '11111111-1111-1111-1111-111111111111'

function approvalRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'approval-1',
        organizationId: ORG_ID,
        actionKind: 'campaign_activation',
        resourceType: 'campaign',
        resourceId: 'campaign-1',
        status: 'requested',
        maximumCreditCost: 0,
        requestPayload: {},
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        ...overrides,
    }
}

const BLOCKED_PREVIEW = {
    campaign: { id: 'campaign-1', name: 'Pilot campaign', status: 'draft' },
    sendingInboxes: [{ email: 'info@tryskaleclub.com', dailySendLimit: 50, currentDailySent: 3 }],
    sequence: [],
    sampleLead: { id: 'lead-1', email: 'jane@acme.com' },
    leadCounts: { total: 10, verified: 6, catchAll: 2, unknown: 2 },
    compliance: {
        hasPhysicalAddress: false,
        unsubscribePresentInEveryStep: true,
        blockers: [{ code: 'missing_physical_address', message: 'No step in this sequence includes a physical postal address (CAN-SPAM requirement).' }],
    },
}

let server: http.Server
let baseUrl: string

async function get(pathname: string, userId = 'user-1') {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { 'x-user-id': userId } })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeEach(async () => {
    requireOutreachWriteMock.mockResolvedValue({ role: 'admin' })
    buildPreviewMock.mockResolvedValue(BLOCKED_PREVIEW)

    const approvalsRouter = (await import('../approvals')).default
    const app = express()
    app.use(express.json())
    app.use('/', approvalsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
    vi.clearAllMocks()
})

describe('GET /approvals — campaign activation preview (Fase 37)', () => {
    it('attaches the rendered preview to a pending campaign_activation approval', async () => {
        findManyMock.mockResolvedValue([approvalRow()])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(200)
        expect(result.body.approvals).toHaveLength(1)
        expect(result.body.approvals[0].campaignPreview).toEqual(BLOCKED_PREVIEW)
        expect(buildPreviewMock).toHaveBeenCalledWith('campaign-1', ORG_ID)
    })

    it('reports a campaign missing a postal address as blocked, end to end', async () => {
        findManyMock.mockResolvedValue([approvalRow()])

        const result = await get(`/?organizationId=${ORG_ID}`)

        const { compliance } = result.body.approvals[0].campaignPreview
        expect(compliance.hasPhysicalAddress).toBe(false)
        expect(compliance.blockers).toEqual([
            expect.objectContaining({ code: 'missing_physical_address' }),
        ])
    })

    it('does not compute a preview for a prospect_enrichment approval', async () => {
        findManyMock.mockResolvedValue([approvalRow({ id: 'approval-2', actionKind: 'prospect_enrichment', resourceId: 'run-1' })])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(buildPreviewMock).not.toHaveBeenCalled()
        expect(result.body.approvals[0]).not.toHaveProperty('campaignPreview')
    })

    it('does not compute a preview for a non-pending (already executed) campaign_activation approval', async () => {
        findManyMock.mockResolvedValue([approvalRow({ status: 'executed' })])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(buildPreviewMock).not.toHaveBeenCalled()
        expect(result.body.approvals[0]).not.toHaveProperty('campaignPreview')
    })

    it('surfaces campaignPreview: null (never a 500, never a silently missing field) when the preview fails to build', async () => {
        findManyMock.mockResolvedValue([approvalRow()])
        buildPreviewMock.mockRejectedValue(new Error('campaign vanished'))

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(200)
        expect(result.body.approvals[0].campaignPreview).toBeNull()
    })

    it('still requires organization-admin access — a member cannot list approvals', async () => {
        requireOutreachWriteMock.mockResolvedValue({ role: 'member' })
        findManyMock.mockResolvedValue([approvalRow()])

        const result = await get(`/?organizationId=${ORG_ID}`)

        expect(result.status).toBe(403)
        expect(buildPreviewMock).not.toHaveBeenCalled()
    })
})
