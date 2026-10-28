import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests, no DB: the shared enrollment service (lib/campaign-enrollment.ts) against a
 * mocked drizzle client. `select()` answers from a queue in call order; `query.*` are plain mocks.
 */

const ORG = '11111111-1111-1111-1111-111111111111'
const CAMPAIGN = '22222222-2222-2222-2222-222222222222'
const SENDER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SENDER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const INFO = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const WARMUP = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

const mocks = vi.hoisted(() => ({
    campaignsFindFirst: vi.fn(),
    leadsFindMany: vi.fn(),
    campaignLeadsFindMany: vi.fn(),
    emailAccountsFindFirst: vi.fn(),
    emailAccountsFindMany: vi.fn(),
    selectQueue: [] as unknown[][],
    execute: vi.fn(),
    insertReturning: vi.fn(),
    inserted: [] as unknown[],
    updates: [] as unknown[],
    getCanonicalSequence: vi.fn(),
}))

function makeSelect() {
    return () => {
        const result = mocks.selectQueue.shift() ?? []
        const chain: Record<string, unknown> = {}
        for (const method of ['from', 'where', 'groupBy', 'limit']) chain[method] = () => chain
        chain.then = (resolve: (value: unknown) => unknown) => resolve(result)
        return chain
    }
}

function makeExecutor() {
    return {
        query: {
            campaigns: { findFirst: mocks.campaignsFindFirst },
            leads: { findMany: mocks.leadsFindMany },
            campaignLeads: { findMany: mocks.campaignLeadsFindMany },
            emailAccounts: { findFirst: mocks.emailAccountsFindFirst, findMany: mocks.emailAccountsFindMany },
        },
        select: makeSelect(),
        execute: mocks.execute,
        insert: () => ({
            values: (rows: unknown) => {
                mocks.inserted.push(rows)
                return { returning: () => mocks.insertReturning(rows) }
            },
        }),
        update: () => ({ set: (values: unknown) => { mocks.updates.push(values); return { where: () => Promise.resolve(undefined) } } }),
    }
}

vi.mock('../../../db', () => ({
    db: {
        ...makeExecutor(),
        transaction: async (callback: (tx: unknown) => unknown) => callback(makeExecutor()),
    },
}))
vi.mock('../outreach-sequences', () => ({ getCanonicalSequence: mocks.getCanonicalSequence }))

import {
    CampaignEnrollmentError,
    distributeAcrossSenders,
    enrollCampaignLeads,
    planCampaignEnrollment,
    summarizeEnrollmentPlan,
} from '../campaign-enrollment'
import { db } from '../../../db'

function lead(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        email: `${id.slice(0, 4)}@barbershop.test`,
        companyName: `Shop ${id.slice(0, 4)}`,
        status: 'new',
        unsubscribedAt: null,
        emailVerificationStatus: 'verified',
        ...overrides,
    }
}

const L = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

function account(accountId: string, email: string, overrides: Record<string, unknown> = {}) {
    return { id: accountId, email, status: 'verified', warmupOnly: false, ...overrides }
}

const base = { organizationId: ORG, campaignId: CAMPAIGN }

beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectQueue.length = 0
    mocks.inserted.length = 0
    mocks.updates.length = 0
    delete process.env.MAIL_DOMAIN
    process.env.OUTREACH_PROTECTED_DOMAINS = 'skale.club,xkedule.com'
    mocks.campaignsFindFirst.mockResolvedValue({ id: CAMPAIGN, name: 'Pilot', status: 'active' })
    mocks.campaignLeadsFindMany.mockResolvedValue([])
    mocks.leadsFindMany.mockResolvedValue([])
    mocks.emailAccountsFindMany.mockResolvedValue([])
    mocks.execute.mockResolvedValue([{ status: 'active' }])
    mocks.getCanonicalSequence.mockResolvedValue({ steps: [{ id: 'step-1', stepOrder: 1 }] })
    mocks.insertReturning.mockImplementation(async (rows: Array<{ leadId: string }>) => rows.map((row, index) => ({ id: `cl-${index}`, leadId: row.leadId })))
})

afterEach(() => {
    delete process.env.OUTREACH_PROTECTED_DOMAINS
})

describe('distributeAcrossSenders', () => {
    it('hands leads out round-robin, starting with the least loaded inbox', () => {
        const picks = distributeAcrossSenders(5, [
            { id: 'a', email: 'a@x.test', load: 0 },
            { id: 'b', email: 'b@x.test', load: 2 },
        ])
        // a catches up to b's load of 2, then they alternate
        expect(picks.map((p) => p.id)).toEqual(['a', 'a', 'a', 'b', 'a'])
    })
})

