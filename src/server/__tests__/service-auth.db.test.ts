import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../test/postgres-harness'
import { createApiAuthMiddleware } from '../lib/api-auth'
import { resolveServiceAuthConfig } from '../lib/service-auth'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const SERVICE_KEY = 'svc-secret-key-value-do-not-log'

const SUSER = 'd7000000-0000-4000-8000-000000000001' // bound service principal (member of SORG)
const OWNER_O = 'd7000000-0000-4000-8000-000000000002' // owner/admin of OORG
const FORGED = 'd7000000-0000-4000-8000-000000000003' // real user, NOT a member of SORG

const SORG = 'd7000000-0000-4000-8000-0000000000a1' // bound organization
const OORG = 'd7000000-0000-4000-8000-0000000000b1' // a different organization
const CAMP_SORG = 'd7000000-0000-4000-8000-0000000000c1'
const CAMP_OORG = 'd7000000-0000-4000-8000-0000000000c2'

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

interface ServiceEnv {
    key?: string
    userId?: string
    organizationId?: string
}

function setServiceEnv(env: ServiceEnv) {
    if (env.key === undefined) delete process.env.XMAIL_SERVICE_KEY
    else process.env.XMAIL_SERVICE_KEY = env.key
    if (env.userId === undefined) delete process.env.XMAIL_SERVICE_USER_ID
    else process.env.XMAIL_SERVICE_USER_ID = env.userId
    if (env.organizationId === undefined) delete process.env.XMAIL_SERVICE_ORGANIZATION_ID
    else process.env.XMAIL_SERVICE_ORGANIZATION_ID = env.organizationId
}

const FULL_CONFIG: ServiceEnv = { key: SERVICE_KEY, userId: SUSER, organizationId: SORG }

interface CallOptions {
    method?: string
    serviceKey?: string
    userId?: string
    body?: unknown
    extraHeaders?: Record<string, string>
}

async function call(pathname: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) }
    if (opts.serviceKey !== undefined) headers['x-service-key'] = opts.serviceKey
    if (opts.userId !== undefined) headers['x-user-id'] = opts.userId
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await response.text()
    return { status: response.status, raw: text, body: (text ? JSON.parse(text) : null) as any }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email, is_admin) VALUES
        (${SUSER}::uuid, 'svc-user@example.test', false),
        (${OWNER_O}::uuid, 'svc-other-owner@example.test', false),
        (${FORGED}::uuid, 'svc-forged@example.test', false)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${SORG}::uuid, 'Service Org', 'service-org', ${SUSER}::uuid),
        (${OORG}::uuid, 'Other Org', 'service-other-org', ${OWNER_O}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES
        (${SORG}::uuid, ${SUSER}::uuid, 'member'),
        (${OORG}::uuid, ${OWNER_O}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES
        (${CAMP_SORG}::uuid, ${SORG}::uuid, 'Service Campaign', 'draft'),
        (${CAMP_OORG}::uuid, ${OORG}::uuid, 'Other Campaign', 'draft')
        ON CONFLICT (id) DO NOTHING`

    const campaignsRouter = (await import('../routes/outreach/campaigns')).default
    closeApplicationDatabase = (await import('../../db')).closeDatabaseConnection

    const app = express()
    app.use(express.json())
    app.use('/api', createApiAuthMiddleware())
    app.use('/api/outreach/campaigns', campaignsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
    setServiceEnv({})
    vi.restoreAllMocks()
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('service-auth configuration fails closed', () => {
    it('rejects the service header when no service auth is configured', () => {
        setServiceEnv({})
        expect(resolveServiceAuthConfig(process.env)).toBeNull()
    })

    it('rejects a partial configuration (key without bound principal/organization)', async () => {
        setServiceEnv({ key: SERVICE_KEY })
        expect(resolveServiceAuthConfig(process.env)).toBeNull()

        const res = await call(`/api/outreach/campaigns?organizationId=${SORG}`, {
            serviceKey: SERVICE_KEY,
            userId: FORGED,
        })
        expect(res.status).toBe(401)
    })

    it('resolves a full configuration', () => {
        setServiceEnv(FULL_CONFIG)
        expect(resolveServiceAuthConfig(process.env)).toEqual({
            key: SERVICE_KEY,
            userId: SUSER,
            organizationId: SORG,
        })
    })
})

describe('service-key verification', () => {
    it('returns 401 for a wrong key and never echoes the secret', async () => {
        setServiceEnv(FULL_CONFIG)
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const res = await call(`/api/outreach/campaigns?organizationId=${SORG}`, {
            serviceKey: 'the-wrong-key',
            userId: FORGED,
        })

        expect(res.status).toBe(401)
        expect(res.raw).not.toContain(SERVICE_KEY)
        for (const line of errorSpy.mock.calls.flat()) {
            expect(String(line)).not.toContain(SERVICE_KEY)
        }
    })
})

describe('bound identity overrides caller-supplied identity', () => {
    it('acts as the configured principal and ignores a forged x-user-id', async () => {
        setServiceEnv(FULL_CONFIG)
        // FORGED is a real user but NOT a member of SORG. If the server trusted the caller's
        // x-user-id it would 403; a 200 proves the server used the bound principal (SUSER).
        const res = await call(`/api/outreach/campaigns/${CAMP_SORG}`, {
            serviceKey: SERVICE_KEY,
            userId: FORGED,
        })
        expect(res.status).toBe(200)
    })
})

describe('bound organization scope cannot be overridden', () => {
    it('rejects a mismatched organization in the query string with 403', async () => {
        setServiceEnv(FULL_CONFIG)
        const res = await call(`/api/outreach/campaigns?organizationId=${OORG}`, {
            serviceKey: SERVICE_KEY,
            userId: SUSER,
        })
        expect(res.status).toBe(403)
        expect(res.raw).not.toContain(SERVICE_KEY)
    })

    it('rejects a mismatched organization in the request body with 403', async () => {
        setServiceEnv(FULL_CONFIG)
        const res = await call(`/api/outreach/campaigns?organizationId=${SORG}`, {
            method: 'POST',
            serviceKey: SERVICE_KEY,
            userId: SUSER,
            body: { organizationId: OORG, name: 'Injected' },
        })
        expect(res.status).toBe(403)
    })

    it('rejects a resource that resolves to a different organization with 403', async () => {
        setServiceEnv(FULL_CONFIG)
        // No organizationId in the query — the route derives OORG from the campaign. The bound
        // scope (SORG) must still be enforced through the shared access helper.
        const res = await call(`/api/outreach/campaigns/${CAMP_OORG}`, {
            serviceKey: SERVICE_KEY,
            userId: SUSER,
        })
        expect(res.status).toBe(403)
    })
})
