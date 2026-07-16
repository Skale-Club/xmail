import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

// Role matrix actors.
const PADMIN = 'c6000000-0000-4000-8000-000000000001' // platform admin, no org membership
const UA = 'c6000000-0000-4000-8000-000000000002'     // org A admin
const UM = 'c6000000-0000-4000-8000-000000000003'     // org A member
const UV = 'c6000000-0000-4000-8000-000000000004'     // org A viewer
const UB = 'c6000000-0000-4000-8000-000000000005'     // org B admin (cross-tenant)
const NON = 'c6000000-0000-4000-8000-000000000006'    // authenticated non-member

const ORG_A = 'c6000000-0000-4000-8000-0000000000a1'
const ORG_B = 'c6000000-0000-4000-8000-0000000000b1'
const CAMP_A = 'c6000000-0000-4000-8000-0000000000c1' // campaign owned by ORG_A

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

async function req(
    method: string,
    pathname: string,
    userId: string,
    body?: unknown,
) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
            'x-user-id': userId,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email, is_admin) VALUES
        (${PADMIN}::uuid, 'oa-padmin@example.test', true),
        (${UA}::uuid, 'oa-admin@example.test', false),
        (${UM}::uuid, 'oa-member@example.test', false),
        (${UV}::uuid, 'oa-viewer@example.test', false),
        (${UB}::uuid, 'oa-other-admin@example.test', false),
        (${NON}::uuid, 'oa-nonmember@example.test', false)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'Access Org A', 'access-org-a', ${UA}::uuid),
        (${ORG_B}::uuid, 'Access Org B', 'access-org-b', ${UB}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES
        (${ORG_A}::uuid, ${UA}::uuid, 'admin'),
        (${ORG_A}::uuid, ${UM}::uuid, 'member'),
        (${ORG_A}::uuid, ${UV}::uuid, 'viewer'),
        (${ORG_B}::uuid, ${UB}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES
        (${CAMP_A}::uuid, ${ORG_A}::uuid, 'A Campaign', 'draft')
        ON CONFLICT (id) DO NOTHING`

    const campaignsRouter = (await import('../../routes/outreach/campaigns')).default
    const leadsRouter = (await import('../../routes/outreach/leads')).default
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection

    const app = express()
    app.use(express.json())
    app.use('/campaigns', campaignsRouter)
    app.use('/leads', leadsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('outreach read access (GET /campaigns)', () => {
    it('permits org admin, member, viewer, and platform admin', async () => {
        for (const uid of [UA, UM, UV, PADMIN]) {
            const res = await req('GET', `/campaigns?organizationId=${ORG_A}`, uid)
            expect(res.status, `user ${uid} should read`).toBe(200)
        }
    })

    it('denies non-members and cross-tenant members', async () => {
        expect((await req('GET', `/campaigns?organizationId=${ORG_A}`, NON)).status).toBe(403)
        expect((await req('GET', `/campaigns?organizationId=${ORG_A}`, UB)).status).toBe(403)
    })
})

describe('outreach write access (POST /leads)', () => {
    it('permits org admin and member', async () => {
        const res1 = await req('POST', `/leads?organizationId=${ORG_A}`, UA, { email: 'w-admin@acme.test' })
        expect([200, 201], `admin should write`).toContain(res1.status)

        const res2 = await req('POST', `/leads?organizationId=${ORG_A}`, UM, { email: 'w-member@acme.test' })
        expect([200, 201], `member should write`).toContain(res2.status)
    })

    it('denies viewer writes with 403 even though viewer can read', async () => {
        const read = await req('GET', `/leads?organizationId=${ORG_A}`, UV)
        expect(read.status).toBe(200)

        const write = await req('POST', `/leads?organizationId=${ORG_A}`, UV, { email: 'w-viewer@acme.test' })
        expect(write.status).toBe(403)
    })

    it('denies non-members and cross-tenant members', async () => {
        expect((await req('POST', `/leads?organizationId=${ORG_A}`, NON, { email: 'w-non@acme.test' })).status).toBe(403)
        expect((await req('POST', `/leads?organizationId=${ORG_A}`, UB, { email: 'w-ub@acme.test' })).status).toBe(403)
    })
})

describe('resource-derived access (GET /campaigns/:id)', () => {
    it('resolves the campaign organization before granting access', async () => {
        expect((await req('GET', `/campaigns/${CAMP_A}`, UV)).status).toBe(200)   // viewer of owning org
        expect((await req('GET', `/campaigns/${CAMP_A}`, UB)).status).toBe(403)   // admin of another org
        expect((await req('GET', `/campaigns/${CAMP_A}`, NON)).status).toBe(403)  // non-member
    })
})

describe('canonical access helper adoption', () => {
    const routeFiles = [
        'campaigns.ts',
        'leads.ts',
        'email-accounts.ts',
        'settings.ts',
        'send-message.ts',
    ]

    it('no outreach router owns a divergent membership helper', () => {
        for (const file of routeFiles) {
            const contents = readFileSync(
                path.join(process.cwd(), 'src', 'server', 'routes', 'outreach', file),
                'utf8',
            )
            expect(contents, `${file} must not define its own checkOrgMembership`).not.toMatch(
                /function checkOrgMembership/,
            )
            expect(contents, `${file} must not define its own canWriteOutreach`).not.toMatch(
                /function canWriteOutreach/,
            )
        }
    })

    it('every tenant-scoped outreach router imports the canonical access module', () => {
        for (const file of routeFiles) {
            const contents = readFileSync(
                path.join(process.cwd(), 'src', 'server', 'routes', 'outreach', file),
                'utf8',
            )
            expect(contents, `${file} must import from lib/outreach-access`).toMatch(
                /from ['"][^'"]*lib\/outreach-access['"]/,
            )
        }
    })
})
