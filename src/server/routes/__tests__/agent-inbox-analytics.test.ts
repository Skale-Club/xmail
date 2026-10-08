import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reset, startServer, state, type Row, type TestServer } from './fake-agent-db'

/**
 * Route tests for the read-only parts of the Hermes gateway: the unified-inbox window and the
 * metrics. Guards proven here: reads need outreach:read, the organization is the credential's in
 * every query (the inbox layer receives it, the metrics SQL carries it as a bound parameter),
 * another organization's thread is a 404, message bodies are shaped for an agent (plain text only,
 * flagged as untrusted), and neither module exposes any write route.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CAMPAIGN = '22222222-2222-4222-8222-222222222222'

const principalMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const detailMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', async () => ({ db: (await import('./fake-agent-db')).fakeDb }))
vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: principalMock,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))
vi.mock('../../lib/agent-audit', async () => ({ writeAgentAudit: (await import('./fake-agent-db')).recordAudit }))
vi.mock('../../lib/unified-inbox/queries', () => ({
    INBOX_VIEWS: ['inbox', 'needs_reply', 'awaiting', 'unread', 'reminders', 'archived'],
    listConversations: listMock,
    getConversationDetail: detailMock,
}))

let inbox: TestServer
let analytics: TestServer
const principal = (scopes: string[], organizationId = ORG) => ({ credentialId: 'cred-1', organizationId, principalUserId: 'user-1', scopes })

beforeAll(async () => {
    inbox = await startServer((await import('../agent-inbox')).default)
    analytics = await startServer((await import('../agent-analytics')).default)
}, 60_000)
afterAll(async () => {
    await inbox.close()
    await analytics.close()
})

beforeEach(() => {
    reset({})
    listMock.mockReset()
    detailMock.mockReset()
    principalMock.mockReturnValue(principal(['outreach:read']))
})

describe('GET /inbox/conversations', () => {
    it('lists threads for the credential\'s organization and the human principal, never marking anything read', async () => {
        listMock.mockResolvedValue({
            conversations: [{
                id: CONVERSATION, emailAccountId: 'acc', leadId: 'lead', campaignId: CAMPAIGN, campaignLeadId: 'cl', status: 'open', subject: 'Re: quick question',
                preview: 'Sounds good', lastMessageAt: new Date(), lastInboundAt: new Date(), lastOutboundAt: null, archived: false, unread: true,
                lastInboundClassification: 'reply', reminderDue: false, participants: [{ address: 'joe@barbershop.test', name: 'Joe', role: 'from' }], labels: [],
            }],
            nextCursor: null,
            hasMore: false,
        })
        const result = await inbox.call('GET', `/inbox/conversations?view=needs_reply&campaignId=${CAMPAIGN}&limit=10`)
        expect(result.status).toBe(200)
        expect(result.body.untrustedContent).toBe(true)
        expect(result.body.conversations[0]).toMatchObject({ id: CONVERSATION, lastInboundClassification: 'reply', unread: true })
        expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
            organizationId: ORG,
            userId: 'user-1',
            limit: 10,
            filters: expect.objectContaining({ view: 'needs_reply', campaignId: CAMPAIGN }),
        }))
    })

    it('takes the organization from the credential, ignoring one in the query string', async () => {
        listMock.mockResolvedValue({ conversations: [], nextCursor: null, hasMore: false })
        await inbox.call('GET', `/inbox/conversations?organizationId=${OTHER_ORG}`)
        expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG }))
        principalMock.mockReturnValue(principal(['outreach:read'], OTHER_ORG))
        await inbox.call('GET', '/inbox/conversations')
        expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ organizationId: OTHER_ORG }))
    })

    it('needs outreach:read and rejects a bad view or limit', async () => {
        principalMock.mockReturnValue(principal(['campaigns:copy']))
        expect((await inbox.call('GET', '/inbox/conversations')).status).toBe(403)
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await inbox.call('GET', '/inbox/conversations?view=everything')).status).toBe(400)
        expect((await inbox.call('GET', '/inbox/conversations?limit=500')).status).toBe(400)
        expect(listMock).not.toHaveBeenCalled()
    })
})

describe('GET /inbox/conversations/:id', () => {
    const detail = () => ({
        conversation: { id: CONVERSATION, status: 'open', subject: 'Re: quick question', unread: true },
        participants: [{ address: 'joe@barbershop.test', name: 'Joe', role: 'from' }],
        messages: [{
            id: 'm1', direction: 'inbound', provider: 'smtp', subject: 'Re: quick question', fromAddress: 'joe@barbershop.test', fromName: 'Joe',
            toAddresses: [{ address: 'vanildo.jr@tryskaleclub.com' }], ccAddresses: [], bccAddresses: [{ address: 'hidden@x.test' }],
            plainBody: 'x'.repeat(25_000), htmlBody: '<p>html</p>', headers: { 'x-secret-header': 'nope' },
            attachments: [{ filename: 'a.pdf', size: 10 }], hasAttachments: true, classification: 'reply', sentAt: null, receivedAt: new Date(), createdAt: new Date(),
        }],
    })

    it('returns the thread as plain text only, truncated, flagged untrusted, without headers, html or bcc', async () => {
        detailMock.mockResolvedValue(detail())
        const result = await inbox.call('GET', `/inbox/conversations/${CONVERSATION}`)
        expect(result.status).toBe(200)
        expect(result.body.untrustedContent).toBe(true)
        const message = result.body.messages[0]
        expect(message).toMatchObject({ direction: 'inbound', classification: 'reply', bodyTruncated: true, hasAttachments: true, attachmentCount: 1 })
        expect(message.plainBody).toHaveLength(20_000)
        expect(JSON.stringify(result.body)).not.toMatch(/htmlBody|x-secret-header|hidden@x\.test|bccAddresses|a\.pdf/)
        expect(detailMock).toHaveBeenCalledWith({ organizationId: ORG, conversationId: CONVERSATION, userId: 'user-1' })
    })

    it('answers 404 when the conversation is not in the organization or the id is malformed', async () => {
        detailMock.mockResolvedValue(null)
        principalMock.mockReturnValue(principal(['outreach:read'], OTHER_ORG))
        expect((await inbox.call('GET', `/inbox/conversations/${CONVERSATION}`)).status).toBe(404)
        expect(detailMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: OTHER_ORG }))
        expect((await inbox.call('GET', '/inbox/conversations/not-a-uuid')).status).toBe(404)
    })

    it('has no write route: nothing but GET answers on the inbox paths', async () => {
        for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
            expect((await inbox.call(method, `/inbox/conversations/${CONVERSATION}`, {})).status, method).toBe(404)
        }
        expect((await inbox.call('POST', '/inbox/conversations', {})).status).toBe(404)
    })
})

describe('GET /analytics/*', () => {
    function stubRows(rows: Row[]) {
        state.executeHandler = () => rows
    }
    const campaignRow = { id: CAMPAIGN, name: 'Barbershops Pilot', status: 'active', sent: 10, delivered: 9, opens: 4, clicks: 1, replies: 2, bounces: 1, unsubscribes: 1 }

    it('returns per-campaign metrics with rates and totals, scoped to the credential\'s organization in the SQL', async () => {
        stubRows([campaignRow, { ...campaignRow, id: 'c2', name: 'Second', sent: 10, delivered: 10, opens: 0, clicks: 0, replies: 0, bounces: 0, unsubscribes: 0 }])
        const result = await analytics.call('GET', '/analytics/campaigns?from=2026-10-01&to=2026-10-07')
        expect(result.status).toBe(200)
        expect(result.body.grain).toBe('email')
        expect(result.body.campaigns[0]).toMatchObject({ campaignId: CAMPAIGN, sent: 10, delivered: 9, opens: 4, clicks: 1, replies: 2, bounces: 1, unsubscribes: 1 })
        expect(result.body.campaigns[0].rates).toMatchObject({ openRatePercent: 40, replyRatePercent: 20, bounceRatePercent: 10, unsubscribeRatePercent: 10 })
        expect(result.body.totals).toMatchObject({ sent: 20, replies: 2 })
        // date-only "to" is inclusive of the whole day
        expect(result.body.range).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' })

        const query = state.executed[0]
        expect(query.sql).toContain('e.organization_id = $1::uuid')
        expect(query.sql).toContain('c.organization_id = e.organization_id')
        expect(query.params[0]).toBe(ORG)
    })

    it('scopes by the caller\'s organization, whatever the client sends', async () => {
        stubRows([])
        principalMock.mockReturnValue(principal(['outreach:read'], OTHER_ORG))
        await analytics.call('GET', `/analytics/campaigns?organizationId=${ORG}`)
        expect(state.executed[0].params[0]).toBe(OTHER_ORG)
        expect(state.executed[0].params).not.toContain(ORG)
    })

    it('returns per-inbox metrics selecting only the inbox address and status', async () => {
        stubRows([{ id: 'acc-1', name: 'vanildo.jr@tryskaleclub.com', status: 'verified', sent: 5, delivered: 5, opens: 1, clicks: 0, replies: 1, bounces: 0, unsubscribes: 0 }])
        const result = await analytics.call('GET', '/analytics/email-accounts')
        expect(result.status).toBe(200)
        expect(result.body.emailAccounts[0]).toMatchObject({ emailAccountId: 'acc-1', email: 'vanildo.jr@tryskaleclub.com', sent: 5 })
        expect(state.executed[0].sql).toContain('a.organization_id = e.organization_id')
        expect(state.executed[0].sql).not.toMatch(/password|smtp_|imap_/i)
    })

    it('rejects an inverted or oversized range, a bad date and a bad id, without querying', async () => {
        stubRows([])
        expect((await analytics.call('GET', '/analytics/campaigns?from=2026-10-07&to=2026-10-01')).status).toBe(400)
        expect((await analytics.call('GET', '/analytics/campaigns?from=2024-01-01&to=2026-01-01')).body.code).toBe('range_too_large')
        expect((await analytics.call('GET', '/analytics/campaigns?from=yesterday-ish')).status).toBe(400)
        expect((await analytics.call('GET', '/analytics/campaigns?campaignId=nope')).status).toBe(400)
        expect(state.executed).toHaveLength(0)
    })

    it('needs outreach:read', async () => {
        principalMock.mockReturnValue(principal(['campaigns:copy']))
        expect((await analytics.call('GET', '/analytics/campaigns')).status).toBe(403)
        expect((await analytics.call('GET', '/analytics/email-accounts')).status).toBe(403)
    })
})
