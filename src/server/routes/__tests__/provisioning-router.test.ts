import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProvisioningRouter } from '../provisioning'
import { FakeProvisioningStore, TEST_CONFIG, verifiedUpdate } from '../../lib/__tests__/helpers/fake-provisioning-store'
import type { ProvisioningConfig } from '../../lib/microsite-provisioning'

let server: Server
let base: string
let store: FakeProvisioningStore
let config: ProvisioningConfig | null

async function start(): Promise<void> {
    const app = express()
    app.use(express.json())
    app.use('/api/provisioning/v1', createProvisioningRouter({
        store,
        getConfig: () => config,
        checkDns: async () => verifiedUpdate(),
        rateLimitPerMinute: false,
    }))
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/provisioning/v1`
}

const auth = { authorization: `Bearer ${TEST_CONFIG.apiKey}`, 'content-type': 'application/json' }
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) =>
    fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })

describe('provisioning router', () => {
    beforeEach(async () => {
        store = new FakeProvisioningStore()
        config = { ...TEST_CONFIG }
        await start()
    })
    afterEach(async () => { await new Promise((resolve) => server.close(resolve)) })

    it('answers 503 provisioning_disabled for every route when unconfigured, before checking the token', async () => {
        config = null
        for (const [m, p] of [['GET', '/domains/a-site.com'], ['PUT', '/domains/a-site.com'], ['PUT', '/domains/a-site.com/mailboxes/info'], ['POST', '/domains/a-site.com/verify']] as const) {
            const res = await call(m, p, m === 'GET' ? undefined : {}, {})
            expect(res.status).toBe(503)
            expect(await res.json()).toEqual({ error: 'provisioning_disabled' })
        }
    })

    it('answers 401 invalid_token with no detail for a missing or wrong bearer token', async () => {
        for (const headers of [{} as Record<string, string>, { authorization: 'Bearer nope' }, { authorization: 'Basic abc' }, { authorization: `Bearer ${TEST_CONFIG.apiKey}x` }]) {
            const res = await call('GET', '/domains/a-site.com', undefined, headers)
            expect(res.status).toBe(401)
            expect(await res.json()).toEqual({ error: 'invalid_token' })
        }
        expect(store.writes).toEqual([])
    })

    it('maps invalid, protected, foreign and missing domains to the contract errors', async () => {
        store.foreignDomains.add('taken.com')
        expect((await call('GET', '/domains/Bad_Domain')).status).toBe(400)
        expect(await (await call('GET', '/domains/Bad_Domain')).json()).toEqual({ error: 'invalid_domain' })
        const prot = await call('PUT', '/domains/site.staging.skale.club', { siteRef: 'websites:tenant:1' })
        expect(prot.status).toBe(403)
        expect(await prot.json()).toEqual({ error: 'protected_domain' })
        const foreign = await call('PUT', '/domains/taken.com', { siteRef: 'websites:tenant:1' })
        expect(foreign.status).toBe(409)
        expect(await foreign.json()).toEqual({ error: 'domain_owned_elsewhere' })
        const missing = await call('GET', '/domains/nothing-here.com')
        expect(missing.status).toBe(404)
        expect(await missing.json()).toEqual({ error: 'domain_not_found' })
    })

    it('PUT domain: 201 when created, 200 when it already existed; GET then reads it', async () => {
        const created = await call('PUT', '/domains/acme-plumbing.com', { siteRef: 'websites:tenant:27' })
        expect(created.status).toBe(201)
        const again = await call('PUT', '/domains/acme-plumbing.com', { siteRef: 'websites:tenant:27' })
        expect(again.status).toBe(200)
        const body = await (await call('GET', '/domains/acme-plumbing.com')).json()
        expect(body).toMatchObject({ domain: 'acme-plumbing.com', state: 'not_provisioned', ready: false })
        expect(body.mailbox).toMatchObject({ address: 'info@acme-plumbing.com', exists: false, mailboxRef: null, messageCount: 0 })
        expect((await call('PUT', '/domains/acme-plumbing.com', {})).status).toBe(400)
    })

    it('PUT mailbox ensures the domain in the same call and returns the full status', async () => {
        const res = await call('PUT', '/domains/acme-plumbing.com/mailboxes/info', { siteRef: 'websites:tenant:27' })
        expect(res.status).toBe(201)
        const body = await res.json()
        expect(body.mailbox.exists).toBe(true)
        expect(body.state).toBe('dns_pending')
        expect(body.dnsRecords.length).toBeGreaterThan(0)
        const repeat = await call('PUT', '/domains/acme-plumbing.com/mailboxes/info', {})
        expect(repeat.status).toBe(200)
        expect(store.mailboxes.size).toBe(1)
    })

    it('PUT mailbox without siteRef for an unknown domain is a 400, never a silent create', async () => {
        const res = await call('PUT', '/domains/brand-new.com/mailboxes/info', {})
        expect(res.status).toBe(400)
        expect(store.domains.size).toBe(0)
    })

    it('POST verify returns the refreshed status; unknown domain is 404', async () => {
        await call('PUT', '/domains/acme-plumbing.com/mailboxes/info', { siteRef: 'websites:tenant:27' })
        const res = await call('POST', '/domains/acme-plumbing.com/verify')
        expect(res.status).toBe(200)
        expect((await res.json()).state).toBe('inbound_pending')
        expect((await call('POST', '/domains/unknown-one.com/verify')).status).toBe(404)
    })

    it('has no DELETE route', async () => {
        const res = await call('DELETE', '/domains/acme-plumbing.com')
        expect(res.status).toBe(404)
    })

    it('does not leak internals on an unexpected error', async () => {
        store.lookupDomain = async () => { throw new Error('connection to db.internal:5432 failed') }
        const res = await call('GET', '/domains/acme-plumbing.com')
        expect(res.status).toBe(500)
        expect(await res.json()).toEqual({ error: 'internal_error' })
    })
})
