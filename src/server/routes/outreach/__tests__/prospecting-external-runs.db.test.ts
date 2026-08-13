import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'

// Phase 32 (migration 054): POST /external-runs lets Xphere register a prospecting run
// that already happened outside xmail (xcraper/Apify) — see prospecting.ts's route
// comment. This suite exercises the actual DB-backed guarantees that the exported
// externalRunSchema unit tests (prospecting-external-runs.test.ts) cannot: idempotent
// upsert of prospecting_runs, and that a repeated call never double-writes the
// outreach_cost_entries ledger or the prospecting_run_events journey row.

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')

// Distinct id prefix so this suite never collides with sibling suites sharing the disposable DB.
const IDS = {
    admin: 'e5000000-0000-4000-8000-000000000001',
    org: 'e5000000-0000-4000-8000-000000000002',
    outsider: 'e5000000-0000-4000-8000-000000000003',
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

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl as string, runGuard }

    // prospecting_runs/prospect_candidates (046) -> prospect_ai_assessments (049, which
    // 051 alters) -> journey events + cost ledger (051) -> email normalization (052) ->
    // seed rates (053) -> this phase's provider/category/unit widening (054). Applied in
    // the same numeric order they'd land in against the real database.
    await applyMigrationFile(target, path.join(migrationsDir, '046_prospecting_pipeline.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '049_prospect_ai_assessments.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '051_prospecting_journey_and_costs.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '052_lead_email_normalization.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '053_seed_cost_rates.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '054_generalize_prospecting_providers.sql'))

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl as string, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES (${IDS.admin}::uuid, 'ext-run-admin@example.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'External Runs Org', 'external-runs-org', ${IDS.admin}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role)
        VALUES (${IDS.org}::uuid, ${IDS.admin}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`

    const prospectingRouter = (await import('../prospecting')).default
    closeApplicationDatabase = (await import('../../../../db')).closeDatabaseConnection

    const app = express()
    app.use(express.json())
    app.use('/', prospectingRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('POST /external-runs', () => {
    it('creates a run, a journey event, and a cost entry priced from the reported actual cost', async () => {
        const result = await post(`/external-runs?organizationId=${IDS.org}`, {
            provider: 'xcraper',
            externalRunId: 'run-alpha',
            label: 'Bakeries in Denver',
            resultCount: 40,
            importedCount: 12,
            costUsd: 0.2153,
        })

        expect(result.status).toBe(201)
        expect(result.body.idempotentReplay).toBe(false)
        expect(result.body.run.status).toBe('imported')
        expect(result.body.run.provider).toBe('xcraper')
        expect(result.body.run.discoveredCount).toBe(40)
        expect(result.body.run.importedCount).toBe(12)

        const [entry] = await sql`SELECT * FROM outreach_cost_entries WHERE run_id = ${result.body.run.id}::uuid`
        expect(entry).toBeTruthy()
        // 0.2153 USD -> 215300 micros.
        expect(Number(entry.amount_micros)).toBe(215_300)
        expect(entry.category).toBe('lead_source')
        expect(entry.unit).toBe('result')
        expect(entry.basis).toBe('actual')
        expect(entry.provider).toBe('apify')
        expect(entry.detail.cost_source).toBe('provider_reported')
        expect(entry.detail.rate_missing).toBeUndefined()

        const [event] = await sql`SELECT * FROM prospecting_run_events WHERE run_id = ${result.body.run.id}::uuid`
        expect(event.code).toBe('import.external_run_registered')
        expect(event.phase).toBe('import')
    })

    it('idempotent replay: a repeated call with the same externalRunId creates no second run and no second cost entry', async () => {
        const payload = {
            provider: 'xcraper',
            externalRunId: 'run-beta',
            resultCount: 10,
            importedCount: 3,
            costUsd: 1.5,
        }

        const first = await post(`/external-runs?organizationId=${IDS.org}`, payload)
        expect(first.status).toBe(201)

        const second = await post(`/external-runs?organizationId=${IDS.org}`, payload)
        expect(second.status).toBe(200)
        expect(second.body.idempotentReplay).toBe(true)
        expect(second.body.run.id).toBe(first.body.run.id)

        const runs = await sql`SELECT id FROM prospecting_runs
            WHERE organization_id = ${IDS.org}::uuid AND provider = 'xcraper' AND idempotency_key = 'run-beta'`
        expect(runs).toHaveLength(1)

        const entries = await sql`SELECT id FROM outreach_cost_entries WHERE run_id = ${first.body.run.id}::uuid`
        expect(entries).toHaveLength(1)

        const events = await sql`SELECT id FROM prospecting_run_events WHERE run_id = ${first.body.run.id}::uuid`
        expect(events).toHaveLength(1)
    })

    it('does not write a cost entry at all when costUsd is omitted', async () => {
        const result = await post(`/external-runs?organizationId=${IDS.org}`, {
            provider: 'xcraper',
            externalRunId: 'run-no-cost',
            resultCount: 5,
        })
        expect(result.status).toBe(201)

        const entries = await sql`SELECT id FROM outreach_cost_entries WHERE run_id = ${result.body.run.id}::uuid`
        expect(entries).toHaveLength(0)
    })

    it('rejects an invalid body with 400 (over-long externalRunId)', async () => {
        const result = await post(`/external-runs?organizationId=${IDS.org}`, {
            provider: 'xcraper',
            externalRunId: 'x'.repeat(201),
        })
        expect(result.status).toBe(400)
    })

    it('rejects a caller with no membership in the organization', async () => {
        const result = await post(`/external-runs?organizationId=${IDS.org}`, {
            provider: 'xcraper',
            externalRunId: 'run-gamma',
        }, IDS.outsider)
        expect(result.status).toBe(403)
    })
})
