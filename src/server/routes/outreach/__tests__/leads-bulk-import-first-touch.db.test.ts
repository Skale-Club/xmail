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

// Phase 32 follow-up (FIX 2): POST /leads/bulk-import merges custom_fields with
// `COALESCE(...) || <new>`, which normally lets the newest payload win key-for-key. That is
// correct for every custom field EXCEPT `source_run_id` — see the first-touch comment on the
// customFields update expression in leads.ts. This suite exercises the real Postgres jsonb
// semantics of that expression (jsonb_exists + jsonb_build_object), which a pure unit test
// cannot: it is inline SQL built with drizzle's `sql` template, not a standalone function.
//
// NOTE: this is a *.db.test.ts file. It requires Docker (testcontainers spins up a disposable
// Postgres via src/test/postgres-global-setup.ts) and only runs under the `postgres` vitest
// project (`npx vitest run --project postgres`). It does NOT run under `--project server` and
// was not executed as part of this change's verification — report it as written, not verified.

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const IDS = {
    admin: 'f5000000-0000-4000-8000-000000000001',
    org: 'f5000000-0000-4000-8000-000000000002',
}

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

async function post(pathname: string, body: unknown, userId: string = IDS.admin) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

async function customFieldsOf(email: string): Promise<Record<string, unknown>> {
    const [row] = await sql`SELECT custom_fields FROM leads
        WHERE organization_id = ${IDS.org}::uuid AND email = ${email}`
    return row?.custom_fields ?? {}
}

// Seeds the lead directly via SQL rather than through POST /bulk-import: creating a brand
// new lead through the route runs resolveLeadVerificationFields, which falls back to a real
// MX DNS lookup for '*.example.test' addresses with no explicit email_status — slow and
// irrelevant to what this suite is testing (the *re-import merge* expression). The
// merge/first-touch behavior under test only ever runs on the duplicate-lead path, which
// these seeded rows exercise via POST /bulk-import below.
async function seedLead(email: string, customFields: Record<string, string>): Promise<void> {
    await sql`INSERT INTO leads (organization_id, email, custom_fields)
        VALUES (${IDS.org}::uuid, ${email}, ${sql.json(customFields)})
        ON CONFLICT DO NOTHING`
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl as string, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES (${IDS.admin}::uuid, 'bulk-import-admin@example.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'Bulk Import First Touch Org', 'bulk-import-first-touch-org', ${IDS.admin}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role)
        VALUES (${IDS.org}::uuid, ${IDS.admin}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`

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

describe('POST /bulk-import — source_run_id first-touch attribution', () => {
    it('keeps the FIRST source_run_id when a later re-import carries a different one, but still merges other keys', async () => {
        const email = 'first-touch@example.test'
        await seedLead(email, { source_run_id: 'run-A', note: 'first' })

        const second = await post(`/bulk-import?organizationId=${IDS.org}`, {
            leads: [{ email, customFields: { source_run_id: 'run-B', note: 'second', extra: 'new-key' } }],
        })
        expect(second.status).toBe(200)
        expect(second.body.duplicates).toBe(1)

        // source_run_id must still be the FIRST run's value; every other key follows the
        // normal "new payload wins" merge.
        expect(await customFieldsOf(email)).toMatchObject({
            source_run_id: 'run-A',
            note: 'second',
            extra: 'new-key',
        })
    })

    it('sets source_run_id normally on re-import when the lead never had one before', async () => {
        const email = 'no-prior-source-run@example.test'
        await seedLead(email, { note: 'first' })
        expect(await customFieldsOf(email)).not.toHaveProperty('source_run_id')

        const second = await post(`/bulk-import?organizationId=${IDS.org}`, {
            leads: [{ email, customFields: { source_run_id: 'run-C' } }],
        })
        expect(second.status).toBe(200)
        expect(second.body.duplicates).toBe(1)

        // No prior source_run_id existed, so the normal merge lets this one in.
        expect(await customFieldsOf(email)).toMatchObject({ source_run_id: 'run-C', note: 'first' })
    })

    it('a third import cannot steal attribution back after the first-touch value is set', async () => {
        const email = 'triple-import@example.test'
        await seedLead(email, { source_run_id: 'run-1' })

        await post(`/bulk-import?organizationId=${IDS.org}`, {
            leads: [{ email, customFields: { source_run_id: 'run-2' } }],
        })
        await post(`/bulk-import?organizationId=${IDS.org}`, {
            leads: [{ email, customFields: { source_run_id: 'run-3' } }],
        })

        expect(await customFieldsOf(email)).toMatchObject({ source_run_id: 'run-1' })
    })
})
