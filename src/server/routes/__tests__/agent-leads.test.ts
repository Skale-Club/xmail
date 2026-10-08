import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reset, rows, startServer, state, type Row, type TestServer } from './fake-agent-db'

/**
 * Route tests for the Hermes/Kai lead operations (campaign roster, lead read/update, removal from a
 * campaign, lead lists). Same fake db and same rules as agent-campaign-manage.test.ts.
 *
 * Guards proven here: scope gate, tenant isolation, `confirm: true` before anything destructive
 * (409 with a description of what would happen), audit in the same transaction, partial updates
 * that merge customFields instead of replacing them, and the keys the agent may never write.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const CAMPAIGN = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG_CAMPAIGN = '22222222-2222-4222-8222-222222222299'
const LEAD_MAILED = '77777777-7777-4777-8777-777777777771'
const LEAD_FRESH = '77777777-7777-4777-8777-777777777772'
const LEAD_OTHER_ORG = '77777777-7777-4777-8777-777777777773'
const ACCOUNT = '66666666-6666-4666-8666-666666666661'
const LIST = '88888888-8888-4888-8888-888888888881'
const OTHER_LIST = '88888888-8888-4888-8888-888888888882'

const principalMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', async () => ({ db: (await import('./fake-agent-db')).fakeDb }))
vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: principalMock,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))
vi.mock('../../lib/agent-audit', async () => ({ writeAgentAudit: (await import('./fake-agent-db')).recordAudit }))
// jsonbParam wraps the value in a SQL fragment; the fake db stores the plain object instead.
vi.mock('../../lib/jsonb', () => ({ jsonbParam: (value: unknown) => value }))

let server: TestServer

const principal = (scopes: string[], organizationId = ORG) => ({ credentialId: 'cred-1', organizationId, principalUserId: 'user-1', scopes })
const lead = (id: string, overrides: Row = {}): Row => ({
    id, organizationId: ORG, email: `${id.slice(-1)}@barbershop.test`, firstName: 'Joe', lastName: null, companyName: 'Joe Barbers LLC',
    companySize: null, industry: null, title: null, website: null, linkedinUrl: null, phone: null, location: '1 Main St, Hudson, MA 01749',
    customFields: { shortName: 'Joe Barbers', has_owned_website: false, email_status: 'ok' }, status: 'contacted', source: 'xcraper', leadListId: null,
    emailVerificationStatus: 'verified', icpScore: 80, icpTier: 'a', totalEmailsSent: 1, totalOpens: 0, totalClicks: 0, totalReplies: 0,
    lastContactedAt: null, lastRepliedAt: null, unsubscribedAt: null, ...overrides,
})
const stored = (id: string) => rows('leads').find((row) => row.id === id)!

beforeAll(async () => {
    server = await startServer((await import('../agent-leads')).default)
}, 60_000)

afterAll(async () => {
    await server.close()
})

beforeEach(() => {
    reset({
        campaigns: [
            { id: CAMPAIGN, organizationId: ORG, name: 'Barbershops Pilot', status: 'active', totalLeads: 2 },
            { id: OTHER_ORG_CAMPAIGN, organizationId: OTHER_ORG, name: 'Other tenant', status: 'active', totalLeads: 1 },
        ],
        leads: [lead(LEAD_MAILED, { lastContactedAt: new Date(2026, 9, 5) }), lead(LEAD_FRESH, { status: 'new' }), lead(LEAD_OTHER_ORG, { organizationId: OTHER_ORG })],
        campaignLeads: [
            {
                id: 'cl-mailed', campaignId: CAMPAIGN, leadId: LEAD_MAILED, assignedEmailAccountId: ACCOUNT, status: 'contacted', currentStepOrder: 2,
                nextScheduledAt: new Date(2026, 9, 9), nextFollowUpAt: null, completedAt: null,
                firstContactedAt: new Date(2026, 9, 5), lastContactedAt: new Date(2026, 9, 6), lastRepliedAt: null, totalOpens: 1, totalClicks: 0, totalReplies: 0,
                createdAt: new Date(2026, 9, 1),
            },
            {
                id: 'cl-fresh', campaignId: CAMPAIGN, leadId: LEAD_FRESH, assignedEmailAccountId: ACCOUNT, status: 'new', currentStepOrder: 1,
                nextScheduledAt: new Date(2026, 9, 8), nextFollowUpAt: null, completedAt: null,
                firstContactedAt: null, lastContactedAt: null, lastRepliedAt: null, totalOpens: 0, totalClicks: 0, totalReplies: 0,
                createdAt: new Date(2026, 9, 2),
            },
        ],
        outreachEmails: [{ id: 'oe-1', organizationId: ORG, campaignLeadId: 'cl-mailed', sentAt: new Date(2026, 9, 5) }],
        emailAccounts: [{ id: ACCOUNT, organizationId: ORG, email: 'vanildo.jr@tryskaleclub.com' }],
        leadLists: [
            { id: LIST, organizationId: ORG, name: 'Barbershops MA', description: null, color: '#3B82F6', leadCount: 2 },
            { id: OTHER_LIST, organizationId: OTHER_ORG, name: 'Other tenant list', description: null, color: '#3B82F6', leadCount: 9 },
        ],
    })
    principalMock.mockReturnValue(principal(['outreach:read', 'outreach:manage']))
})

describe('GET /campaigns/:id/leads', () => {
    it('lists the roster with status, step and last event, paginated', async () => {
        const result = await server.call('GET', `/campaigns/${CAMPAIGN}/leads?limit=1&page=1`)
        expect(result.status).toBe(200)
        expect(result.body.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2 })
        expect(result.body.leads).toHaveLength(1)

        const all = await server.call('GET', `/campaigns/${CAMPAIGN}/leads`)
        const mailed = all.body.leads.find((entry: Row) => entry.leadId === LEAD_MAILED)
        expect(mailed).toMatchObject({
            email: `${LEAD_MAILED.slice(-1)}@barbershop.test`, status: 'contacted', currentStepOrder: 2,
            lastEvent: { type: 'email_sent' }, sendingInbox: { email: 'vanildo.jr@tryskaleclub.com' },
        })
    })

    it('filters by status', async () => {
        const result = await server.call('GET', `/campaigns/${CAMPAIGN}/leads?status=new`)
        expect(result.body.leads.map((entry: Row) => entry.leadId)).toEqual([LEAD_FRESH])
        expect((await server.call('GET', `/campaigns/${CAMPAIGN}/leads?status=nonsense`)).status).toBe(400)
    })

    it('needs outreach:read and answers 404 for another organization\'s campaign', async () => {
        principalMock.mockReturnValue(principal(['outreach:manage']))
        expect((await server.call('GET', `/campaigns/${CAMPAIGN}/leads`)).status).toBe(403)
        principalMock.mockReturnValue(principal(['outreach:read'], OTHER_ORG))
        expect((await server.call('GET', `/campaigns/${CAMPAIGN}/leads`)).status).toBe(404)
    })
})

describe('GET /leads/:leadId', () => {
    it('returns the lead and the campaigns it is in', async () => {
        const result = await server.call('GET', `/leads/${LEAD_MAILED}`)
        expect(result.status).toBe(200)
        expect(result.body.lead).toMatchObject({ id: LEAD_MAILED, companyName: 'Joe Barbers LLC', customFields: { shortName: 'Joe Barbers' } })
        expect(result.body.campaigns).toEqual([expect.objectContaining({ campaignId: CAMPAIGN, campaignName: 'Barbershops Pilot', currentStepOrder: 2 })])
    })

    it('does not show another organization\'s lead', async () => {
        expect((await server.call('GET', `/leads/${LEAD_OTHER_ORG}`)).status).toBe(404)
        principalMock.mockReturnValue(principal(['outreach:read'], OTHER_ORG))
        expect((await server.call('GET', `/leads/${LEAD_MAILED}`)).status).toBe(404)
        expect((await server.call('GET', '/leads/not-a-uuid')).status).toBe(404)
    })
})

describe('PATCH /leads/:leadId', () => {
    it('is refused without outreach:manage, and the denial is audited', async () => {
        principalMock.mockReturnValue(principal(['outreach:read']))
        const result = await server.call('PATCH', `/leads/${LEAD_MAILED}`, { firstName: 'Mike' })
        expect(result.status).toBe(403)
        expect(stored(LEAD_MAILED).firstName).toBe('Joe')
        expect(state.deniedAudits[0]).toMatchObject({ action: 'agent.scope.denied' })
    })

    it('treats another organization\'s lead as not found and changes nothing', async () => {
        const result = await server.call('PATCH', `/leads/${LEAD_OTHER_ORG}`, { firstName: 'Hijacked' })
        expect(result.status).toBe(404)
        expect(stored(LEAD_OTHER_ORG).firstName).toBe('Joe')
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        expect((await server.call('PATCH', `/leads/${LEAD_MAILED}`, { firstName: 'Hijacked' })).status).toBe(404)
        expect(stored(LEAD_MAILED).firstName).toBe('Joe')
        expect(state.audits).toHaveLength(0)
    })

    it('is partial, merges customFields key by key and audits before/after through the transaction', async () => {
        const result = await server.call('PATCH', `/leads/${LEAD_MAILED}`, {
            firstName: 'Mike',
            shortName: 'Mike\'s Cuts',
            customFields: { has_owned_website: true, booking: 'booksy' },
            reason: 'owner confirmed on the phone',
        })
        expect(result.status).toBe(200)
        expect(result.body.changedFields.sort()).toEqual(['customFields', 'firstName'])
        expect(stored(LEAD_MAILED)).toMatchObject({
            firstName: 'Mike', companyName: 'Joe Barbers LLC', location: '1 Main St, Hudson, MA 01749', status: 'contacted',
            customFields: { shortName: 'Mike\'s Cuts', has_owned_website: true, booking: 'booksy', email_status: 'ok' },
        })
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
            action: 'agent.lead.updated',
            resourceType: 'lead',
            metadata: {
                reason: 'owner confirmed on the phone',
                before: { firstName: 'Joe', customFields: { shortName: 'Joe Barbers', has_owned_website: false, booking: null } },
                after: { firstName: 'Mike', customFields: { shortName: 'Mike\'s Cuts', has_owned_website: true, booking: 'booksy' } },
            },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
    })

    it('removes custom fields on request and clears a value with null', async () => {
        await server.call('PATCH', `/leads/${LEAD_MAILED}`, { removeCustomFields: ['has_owned_website'], phone: null })
        expect(stored(LEAD_MAILED).customFields).toEqual({ shortName: 'Joe Barbers', email_status: 'ok' })
        expect(stored(LEAD_MAILED).phone).toBeNull()
    })

    it('rolls the update back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        const result = await server.call('PATCH', `/leads/${LEAD_MAILED}`, { firstName: 'Mike' })
        expect(result.status).toBe(500)
        expect(stored(LEAD_MAILED).firstName).toBe('Joe')
    })

    it('cannot change email, status, verification or unsubscribe state (strict schema)', async () => {
        for (const body of [
            { email: 'someone@else.test' },
            { status: 'interested' },
            { emailVerificationStatus: 'verified' },
            { unsubscribedAt: null },
            { leadListId: LIST },
        ]) {
            expect((await server.call('PATCH', `/leads/${LEAD_MAILED}`, body)).status, JSON.stringify(body)).toBe(400)
        }
        expect(stored(LEAD_MAILED)).toMatchObject({ status: 'contacted', emailVerificationStatus: 'verified' })
        expect(state.audits).toHaveLength(0)
    })

    it('refuses the customFields keys that carry verification and attribution', async () => {
        for (const key of ['email_status', 'email_verification_provider', 'source_run_id', 'xcraper_run_id', 'outcome_replied', 'unsubscribed_at', 'constructor']) {
            const result = await server.call('PATCH', `/leads/${LEAD_MAILED}`, { customFields: { [key]: 'x' } })
            expect(result.status, key).toBe(422)
            expect(result.body.code).toBe('reserved_custom_field')
        }
        expect((await server.call('PATCH', `/leads/${LEAD_MAILED}`, { removeCustomFields: ['email_status'] })).status).toBe(422)
        expect(stored(LEAD_MAILED).customFields.email_status).toBe('ok')
    })

    it('cannot pollute prototypes through a __proto__ key', async () => {
        await server.call('PATCH', `/leads/${LEAD_MAILED}`, { customFields: JSON.parse('{"__proto__": {"polluted": true}, "note": "ok"}') })
        expect(({} as Row).polluted).toBeUndefined()
        expect(stored(LEAD_MAILED).customFields.polluted).toBeUndefined()
    })

    it('treats an identical payload and an empty payload correctly', async () => {
        const same = await server.call('PATCH', `/leads/${LEAD_MAILED}`, { firstName: 'Joe' })
        expect(same.status).toBe(200)
        expect(same.body.changed).toBe(false)
        expect(state.audits).toHaveLength(0)
        expect((await server.call('PATCH', `/leads/${LEAD_MAILED}`, {})).status).toBe(400)
    })
})

describe('DELETE /campaigns/:id/leads/:leadId', () => {
    const path = (leadId: string, campaignId = CAMPAIGN) => `/campaigns/${campaignId}/leads/${leadId}`

    it('answers 409 without confirm and describes what would happen, changing nothing', async () => {
        const result = await server.call('DELETE', path(LEAD_MAILED))
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('confirmation_required')
        expect(result.body.willDo).toMatchObject({ effect: 'stopped', emailsAlreadySent: 1, currentStepOrder: 2, lead: { id: LEAD_MAILED } })
        expect(result.body.willDo.consequence).toContain('No further emails')

        const fresh = await server.call('DELETE', path(LEAD_FRESH), { confirm: false })
        expect(fresh.status).toBe(409)
        expect(fresh.body.willDo.effect).toBe('deleted')

        expect(rows('campaignLeads')).toHaveLength(2)
        expect(rows('campaignLeads')[0].nextScheduledAt).not.toBeNull()
        expect(state.audits).toHaveLength(0)
    })

    it('stops the sequence of a lead that was already mailed, keeping the send history', async () => {
        const result = await server.call('DELETE', path(LEAD_MAILED), { confirm: true, reason: 'owner asked to stop' })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ removed: true, effect: 'stopped', emailsAlreadySent: 1 })
        const row = rows('campaignLeads').find((entry) => entry.id === 'cl-mailed')!
        expect(row.nextScheduledAt).toBeNull()
        expect(row.nextFollowUpAt).toBeNull()
        expect(row.completedAt).toBeInstanceOf(Date)
        expect(rows('outreachEmails')).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
            action: 'agent.campaign.lead_removed',
            resourceId: CAMPAIGN,
            metadata: { leadId: LEAD_MAILED, effect: 'stopped', emailsAlreadySent: 1, reason: 'owner asked to stop' },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
    })

    it('deletes the enrollment of a lead that was never mailed', async () => {
        const result = await server.call('DELETE', path(LEAD_FRESH), { confirm: true })
        expect(result.status).toBe(200)
        expect(result.body.effect).toBe('deleted')
        expect(rows('campaignLeads').map((entry) => entry.id)).toEqual(['cl-mailed'])
        expect(state.sqlSets).toContainEqual({ table: 'campaigns', column: 'totalLeads' })
        // The lead itself stays in the organization's lead table.
        expect(stored(LEAD_FRESH)).toBeDefined()
    })

    it('rolls the removal back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        const result = await server.call('DELETE', path(LEAD_FRESH), { confirm: true })
        expect(result.status).toBe(500)
        expect(rows('campaignLeads')).toHaveLength(2)
    })

    it('is refused without outreach:manage and does not cross organizations', async () => {
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('DELETE', path(LEAD_FRESH), { confirm: true })).status).toBe(403)
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        expect((await server.call('DELETE', path(LEAD_FRESH), { confirm: true })).status).toBe(404)
        principalMock.mockReturnValue(principal(['outreach:manage']))
        // A lead of another organization, even inside this organization's campaign path.
        expect((await server.call('DELETE', path(LEAD_OTHER_ORG), { confirm: true })).status).toBe(404)
        expect((await server.call('DELETE', path(LEAD_FRESH, OTHER_ORG_CAMPAIGN), { confirm: true })).status).toBe(404)
        expect(rows('campaignLeads')).toHaveLength(2)
    })

    it('answers 404 for a lead that is not on the campaign, and rejects a non-boolean confirm', async () => {
        rows('campaignLeads').length = 0
        expect((await server.call('DELETE', path(LEAD_FRESH), { confirm: true })).status).toBe(404)
        expect((await server.call('DELETE', path(LEAD_FRESH), { confirm: 'yes' })).status).toBe(400)
    })
})

describe('lead lists', () => {
    it('lists only the organization\'s lists', async () => {
        const result = await server.call('GET', '/lead-lists')
        expect(result.status).toBe(200)
        expect(result.body.leadLists.map((entry: Row) => entry.id)).toEqual([LIST])
        expect(result.body.pagination.total).toBe(1)
    })

    it('creates a list in the principal\'s organization, with audit through the transaction', async () => {
        const result = await server.call('POST', '/lead-lists', { name: 'Barbershops NH', color: '#112233' })
        expect(result.status).toBe(201)
        const created = rows('leadLists').find((entry) => entry.id === result.body.leadList.id)!
        expect(created).toMatchObject({ organizationId: ORG, name: 'Barbershops NH', color: '#112233' })
        expect(state.audits[0]).toMatchObject({ action: 'agent.lead_list.created', resourceId: created.id })
        expect(state.audits[0].executor.isTransaction).toBe(true)
    })

    it('rejects an organizationId smuggled into the body (strict schema)', async () => {
        const result = await server.call('POST', '/lead-lists', { name: 'Sneaky', organizationId: OTHER_ORG })
        expect(result.status).toBe(400)
        expect(rows('leadLists')).toHaveLength(2)
    })

    it('updates a list partially and refuses another organization\'s list', async () => {
        const result = await server.call('PATCH', `/lead-lists/${LIST}`, { description: 'MA barbershops', reason: 'doc' })
        expect(result.status).toBe(200)
        expect(rows('leadLists').find((entry) => entry.id === LIST)).toMatchObject({ name: 'Barbershops MA', description: 'MA barbershops' })
        expect(state.audits[0]).toMatchObject({ action: 'agent.lead_list.updated', metadata: { changedFields: ['description'] } })

        expect((await server.call('PATCH', `/lead-lists/${OTHER_LIST}`, { name: 'Hijacked' })).status).toBe(404)
        expect(rows('leadLists').find((entry) => entry.id === OTHER_LIST)!.name).toBe('Other tenant list')
    })

    it('needs the manage scope for writes', async () => {
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('POST', '/lead-lists', { name: 'x' })).status).toBe(403)
        expect((await server.call('PATCH', `/lead-lists/${LIST}`, { name: 'x' })).status).toBe(403)
        expect((await server.call('GET', '/lead-lists')).status).toBe(200)
    })
})
