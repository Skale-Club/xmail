import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests, no DB: executing an approved `campaign_enrollment`. The real enrollment service
 * runs against a mocked drizzle client, so these prove what the owner's tap actually does:
 * it re-validates the leads against the CURRENT state inside the campaign lock, enrolls only what is
 * still eligible, writes the approval as executed in the same transaction, and fails the approval
 * cleanly when the campaign can no longer take leads.
 */

const ORG = '11111111-1111-1111-1111-111111111111'
const CAMPAIGN = '22222222-2222-2222-2222-222222222222'
const APPROVAL = '55555555-5555-5555-5555-555555555555'
const SENDER = '33333333-3333-3333-3333-333333333333'
const L1 = '00000001-0000-4000-8000-000000000000'
const L2 = '00000002-0000-4000-8000-000000000000'
const L3 = '00000003-0000-4000-8000-000000000000'

const m = vi.hoisted(() => ({
    approval: null as null | Record<string, unknown>,
    leads: [] as Array<Record<string, unknown>>,
    campaignStatus: 'active',
    lockedStatus: 'active',
    inserted: [] as Array<Array<Record<string, unknown>>>,
    txApprovalUpdates: [] as Array<Record<string, unknown>>,
    dbUpdates: [] as Array<Record<string, unknown>>,
    approvalClaimable: true,
    published: [] as Array<Record<string, unknown>>,
    sequenceSteps: [{ id: 'step-1', stepOrder: 1 }] as unknown[],
}))

function chain(result: unknown) {
    const c: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'groupBy', 'limit']) c[method] = () => c
    c.then = (resolve: (value: unknown) => unknown) => resolve(result)
    return c
}

function makeTx() {
    return {
        query: {
            campaigns: { findFirst: async () => ({ id: CAMPAIGN, name: 'Pilot', status: m.campaignStatus }) },
            leads: { findMany: async () => m.leads },
            campaignLeads: { findMany: async () => [] },
            emailAccounts: {
                findFirst: async () => null,
                findMany: async () => [{ id: SENDER, email: 'a@tryskaleclub.test', status: 'verified', warmupOnly: false }],
            },
        },
        select: () => chain([{ id: SENDER, open: 0 }]),
        execute: async () => [{ status: m.lockedStatus }],
        insert: () => ({
            values: (rows: Array<Record<string, unknown>>) => {
                m.inserted.push(rows)
                return { returning: async () => rows.map((row, index) => ({ id: `cl-${index}`, leadId: row.leadId })) }
            },
        }),
        update: () => ({
            set: (values: Record<string, unknown>) => {
                const isApproval = 'executedAt' in values
                if (isApproval) m.txApprovalUpdates.push(values)
                const result = {
                    where: () => Object.assign(Promise.resolve(undefined), {
                        returning: async () => (isApproval && m.approvalClaimable ? [{ id: APPROVAL, status: 'executed' }] : []),
                    }),
                }
                return result
            },
        }),
    }
}

vi.mock('../../../db', () => ({
    db: {
        query: { outreachActionApprovals: { findFirst: async () => m.approval } },
        update: () => ({
            set: (values: Record<string, unknown>) => {
                m.dbUpdates.push(values)
                return { where: () => Object.assign(Promise.resolve(undefined), { returning: async () => [{ id: APPROVAL }] }) }
            },
        }),
        transaction: async (callback: (tx: unknown) => unknown) => callback(makeTx()),
    },
}))
vi.mock('../xphere-events', () => ({ publishOutreachEvent: async (event: Record<string, unknown>) => { m.published.push(event) } }))
vi.mock('../outreach-sequences', () => ({
    getCanonicalSequence: async () => ({ steps: m.sequenceSteps }),
}))
vi.mock('../../routes/outreach/campaigns', () => ({ validateCampaignReadyForActivation: vi.fn() }))

import { approveOutreachAction } from '../approval-actions'

function lead(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id, email: `${id.slice(0, 8)}@barbershop.test`, companyName: `Shop ${id.slice(0, 8)}`, status: 'new',
        unsubscribedAt: null, emailVerificationStatus: 'verified', ...overrides,
    }
}

beforeEach(() => {
    m.approval = {
        id: APPROVAL,
        organizationId: ORG,
        actionKind: 'campaign_enrollment',
        resourceType: 'campaign',
        resourceId: CAMPAIGN,
        status: 'requested',
        expiresAt: new Date(Date.now() + 3_600_000),
        requestPayload: { leadIds: [L1, L2, L3], reason: 'fresh batch' },
    }
    m.leads = [lead(L1), lead(L2), lead(L3)]
    m.campaignStatus = 'active'
    m.lockedStatus = 'active'
    m.inserted = []
    m.txApprovalUpdates = []
    m.dbUpdates = []
    m.published = []
    m.approvalClaimable = true
    m.sequenceSteps = [{ id: 'step-1', stepOrder: 1 }]
})

