import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../test/postgres-harness'

// N-3 — boundary lock: the api-auth middleware strips inbound x-service-principal /
// x-service-organization-id markers as its first two statements (src/server/lib/api-auth.ts:44-46),
// so a client can never forge them. This suite forges those markers on an OTHERWISE-NORMAL JWT
// request and proves the strip neutralises them: the forged markers grant no scope and never bypass
// checkOutreachAccess.
//
// Token resolution is mocked so a known bearer token maps to a known user without Supabase. Org
// membership and campaigns are real database rows, so checkOutreachAccess runs for real. Service-key
// auth is deliberately left UNCONFIGURED, so every request here takes the JWT branch — exactly the
// path where an un-stripped marker would leak through to the route.

const hoisted = vi.hoisted(() => ({
    MEMBER: 'e3000000-0000-4000-8000-000000000001', // member of ORG_A only
    MEMBER_TOKEN: 'valid-member-jwt',
}))

vi.mock('../lib/auth-cache', () => ({
    resolveUserFromToken: vi.fn(async (token: string) => {
        if (token === hoisted.MEMBER_TOKEN) {
            return {
                user: {
                    id: hoisted.MEMBER,
                    email: 'forgery-member@example.test',
                    firstName: '',
                    lastName: '',
                    emailVerified: true,
                },
                error: null,
                fromCache: false,
            }
        }
        return { user: null, error: 'Invalid or expired token', fromCache: false }
    }),
    getAuthCacheStats: () => ({ hits: 0, misses: 0, size: 0, ttlMs: 0 }),
}))

const MEMBER = hoisted.MEMBER
const MEMBER_TOKEN = hoisted.MEMBER_TOKEN
const OWNER_B = 'e3000000-0000-4000-8000-000000000002' // owner/admin of ORG_B
const ORG_A = 'e3000000-0000-4000-8000-0000000000a1' // MEMBER belongs here
const ORG_B = 'e3000000-0000-4000-8000-0000000000b1' // MEMBER is NOT a member here
const CAMP_A = 'e3000000-0000-4000-8000-0000000000c1' // in ORG_A
const CAMP_B = 'e3000000-0000-4000-8000-0000000000c2' // in ORG_B

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

interface CallOptions {
    method?: string
    token?: string
    extraHeaders?: Record<string, string>
}

async function call(pathname: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) }
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: opts.method ?? 'GET',
        headers,
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    process.env.SUPABASE_URL ||= 'http://localhost:54321'
    process.env.SUPABASE_ANON_KEY ||= 'test-anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key'
    // No service-key auth configured — a request without a service key always uses the JWT branch.
    delete process.env.XMAIL_SERVICE_KEY
    delete process.env.XMAIL_SERVICE_USER_ID
    delete process.env.XMAIL_SERVICE_ORGANIZATION_ID

    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email, is_admin) VALUES
        (${MEMBER}::uuid, 'forgery-member@example.test', false),
        (${OWNER_B}::uuid, 'forgery-owner-b@example.test', false)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'Forgery Org A', 'forgery-org-a', ${MEMBER}::uuid),
        (${ORG_B}::uuid, 'Forgery Org B', 'forgery-org-b', ${OWNER_B}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES
        (${ORG_A}::uuid, ${MEMBER}::uuid, 'member'),
        (${ORG_B}::uuid, ${OWNER_B}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES
        (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Org A Campaign', 'draft'),
        (${CAMP_B}::uuid, ${ORG_B}::uuid, 'Org B Campaign', 'draft')
        ON CONFLICT (id) DO NOTHING`

    const createApiAuthMiddleware = (await import('../lib/api-auth')).createApiAuthMiddleware
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

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('inbound service-principal markers are stripped (N-3)', () => {
    it('a forged marker does not spuriously deny a legitimate in-scope request', async () => {
        // Forge principal=true bound to ORG_B while requesting an ORG_A resource. If the markers
        // survived the strip, violatesServiceScope (bound ORG_B != resolved ORG_A) would 403 the
        // real member. A 200 proves the forged markers were stripped and ignored.
        const res = await call(`/api/outreach/campaigns/${CAMP_A}`, {
            token: MEMBER_TOKEN,
            extraHeaders: {
                'x-service-principal': 'true',
                'x-service-organization-id': ORG_B,
                'x-user-id': OWNER_B, // also forged; JWT identity must win
            },
        })
        expect(res.status).toBe(200)
        expect(res.body.campaign.id).toBe(CAMP_A)
    })

    it('a forged marker grants no cross-tenant scope (checkOutreachAccess still denies)', async () => {
        // Forge principal=true bound to ORG_B and request an ORG_B resource the member cannot see.
        // A forged marker can only ever ADD a deny condition, never grant — so this must still 403.
        const res = await call(`/api/outreach/campaigns/${CAMP_B}`, {
            token: MEMBER_TOKEN,
            extraHeaders: {
                'x-service-principal': 'true',
                'x-service-organization-id': ORG_B,
            },
        })
        expect(res.status).toBe(403)
    })
})