describe('planCampaignEnrollment, agent policy', () => {
    it('skips and reports unsubscribed, suppressed (address and domain), platform, unverified, invalid and missing leads', async () => {
        const ok = L(1)
        mocks.leadsFindMany.mockResolvedValue([
            lead(ok),
            lead(L(2), { unsubscribedAt: new Date() }),
            lead(L(3), { email: 'blocked@barbershop.test' }),
            lead(L(4), { email: 'anyone@blockeddomain.test' }),
            lead(L(5), { email: 'help.us@booksy.com' }),
            lead(L(6), { emailVerificationStatus: 'unknown' }),
            lead(L(7), { emailVerificationStatus: 'invalid' }),
            lead(L(8), { email: '' }),
            lead(L(9), { status: 'unsubscribed' }),
            lead(L(10), { emailVerificationStatus: 'likely' }),
        ])
        mocks.selectQueue.push(
            // auto senders: inboxes already used by the campaign
            [{ id: SENDER_A, open: 0 }],
            // suppressions
            [{ key: 'blocked@barbershop.test' }, { key: '@blockeddomain.test' }],
        )
        mocks.emailAccountsFindMany.mockResolvedValueOnce([account(SENDER_A, 'a@tryskaleclub.test')])

        const plan = await planCampaignEnrollment(db, {
            ...base, policy: 'agent', senders: { mode: 'auto' },
            leadIds: [ok, L(2), L(3), L(4), L(5), L(6), L(7), L(8), L(9), L(10), L(11)],
        })

        expect(plan.toAdd.map((l) => l.leadId)).toEqual([ok, L(10)])
        const reasons = Object.fromEntries(plan.ineligible.map((e) => [e.leadId, e.reason]))
        expect(reasons).toEqual({
            [L(2)]: 'unsubscribed',
            [L(3)]: 'suppressed',
            [L(4)]: 'suppressed',
            [L(5)]: 'platform_email',
            [L(6)]: 'email_not_verified',
            [L(7)]: 'invalid_email',
            [L(8)]: 'no_email',
            [L(9)]: 'unsubscribed',
            [L(11)]: 'not_found',
        })
    })

    it('reports leads already on the campaign separately and never plans them again', async () => {
        mocks.leadsFindMany.mockResolvedValue([lead(L(1)), lead(L(2))])
        mocks.campaignLeadsFindMany.mockResolvedValue([{ leadId: L(1) }])
        mocks.selectQueue.push([{ id: SENDER_A, open: 3 }], [])
        mocks.emailAccountsFindMany.mockResolvedValueOnce([account(SENDER_A, 'a@tryskaleclub.test')])

        const plan = await planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1), L(2), L(2)] })

        expect(plan.requested).toBe(2)
        expect(plan.alreadyEnrolled).toEqual([L(1)])
        expect(plan.toAdd.map((l) => l.leadId)).toEqual([L(2)])
        expect(summarizeEnrollmentPlan(plan)).toMatchObject({ willAdd: 1, alreadyEnrolled: 1, leftOutByReason: { already_enrolled: 1 } })
    })

    it('spreads new leads round-robin over the campaign inboxes and never picks info@ or a warm-up box', async () => {
        mocks.leadsFindMany.mockResolvedValue([1, 2, 3, 4, 5, 6].map((n) => lead(L(n))))
        // The campaign already uses A, B, the company info@ box and a warm-up seed.
        mocks.selectQueue.push(
            [{ id: SENDER_A, open: 0 }, { id: SENDER_B, open: 0 }, { id: INFO, open: 0 }, { id: WARMUP, open: 0 }],
            [],
        )
        mocks.emailAccountsFindMany.mockResolvedValueOnce([
            account(SENDER_A, 'a@tryskaleclub.test'),
            account(SENDER_B, 'b@tryskaleclub.test'),
            account(INFO, 'info@xkedule.com'),
            account(WARMUP, 'contato@tryskaleclub.test', { warmupOnly: true }),
        ])

        const plan = await planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [1, 2, 3, 4, 5, 6].map(L) })

        const used = new Set(plan.toAdd.map((l) => l.assignedEmailAccountId))
        expect(used).toEqual(new Set([SENDER_A, SENDER_B]))
        expect(plan.senders).toEqual([
            { emailAccountId: SENDER_A, email: 'a@tryskaleclub.test', count: 3 },
            { emailAccountId: SENDER_B, email: 'b@tryskaleclub.test', count: 3 },
        ])
    })

    it('falls back to every eligible org inbox when the campaign has none, still excluding info@ and warm-up boxes', async () => {
        mocks.leadsFindMany.mockResolvedValue([lead(L(1)), lead(L(2))])
        mocks.selectQueue.push([], [])
        mocks.emailAccountsFindMany.mockResolvedValueOnce([
            account(INFO, 'info@skale.club'),
            account(WARMUP, 'agenda@tryskaleclub.test', { warmupOnly: true }),
            account(SENDER_A, 'a@tryskaleclub.test'),
        ])

        const plan = await planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1), L(2)] })

        expect(plan.toAdd.every((l) => l.assignedEmailAccountId === SENDER_A)).toBe(true)
    })

    it('refuses when there is no eligible sender at all', async () => {
        mocks.leadsFindMany.mockResolvedValue([lead(L(1))])
        mocks.selectQueue.push([], [])
        mocks.emailAccountsFindMany.mockResolvedValueOnce([account(INFO, 'info@xkedule.com')])

        await expect(planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1)] }))
            .rejects.toMatchObject({ status: 422, code: 'no_eligible_sender' })
    })

    it('rejects an explicit warm-up-only inbox and an explicit protected-domain inbox', async () => {
        mocks.emailAccountsFindFirst.mockResolvedValueOnce(account(WARMUP, 'agenda@tryskaleclub.test', { warmupOnly: true }))
        await expect(planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'explicit', emailAccountId: WARMUP }, leadIds: [L(1)] }))
            .rejects.toMatchObject({ status: 422, code: 'sender_warmup_only' })

        mocks.emailAccountsFindFirst.mockResolvedValueOnce(account(INFO, 'info@xkedule.com'))
        await expect(planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'explicit', emailAccountId: INFO }, leadIds: [L(1)] }))
            .rejects.toMatchObject({ status: 422, code: 'protected_sending_domain' })

        mocks.emailAccountsFindFirst.mockResolvedValueOnce(account(SENDER_A, 'a@tryskaleclub.test', { status: 'pending' }))
        await expect(planCampaignEnrollment(db, { ...base, policy: 'agent', senders: { mode: 'explicit', emailAccountId: SENDER_A }, leadIds: [L(1)] }))
            .rejects.toMatchObject({ status: 400, code: 'sender_not_found' })
    })
})