const approve = () => approveOutreachAction({ approvalId: APPROVAL, organizationId: ORG, actorUserId: 'owner-1', note: 'Aprovado pelo Telegram' })

describe('approving a campaign_enrollment', () => {
    it('enrolls the requested leads, marks the approval executed in the same transaction and publishes an event', async () => {
        const outcome = await approve()

        expect(outcome.ok).toBe(true)
        expect(m.inserted).toHaveLength(1)
        expect(m.inserted[0].map((row) => row.leadId)).toEqual([L1, L2, L3])
        expect(m.inserted[0].every((row) => row.assignedEmailAccountId === SENDER)).toBe(true)
        expect(m.txApprovalUpdates).toHaveLength(1)
        expect(m.txApprovalUpdates[0]).toMatchObject({ status: 'executed', reviewerUserId: 'owner-1' })
        if (outcome.ok) {
            expect(outcome.body.result).toMatchObject({ added: 3, leftOut: 0 })
            expect(outcome.body.idempotentReplay).toBe(false)
        }
        expect(m.published).toEqual([expect.objectContaining({
            eventType: 'campaign.enrollment_approved',
            aggregateId: CAMPAIGN,
            payload: expect.objectContaining({ approval_id: APPROVAL, added_count: 3 }),
        })])
    })

    it('re-validates: a lead that unsubscribed or became suppressed-by-status since the request is skipped and reported', async () => {
        m.leads = [lead(L1), lead(L2, { unsubscribedAt: new Date() }), lead(L3, { emailVerificationStatus: 'invalid' })]

        const outcome = await approve()

        expect(m.inserted[0].map((row) => row.leadId)).toEqual([L1])
        expect(outcome.ok).toBe(true)
        if (outcome.ok) {
            expect(outcome.body.result).toMatchObject({
                added: 1,
                leftOut: 2,
                leftOutByReason: { unsubscribed: 1, invalid_email: 1 },
            })
        }
    })

    it('executes with zero added when nobody is eligible any more, instead of failing the approval', async () => {
        m.leads = [lead(L1, { unsubscribedAt: new Date() }), lead(L2, { unsubscribedAt: new Date() }), lead(L3, { unsubscribedAt: new Date() })]

        const outcome = await approve()

        expect(outcome.ok).toBe(true)
        expect(m.inserted).toHaveLength(0)
        expect(m.txApprovalUpdates).toHaveLength(1)
        if (outcome.ok) expect(outcome.body.result).toMatchObject({ added: 0, leftOut: 3 })
    })

    it('fails the approval cleanly when the campaign completed between the request and the tap', async () => {
        m.lockedStatus = 'completed'

        const outcome = await approve()

        expect(outcome.ok).toBe(false)
        if (!outcome.ok) {
            expect(outcome.status).toBe(409)
            expect(outcome.body.error).toMatch(/completed campaign/)
        }
        expect(m.inserted).toHaveLength(0)
        expect(m.published).toHaveLength(0)
        expect(m.dbUpdates).toEqual([expect.objectContaining({ status: 'failed', failureReason: expect.stringMatching(/completed campaign/), reviewerUserId: 'owner-1' })])
    })

    it('fails the approval when the campaign lost its sequence', async () => {
        m.sequenceSteps = []

        const outcome = await approve()

        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.status).toBe(422)
        expect(m.dbUpdates[0]).toMatchObject({ status: 'failed' })
    })

    it('rolls back when another tap claimed the approval first (409, nothing left behind)', async () => {
        m.approvalClaimable = false

        const outcome = await approve()

        expect(outcome.ok).toBe(false)
        if (!outcome.ok) expect(outcome.status).toBe(409)
        expect(m.published).toHaveLength(0)
    })

    it('answers a second tap on an executed approval as a replay, without enrolling again', async () => {
        m.approval = { ...m.approval!, status: 'executed' }
        const outcome = await approve()
        expect(outcome).toMatchObject({ ok: true, body: { idempotentReplay: true } })
        expect(m.inserted).toHaveLength(0)
    })

    it('does not execute an expired request', async () => {
        m.approval = { ...m.approval!, expiresAt: new Date(Date.now() - 1000) }
        const outcome = await approve()
        expect(outcome).toMatchObject({ ok: false, status: 410 })
        expect(m.inserted).toHaveLength(0)
    })

    it('marks a malformed payload as failed instead of enrolling', async () => {
        m.approval = { ...m.approval!, requestPayload: { leadIds: [] } }
        const outcome = await approve()
        expect(outcome).toMatchObject({ ok: false, status: 422 })
        expect(m.dbUpdates[0]).toMatchObject({ status: 'failed' })
        expect(m.inserted).toHaveLength(0)
    })
})
