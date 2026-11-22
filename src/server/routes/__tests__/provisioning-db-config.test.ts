import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProvisioningRouter, defaultConfigResolver } from '../provisioning'
import { FakeProvisioningStore, TEST_CONFIG, verifiedUpdate } from '../../lib/__tests__/helpers/fake-provisioning-store'
import type { ProvisioningConfig } from '../../lib/microsite-provisioning'

const KEY = 'db-held-provisioning-key-for-tests-only'
const dbConfig: ProvisioningConfig = {
    apiKey: '',
    apiKeySha256: createHash('sha256').update(KEY).digest('hex'),
    organizationId: TEST_CONFIG.organizationId,
    delegateUserIds: TEST_CONFIG.delegateUserIds,
}

let server: Server | undefined

async function start(loadConfigFromDb: () => Promise<ProvisioningConfig | null>) {
    const app = express()
    app.use(express.json())
    // No getConfig: the default resolver runs, with the process env free of XMAIL_PROVISIONING_*.
    app.use('/api/provisioning/v1', createProvisioningRouter({
        store: new FakeProvisioningStore(), loadConfigFromDb, checkDns: async () => verifiedUpdate(), rateLimitPerMinute: false,
    }))
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/provisioning/v1`
}

afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve))
    server = undefined
})

describe('provisioning config from the Microsites organization', () => {
    it('accepts the key whose SHA-256 is stored in the database and rejects any other', async () => {
        const base = await start(async () => dbConfig)
        const ok = await fetch(`${base}/domains/a-site.com`, { headers: { authorization: `Bearer ${KEY}` } })
        expect(ok.status).toBe(404) // authenticated; the fake store has no such domain
        const bad = await fetch(`${base}/domains/a-site.com`, { headers: { authorization: `Bearer ${KEY}x` } })
        expect(bad.status).toBe(401)
        const hashAsToken = await fetch(`${base}/domains/a-site.com`, { headers: { authorization: `Bearer ${dbConfig.apiKeySha256}` } })
        expect(hashAsToken.status).toBe(401)
    })

    it('answers 503 when the database has no configuration or the lookup fails', async () => {
        let base = await start(async () => null)
        expect((await fetch(`${base}/domains/a-site.com`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(503)
        await new Promise((resolve) => server!.close(resolve)); server = undefined
        base = await start(async () => { throw new Error('db down') })
        expect((await fetch(`${base}/domains/a-site.com`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(503)
    })
})

describe('defaultConfigResolver', () => {
    it('prefers a complete environment over the database', async () => {
        let dbCalls = 0
        const resolve = defaultConfigResolver(async () => { dbCalls++; return dbConfig }, {
            XMAIL_PROVISIONING_API_KEY: 'env-key', XMAIL_PROVISIONING_ORG_ID: TEST_CONFIG.organizationId,
        })
        expect((await resolve())?.apiKey).toBe('env-key')
        expect(dbCalls).toBe(0)
    })

    it('caches the database answer for a minute, then reloads it', async () => {
        let t = 0; let dbCalls = 0
        const resolve = defaultConfigResolver(async () => { dbCalls++; return dbConfig }, {}, () => t)
        await resolve(); await resolve()
        expect(dbCalls).toBe(1)
        t = 61_000
        await resolve()
        expect(dbCalls).toBe(2)
    })
})
