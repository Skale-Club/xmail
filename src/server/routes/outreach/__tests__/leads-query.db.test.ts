import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const ADMIN = 'c5000000-0000-4000-8000-000000000001'
const ORG = 'c5000000-0000-4000-8000-000000000002'
const OTHER_ADMIN = 'c5000000-0000-4000-8000-000000000003'
const OTHER_ORG = 'c5000000-0000-4000-8000-000000000004'
const LIST = 'c5000000-0000-4000-8000-000000000005'

const L1 = 'c5000000-0000-4000-8000-000000000011' // alice@acme.test, Acme Inc, Engineer, in LIST
const L2 = 'c5000000-0000-4000-8000-000000000012' // bob@globex.test, Globex, Manager, contacted
const L3 = 'c5000000-0000-4000-8000-000000000013' // carol@acme.test, Acme LLC, Director
const L4 = 'c5000000-0000-4000-8000-000000000014' // 50%off / under_score — wildcard literals
const TIE_A = 'c5000000-0000-4000-8000-0000000000a1'
const TIE_B = 'c5000000-0000-4000-8000-0000000000b2'
const OTHER_ALICE = 'c5000000-0000-4000-8000-0000000000ff'

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

async function call(pathname: string, userId = ADMIN) {
    const response = await fetch(`${baseUrl}${pathname}`, { headers: { 'x-user-id': userId } })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

function emails(body: any): string[] {
    return (body.leads as any[]).map((l) => l.email).sort()
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES
        (${ADMIN}::uuid, 'leads-admin@example.test'),
        (${OTHER_ADMIN}::uuid, 'leads-other-admin@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG}::uuid, 'Leads Org', 'leads-org', ${ADMIN}::uuid),
        (${OTHER_ORG}::uuid, 'Leads Other Org', 'leads-other-org', ${OTHER_ADMIN}::uuid) ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES
        (${ORG}::uuid, ${ADMIN}::uuid, 'admin'),
        (${OTHER_ORG}::uuid, ${OTHER_ADMIN}::uuid, 'admin') ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO lead_lists (id, organization_id, name) VALUES (${LIST}::uuid, ${ORG}::uuid, 'A List') ON CONFLICT (id) DO NOTHING`

    // Bind every string as a parameter so the stored bytes are exact — the wildcard-literal
    // assertions below depend on '%', '_', and '\' being stored verbatim.
    await sql`INSERT INTO leads (id, organization_id, email, first_name, last_name, company_name, title, status, lead_list_id)
        VALUES (${L1}::uuid, ${ORG}::uuid, 'alice@acme.test', 'Alice', 'Anderson', 'Acme Inc', 'Engineer', 'new', ${LIST}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO leads (id, organization_id, email, first_name, last_name, company_name, title, status)
        VALUES (${L2}::uuid, ${ORG}::uuid, 'bob@globex.test', 'Bob', 'Brown', 'Globex', 'Manager', 'contacted')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO leads (id, organization_id, email, first_name, last_name, company_name, title, status)
        VALUES (${L3}::uuid, ${ORG}::uuid, 'carol@acme.test', 'Carol', 'Clark', 'Acme LLC', 'Director', 'new')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO leads (id, organization_id, email, first_name, last_name, company_name, title, status)
        VALUES (${L4}::uuid, ${ORG}::uuid, 'weird@literal.test', ${'50%off'}, ${'under_score'}, ${'Odd\\Co'}, 'Rep', 'new')
        ON CONFLICT (id) DO NOTHING`

    // Same email in another tenant — must never leak into ORG's results or counts.
    await sql`INSERT INTO leads (id, organization_id, email, first_name, company_name) VALUES
        (${OTHER_ALICE}::uuid, ${OTHER_ORG}::uuid, 'alice@acme.test', 'Alice', 'Acme Inc') ON CONFLICT (id) DO NOTHING`

    // Two leads with an identical created_at to exercise the unique id tie-breaker.
    await sql`INSERT INTO leads (id, organization_id, email, created_at) VALUES
        (${TIE_A}::uuid, ${ORG}::uuid, 'tie-a@example.test', '2020-01-01T00:00:00Z'),
        (${TIE_B}::uuid, ${ORG}::uuid, 'tie-b@example.test', '2020-01-01T00:00:00Z') ON CONFLICT (id) DO NOTHING`

    const leadsRouter = (await import('../leads')).default
    closeApplicationDatabase = (await import('../../../../db')).closeDatabaseConnection
    const app = express()
    app.use(express.json())
    app.use('/', leadsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('lead search', () => {
    it('matches across email, name, company, and title (case-insensitive, trimmed)', async () => {
        const acme = await call(`/?organizationId=${ORG}&search=acme`)
        expect(acme.status).toBe(200)
        expect(emails(acme.body)).toEqual(['alice@acme.test', 'carol@acme.test'])

        const upper = await call(`/?organizationId=${ORG}&search=ALICE`)
        expect(emails(upper.body)).toEqual(['alice@acme.test'])

        const trimmed = await call(`/?organizationId=${ORG}&search=${encodeURIComponent('  bob  ')}`)
        expect(emails(trimmed.body)).toEqual(['bob@globex.test'])

        const byTitle = await call(`/?organizationId=${ORG}&search=director`)
        expect(emails(byTitle.body)).toEqual(['carol@acme.test'])
    })

    it('treats %, _, and backslash as literal input', async () => {
        const percent = await call(`/?organizationId=${ORG}&search=${encodeURIComponent('%')}`)
        expect(emails(percent.body)).toEqual(['weird@literal.test'])

        const underscore = await call(`/?organizationId=${ORG}&search=${encodeURIComponent('_')}`)
        expect(emails(underscore.body)).toEqual(['weird@literal.test'])

        const backslash = await call(`/?organizationId=${ORG}&search=${encodeURIComponent('Odd\\Co')}`)
        expect(emails(backslash.body)).toEqual(['weird@literal.test'])
    })
})

describe('lead filters and pagination bounds', () => {
    it('filters by status and lead list', async () => {
        const contacted = await call(`/?organizationId=${ORG}&status=contacted`)
        expect(emails(contacted.body)).toEqual(['bob@globex.test'])

        const inList = await call(`/?organizationId=${ORG}&leadListId=${LIST}`)
        expect(emails(inList.body)).toEqual(['alice@acme.test'])
    })

    it('rejects out-of-range and malformed query params with 400', async () => {
        expect((await call(`/?organizationId=${ORG}&limit=101`)).status).toBe(400)
        expect((await call(`/?organizationId=${ORG}&limit=0`)).status).toBe(400)
        expect((await call(`/?organizationId=${ORG}&page=0`)).status).toBe(400)
        expect((await call(`/?organizationId=${ORG}&status=bogus`)).status).toBe(400)
        expect((await call(`/?organizationId=${ORG}&sort=ssn`)).status).toBe(400)
        expect((await call(`/?organizationId=${ORG}&order=sideways`)).status).toBe(400)
    })

    it('caps the returned page at the requested limit', async () => {
        const limited = await call(`/?organizationId=${ORG}&limit=2`)
        expect(limited.status).toBe(200)
        expect(limited.body.leads.length).toBeLessThanOrEqual(2)
        expect(limited.body.pagination.limit).toBe(2)
    })
})

describe('lead ordering and tenancy', () => {
    it('orders by the requested field then a unique id tie-breaker', async () => {
        const res = await call(`/?organizationId=${ORG}&sort=createdAt&order=desc&limit=100`)
        const ids = (res.body.leads as any[]).map((l) => l.id)
        const posA = ids.indexOf(TIE_A)
        const posB = ids.indexOf(TIE_B)
        expect(posA).toBeGreaterThanOrEqual(0)
        expect(posB).toBeGreaterThanOrEqual(0)
        // Same created_at → higher id first under the created_at DESC, id DESC contract.
        expect(posB).toBeLessThan(posA)
    })

    it('never returns or counts another tenant’s identically-addressed lead', async () => {
        const res = await call(`/?organizationId=${ORG}&search=alice@acme.test`)
        expect(res.body.leads).toHaveLength(1)
        expect(res.body.leads[0].id).toBe(L1)
        expect(res.body.pagination.total).toBe(1)
    })
})
