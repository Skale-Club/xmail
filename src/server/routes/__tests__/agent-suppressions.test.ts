import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reset, rows, startServer, state, type TestServer } from './fake-agent-db'

/**
 * Route tests for the Hermes suppression list. Guards proven here: add is idempotent and audited
 * through the transaction, a free-mail domain block is refused, removal needs confirm: true (409
 * with a description first), the agent can lift only manual suppressions (never an unsubscribe,
 * complaint or bounce), and everything is tenant-scoped.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const MANUAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const UNSUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const COMPLAINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
const BOUNCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'
const DOMAIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6'

const principalMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', async () => ({ db: (await import('./fake-agent-db')).fakeDb }))
vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: principalMock,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))
vi.mock('../../lib/agent-audit', async () => ({ writeAgentAudit: (await import('./fake-agent-db')).recordAudit }))
// The sentinel is the only thing the route takes from the inbox module (its real definition pulls
// the whole inbox operator in); this is the same one-line rule.
vi.mock('../../lib/inbox-suppression', () => ({ domainSuppressionKey: (domain: string) => `@${domain.trim().toLowerCase()}` }))

let server: TestServer
const principal = (scopes: string[], organizationId = ORG) => ({ credentialId: 'cred-1', organizationId, principalUserId: 'user-1', scopes })
const row = (id: string, emailAddress: string, source: string, organizationId = ORG) => ({
    id, organizationId, emailAddress, source, reason: `${source}_reason`, createdAt: new Date(),
})

beforeAll(async () => {
    server = await startServer((await import('../agent-suppressions')).default)
}, 60_000)
afterAll(async () => { await server.close() })

beforeEach(() => {
    reset({
        suppressions: [
            row(MANUAL, 'owner@barbershop.test', 'manual'),
            row(UNSUB, 'unsub@barbershop.test', 'unsubscribe'),
            row(COMPLAINT, 'angry@barbershop.test', 'complaint'),
            row(BOUNCE, 'gone@barbershop.test', 'bounce'),
            row(DOMAIN, '@competitor.test', 'manual'),
            row(FOREIGN, 'other@tenant.test', 'manual', OTHER_ORG),
        ],
    }, { suppressions: [['organizationId', 'emailAddress']] })
    principalMock.mockReturnValue(principal(['outreach:read', 'outreach:manage']))
})

describe('GET /suppressions', () => {
    it('lists only the organization\'s entries and says which ones the agent may lift', async () => {
        const result = await server.call('GET', '/suppressions')
        expect(result.status).toBe(200)
        expect(result.body.suppressions.map((entry: any) => entry.id).sort()).toEqual([MANUAL, UNSUB, COMPLAINT, BOUNCE, DOMAIN].sort())
        const byId = Object.fromEntries(result.body.suppressions.map((entry: any) => [entry.id, entry]))
        expect(byId[DOMAIN]).toMatchObject({ scope: 'domain', value: 'competitor.test', removableByAgent: true })
        expect(byId[MANUAL]).toMatchObject({ scope: 'address', removableByAgent: true })
        expect(byId[UNSUB].removableByAgent).toBe(false)
        expect(result.body.pagination.total).toBe(5)
    })

    it('needs outreach:read', async () => {
        principalMock.mockReturnValue(principal(['outreach:manage']))
        expect((await server.call('GET', '/suppressions')).status).toBe(403)
    })
})

describe('POST /suppressions', () => {
    it('adds an address, lowercased, as a manual suppression, auditing through the transaction', async () => {
        const result = await server.call('POST', '/suppressions', { email: ' Rude@Barbershop.TEST ', reason: 'asked to stop on the phone' })
        expect(result.status).toBe(201)
        expect(result.body).toMatchObject({ added: true, suppression: { scope: 'address', value: 'rude@barbershop.test', source: 'manual' } })
        expect(rows('suppressions').find((entry) => entry.emailAddress === 'rude@barbershop.test')).toMatchObject({ organizationId: ORG, source: 'manual' })
        expect(state.audits[0]).toMatchObject({
            action: 'agent.suppression.added',
            metadata: { scope: 'address', value: 'rude@barbershop.test', reason: 'asked to stop on the phone' },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
    })

    it('adds a domain as the @domain sentinel the delivery policy matches', async () => {
        const result = await server.call('POST', '/suppressions', { domain: 'Rival-Shop.com' })
        expect(result.status).toBe(201)
        expect(rows('suppressions').some((entry) => entry.emailAddress === '@rival-shop.com' && entry.organizationId === ORG)).toBe(true)
    })

    it('is idempotent: an existing entry is reported, not duplicated or re-audited', async () => {
        const result = await server.call('POST', '/suppressions', { email: 'owner@barbershop.test' })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ added: false, alreadySuppressed: true })
        expect(rows('suppressions').filter((entry) => entry.emailAddress === 'owner@barbershop.test')).toHaveLength(1)
        expect(state.audits).toHaveLength(0)
    })

    it('refuses a free-mail domain block and needs exactly one of email or domain', async () => {
        const gmail = await server.call('POST', '/suppressions', { domain: 'gmail.com' })
        expect(gmail.status).toBe(422)
        expect(gmail.body.code).toBe('suppression_public_domain')
        expect((await server.call('POST', '/suppressions', {})).status).toBe(400)
        expect((await server.call('POST', '/suppressions', { email: 'a@b.test', domain: 'b.test' })).status).toBe(400)
        expect((await server.call('POST', '/suppressions', { domain: 'not a domain' })).status).toBe(400)
        expect((await server.call('POST', '/suppressions', { email: 'a@b.test', organizationId: OTHER_ORG })).status).toBe(400)
        expect(rows('suppressions')).toHaveLength(6)
    })

    it('writes into the credential\'s organization only, and rolls back when the audit cannot be written', async () => {
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        await server.call('POST', '/suppressions', { email: 'new@barbershop.test' })
        expect(rows('suppressions').find((entry) => entry.emailAddress === 'new@barbershop.test')!.organizationId).toBe(OTHER_ORG)

        state.failNextAudit = true
        expect((await server.call('POST', '/suppressions', { email: 'ghost@barbershop.test' })).status).toBe(500)
        expect(rows('suppressions').some((entry) => entry.emailAddress === 'ghost@barbershop.test')).toBe(false)
    })

    it('needs the manage scope, and the denial is audited', async () => {
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('POST', '/suppressions', { email: 'a@b.test' })).status).toBe(403)
        expect(state.deniedAudits).toHaveLength(1)
    })
})

describe('DELETE /suppressions/:id', () => {
    it('answers 409 without confirm, describing what lifting does, and removes nothing', async () => {
        const result = await server.call('DELETE', `/suppressions/${MANUAL}`)
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('confirmation_required')
        expect(result.body.willDo).toMatchObject({ action: 'lift suppression', scope: 'address', value: 'owner@barbershop.test' })
        expect(result.body.willDo.consequence).toContain('may email owner@barbershop.test again')
        expect((await server.call('DELETE', `/suppressions/${DOMAIN}`, { confirm: false })).body.willDo.consequence).toContain('every address at competitor.test')
        expect(rows('suppressions')).toHaveLength(6)
        expect(state.audits).toHaveLength(0)
    })

    it('lifts a manual suppression with confirm: true, auditing through the transaction', async () => {
        const result = await server.call('DELETE', `/suppressions/${MANUAL}`, { confirm: true, reason: 'owner re-subscribed by phone' })
        expect(result.status).toBe(200)
        expect(result.body.removed).toBe(true)
        expect(rows('suppressions').some((entry) => entry.id === MANUAL)).toBe(false)
        expect(state.audits[0]).toMatchObject({
            action: 'agent.suppression.removed',
            metadata: { suppressionId: MANUAL, value: 'owner@barbershop.test', source: 'manual', reason: 'owner re-subscribed by phone' },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
    })

    it.each([[UNSUB, 'unsubscribe'], [COMPLAINT, 'complaint'], [BOUNCE, 'bounce']])('never lifts a %s suppression, even with confirm: true', async (id, source) => {
        const result = await server.call('DELETE', `/suppressions/${id}`, { confirm: true })
        expect(result.status).toBe(403)
        expect(result.body).toMatchObject({ code: 'suppression_not_removable_by_agent', source })
        expect(rows('suppressions').some((entry) => entry.id === id)).toBe(true)
        expect(state.audits).toHaveLength(0)
    })

    it('rolls the removal back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        expect((await server.call('DELETE', `/suppressions/${MANUAL}`, { confirm: true })).status).toBe(500)
        expect(rows('suppressions').some((entry) => entry.id === MANUAL)).toBe(true)
    })

    it('does not touch another organization\'s entry, and needs the manage scope', async () => {
        expect((await server.call('DELETE', `/suppressions/${FOREIGN}`, { confirm: true })).status).toBe(404)
        expect(rows('suppressions').some((entry) => entry.id === FOREIGN)).toBe(true)
        expect((await server.call('DELETE', '/suppressions/not-a-uuid', { confirm: true })).status).toBe(404)
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('DELETE', `/suppressions/${MANUAL}`, { confirm: true })).status).toBe(403)
        expect(rows('suppressions').some((entry) => entry.id === MANUAL)).toBe(true)
    })
})
