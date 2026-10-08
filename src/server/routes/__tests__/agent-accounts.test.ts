import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reset, rows, startServer, state, type Row, type TestServer } from './fake-agent-db'

/**
 * Route tests for the Hermes view of outreach inboxes. Guards proven here: no secret column is
 * ever selected or returned, the PATCH cannot touch identity (provider, credentials) or the
 * switches behind the three-mailbox rule (warmupOnly, warmupSource), cannot weaken the warm-up
 * gate, is tenant-scoped, and audits through the transaction.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const GOOD = '66666666-6666-4666-8666-666666666661'
const INFO = '66666666-6666-4666-8666-666666666662'
const SEED = '66666666-6666-4666-8666-666666666663'
const FOREIGN = '66666666-6666-4666-8666-666666666664'

const principalMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', async () => ({ db: (await import('./fake-agent-db')).fakeDb }))
vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: principalMock,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))
vi.mock('../../lib/agent-audit', async () => ({ writeAgentAudit: (await import('./fake-agent-db')).recordAudit }))

let server: TestServer
const principal = (scopes: string[], organizationId = ORG) => ({ credentialId: 'cred-1', organizationId, principalUserId: 'user-1', scopes })

function account(id: string, email: string, overrides: Row = {}): Row {
    return {
        id, organizationId: ORG, email, displayName: null, provider: 'smtp', mailboxProvider: 'icemail', status: 'verified', lastError: null,
        dailySendLimit: 15, currentDailySent: 4, minMinutesBetweenEmails: 5, maxMinutesBetweenEmails: 30,
        warmupEnabled: true, warmupDays: 14, warmupCurrentDay: 7, warmupSource: 'internal', warmupOnly: false, warmupSentToday: 2,
        verifiedAt: null, lastSentAt: null, totalSent: 100, totalOpens: 40, totalClicks: 5, totalReplies: 10, totalBounces: 2,
        smtpHost: 'smtp.gmail.com', smtpUsername: 'secret-user@gmail.test', smtpPassword: 'ENCRYPTED-SMTP-SECRET',
        imapHost: 'imap.gmail.com', imapUsername: 'secret-user@gmail.test', imapPassword: 'ENCRYPTED-IMAP-SECRET', providerRef: 'vendor-ref',
        ...overrides,
    }
}
const stored = (id: string) => rows('emailAccounts').find((row) => row.id === id)!

beforeAll(async () => {
    process.env.ENCRYPTION_KEY ||= 'test-encryption-key'
    server = await startServer((await import('../agent-accounts')).default)
}, 60_000)
afterAll(async () => { await server.close() })

beforeEach(() => {
    process.env.OUTREACH_PROTECTED_DOMAINS = 'xkedule.com,skale.club'
    reset({
        emailAccounts: [
            account(GOOD, 'vanildo.jr@tryskaleclub.com'),
            account(INFO, 'info@xkedule.com', { warmupSource: 'none', warmupEnabled: false }),
            account(SEED, 'contato@tryskaleclub.com', { warmupOnly: true }),
            account(FOREIGN, 'sender@other.test', { organizationId: OTHER_ORG }),
        ],
    })
    principalMock.mockReturnValue(principal(['outreach:read', 'outreach:manage']))
    // The list reads the 7-day send counts with one raw statement; no rows = nothing sent yet.
    state.executeHandler = () => []
})

describe('GET /email-accounts', () => {
    it('lists the organization\'s inboxes with limits, warm-up and health, and no secret of any kind', async () => {
        const result = await server.call('GET', '/email-accounts')
        expect(result.status).toBe(200)
        expect(result.body.emailAccounts.map((entry: Row) => entry.email).sort()).toEqual([
            'contato@tryskaleclub.com', 'info@xkedule.com', 'vanildo.jr@tryskaleclub.com',
        ])
        const good = result.body.emailAccounts.find((entry: Row) => entry.id === GOOD)
        expect(good).toMatchObject({
            provider: 'smtp', status: 'verified', campaignSenderEligible: true,
            limits: { dailySendLimit: 15, sentToday: 4 },
            warmup: { enabled: true, currentDay: 7, source: 'internal', warmupOnly: false },
            health: { totalSent: 100, bounceRatePercent: 2, replyRatePercent: 10 },
        })
        const text = JSON.stringify(result.body)
        expect(text).not.toMatch(/ENCRYPTED|smtpPassword|imapPassword|smtpHost|smtpUsername|imapHost|imapUsername|secret-user|gmail\.com|vendor-ref|providerRef/)
    })

    it('states the three-mailbox verdict: info@ and warm-up seeds are not campaign senders', async () => {
        const result = await server.call('GET', '/email-accounts')
        const eligibility = Object.fromEntries(result.body.emailAccounts.map((entry: Row) => [entry.email, entry.campaignSenderEligible]))
        expect(eligibility).toEqual({
            'vanildo.jr@tryskaleclub.com': true,
            'info@xkedule.com': false,
            'contato@tryskaleclub.com': false,
        })
    })

    it('adds a read-only ramp recommendation per inbox from the real 7-day counts', async () => {
        state.executeHandler = () => [{ id: GOOD, sent: 40, bounces: 0, complaints: 0, unsubscribes: 1 }]
        const result = await server.call('GET', '/email-accounts')

        const good = result.body.emailAccounts.find((entry: Row) => entry.id === GOOD)
        expect(good.rampRecommendation).toMatchObject({
            recommendedDailyLimit: 18,
            ready: true,
            basis: { windowDays: 7, sent: 40, bounces: 0, complaints: 0, unsubscribes: 1, unsubscribeRatePercent: 2.5 },
        })
        expect(good.rampRecommendation.reason).toContain('15 to 18')

        // Inboxes with no sends in the window get zeros, and an ineligible one is never ramped.
        const info = result.body.emailAccounts.find((entry: Row) => entry.id === INFO)
        expect(info.rampRecommendation).toMatchObject({ recommendedDailyLimit: 15, ready: false, basis: { sent: 0 } })

        // Advice only: nothing was written, so the limit is untouched.
        expect(stored(GOOD).dailySendLimit).toBe(15)
    })

    it('scopes the counts to the credential\'s organization and its inboxes', async () => {
        await server.call('GET', '/email-accounts')

        const query = state.executed.at(-1)!
        expect(query.sql).toMatch(/e\.organization_id = \$\d+::uuid/)
        expect(query.params).toContain(ORG)
        expect(query.params).toContain(GOOD)
        expect(query.params).not.toContain(FOREIGN)
    })

    it('never selects a credential column from the database', async () => {
        const { AGENT_ACCOUNT_COLUMNS } = await import('../../lib/agent-account-view')
        const keys = Object.keys(AGENT_ACCOUNT_COLUMNS)
        for (const forbidden of ['smtpPassword', 'imapPassword', 'smtpUsername', 'imapUsername', 'smtpHost', 'imapHost', 'providerRef', 'outlookMailboxId']) {
            expect(keys).not.toContain(forbidden)
        }
    })

    it('needs outreach:read and is paginated', async () => {
        principalMock.mockReturnValue(principal(['outreach:manage']))
        expect((await server.call('GET', '/email-accounts')).status).toBe(403)
        principalMock.mockReturnValue(principal(['outreach:read']))
        const page = await server.call('GET', '/email-accounts?limit=2&page=2')
        expect(page.body.emailAccounts).toHaveLength(1)
        expect(page.body.pagination).toMatchObject({ total: 3, totalPages: 2 })
    })
})

describe('PATCH /email-accounts/:id', () => {
    it('is refused without outreach:manage, and the denial is audited', async () => {
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 25 })).status).toBe(403)
        expect(stored(GOOD).dailySendLimit).toBe(15)
        expect(state.deniedAudits).toHaveLength(1)
    })

    it('treats another organization\'s inbox as not found and changes nothing', async () => {
        expect((await server.call('PATCH', `/email-accounts/${FOREIGN}`, { dailySendLimit: 25 })).status).toBe(404)
        expect(stored(FOREIGN).dailySendLimit).toBe(15)
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 25 })).status).toBe(404)
        expect(stored(GOOD).dailySendLimit).toBe(15)
        expect(state.audits).toHaveLength(0)
    })

    it('changes the daily limit and spacing, partially, auditing before/after through the transaction', async () => {
        const result = await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 25, minMinutesBetweenEmails: 8, reason: 'ramp is healthy' })
        expect(result.status).toBe(200)
        expect(result.body.changedFields.sort()).toEqual(['dailySendLimit', 'minMinutesBetweenEmails'])
        expect(stored(GOOD)).toMatchObject({ dailySendLimit: 25, minMinutesBetweenEmails: 8, maxMinutesBetweenEmails: 30, warmupDays: 14, warmupOnly: false, warmupSource: 'internal' })
        expect(state.audits[0]).toMatchObject({
            action: 'agent.email_account.updated',
            resourceId: GOOD,
            metadata: { reason: 'ramp is healthy', before: { dailySendLimit: 15, minMinutesBetweenEmails: 5 }, after: { dailySendLimit: 25, minMinutesBetweenEmails: 8 } },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
        expect(JSON.stringify(result.body)).not.toMatch(/ENCRYPTED|smtpPassword|imapPassword/)
        // The audit row carries the address, never a credential.
        expect(JSON.stringify(state.audits[0].metadata)).not.toMatch(/ENCRYPTED|secret-user/)
    })

    it('rolls the change back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 25 })).status).toBe(500)
        expect(stored(GOOD).dailySendLimit).toBe(15)
    })

    it('cannot change provider, credentials, hosts, warmupOnly, warmupSource or verification (strict schema)', async () => {
        for (const body of [
            { provider: 'native' },
            { smtpPassword: 'x' }, { imapPassword: 'x' }, { smtpUsername: 'x' }, { smtpHost: 'evil.test' }, { imapHost: 'evil.test' },
            { warmupOnly: false }, { warmupOnly: true }, { warmupSource: 'internal' }, { warmupSource: 'none' },
            { status: 'verified' }, { status: 'pending' }, { email: 'info@xkedule.com' }, { organizationId: OTHER_ORG },
        ]) {
            expect((await server.call('PATCH', `/email-accounts/${SEED}`, body)).status, JSON.stringify(body)).toBe(400)
        }
        expect(stored(SEED)).toMatchObject({ warmupOnly: true, warmupSource: 'internal', provider: 'smtp', smtpPassword: 'ENCRYPTED-SMTP-SECRET' })
        expect(state.audits).toHaveLength(0)
    })

    it('caps the daily limit the agent can set at 30 (warmed boxes get the column the same day)', async () => {
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 5000 })).status).toBe(400)
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 31 })).status).toBe(400)
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 30 })).status).toBe(200)
    })

    it('cannot weaken the warm-up gate: no shorter warm-up, no switching it off', async () => {
        const shorter = await server.call('PATCH', `/email-accounts/${GOOD}`, { warmupDays: 3 })
        expect(shorter.status).toBe(422)
        expect(shorter.body.code).toBe('warmup_cannot_be_weakened')
        const off = await server.call('PATCH', `/email-accounts/${GOOD}`, { warmupEnabled: false })
        expect(off.status).toBe(422)
        expect(off.body.code).toBe('warmup_cannot_be_weakened')
        expect(stored(GOOD)).toMatchObject({ warmupDays: 14, warmupEnabled: true })

        const longer = await server.call('PATCH', `/email-accounts/${GOOD}`, { warmupDays: 21 })
        expect(longer.status).toBe(200)
        expect(stored(GOOD).warmupDays).toBe(21)
    })

    it('can stop an inbox (pause) but nothing else about its status', async () => {
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, { status: 'paused' })).status).toBe(200)
        expect(stored(GOOD).status).toBe('paused')
    })

    it('validates the spacing range against the stored half', async () => {
        const result = await server.call('PATCH', `/email-accounts/${GOOD}`, { minMinutesBetweenEmails: 45 })
        expect(result.status).toBe(422)
        expect(result.body.code).toBe('invalid_spacing_range')
        expect(stored(GOOD).minMinutesBetweenEmails).toBe(5)
    })

    it('treats an identical payload as a no-op without an audit row', async () => {
        const result = await server.call('PATCH', `/email-accounts/${GOOD}`, { dailySendLimit: 15 })
        expect(result.body.changed).toBe(false)
        expect(state.audits).toHaveLength(0)
        expect((await server.call('PATCH', `/email-accounts/${GOOD}`, {})).status).toBe(400)
        expect((await server.call('PATCH', '/email-accounts/not-a-uuid', { dailySendLimit: 10 })).status).toBe(404)
    })
})