describe('planCampaignEnrollment, human policy', () => {
    it('keeps the panel rules: only invalid and platform addresses are refused; unsubscribed and unverified go through', async () => {
        mocks.leadsFindMany.mockResolvedValue([
            lead(L(1), { unsubscribedAt: new Date(), emailVerificationStatus: 'unknown' }),
            lead(L(2), { emailVerificationStatus: 'invalid' }),
            lead(L(3), { email: 'help.us@booksy.com' }),
        ])
        const plan = await planCampaignEnrollment(db, { ...base, policy: 'human', senders: { mode: 'unassigned' }, leadIds: [L(1), L(2), L(3)] })
        expect(plan.toAdd).toEqual([expect.objectContaining({ leadId: L(1), assignedEmailAccountId: null })])
        expect(plan.ineligible.map((e) => e.reason)).toEqual(['invalid_email', 'platform_email'])
        expect(plan.unverifiedCount).toBe(1)
    })

    it('answers 400 when any id is not in the organization', async () => {
        mocks.leadsFindMany.mockResolvedValue([lead(L(1))])
        await expect(planCampaignEnrollment(db, { ...base, policy: 'human', senders: { mode: 'unassigned' }, leadIds: [L(1), L(2)] }))
            .rejects.toMatchObject({ status: 400 })
    })
})

describe('enrollCampaignLeads', () => {
    it('plans inside the locked transaction, inserts only what is eligible now and schedules the first send', async () => {
        mocks.leadsFindMany.mockResolvedValue([lead(L(1)), lead(L(2), { unsubscribedAt: new Date() })])
        mocks.selectQueue.push([{ id: SENDER_A, open: 0 }], [])
        mocks.emailAccountsFindMany.mockResolvedValueOnce([account(SENDER_A, 'a@tryskaleclub.test')])

        const result = await enrollCampaignLeads({ ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1), L(2)], planInsideTransaction: true })

        expect(result.inserted).toHaveLength(1)
        const rows = mocks.inserted[0] as Array<Record<string, unknown>>
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ campaignId: CAMPAIGN, leadId: L(1), assignedEmailAccountId: SENDER_A, currentStepId: 'step-1', currentStepOrder: 1 })
        expect(rows[0].nextScheduledAt).toBeInstanceOf(Date)
        expect(result.plan.ineligible).toEqual([{ leadId: L(2), reason: 'unsubscribed' }])
        expect(mocks.updates).toHaveLength(1) // totalLeads bookkeeping
    })

    it('refuses a campaign that finished, inside the lock, without inserting', async () => {
        mocks.execute.mockResolvedValue([{ status: 'completed' }])
        await expect(enrollCampaignLeads({ ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1)], planInsideTransaction: true }))
            .rejects.toMatchObject({ status: 409, code: 'campaign_enrollment_closed' })
        expect(mocks.inserted).toHaveLength(0)
    })

    it('refuses a campaign without a sequence step', async () => {
        mocks.getCanonicalSequence.mockResolvedValue({ steps: [] })
        await expect(enrollCampaignLeads({ ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1)], planInsideTransaction: true }))
            .rejects.toBeInstanceOf(CampaignEnrollmentError)
    })

    it('runs beforeCommit inside the transaction with the result', async () => {
        mocks.leadsFindMany.mockResolvedValue([lead(L(1))])
        mocks.selectQueue.push([{ id: SENDER_A, open: 0 }], [])
        mocks.emailAccountsFindMany.mockResolvedValueOnce([account(SENDER_A, 'a@tryskaleclub.test')])
        const beforeCommit = vi.fn()
        await enrollCampaignLeads({ ...base, policy: 'agent', senders: { mode: 'auto' }, leadIds: [L(1)], planInsideTransaction: true, beforeCommit })
        expect(beforeCommit).toHaveBeenCalledTimes(1)
        expect(beforeCommit.mock.calls[0][1].inserted).toHaveLength(1)
    })
})

