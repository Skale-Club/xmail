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

// Phase 34 (migration 064): POST /external-runs/:externalRunId/verification records a
// verification batch Xphere ran against an already-registered run (see prospecting.ts's
// route comment and docs/prospecting-engine-plan.md "Fase 34"). This suite exercises the
// real DB-backed guarantees the mocked prospecting-verification.test.ts cannot: the
// journey event and cost entry landing for real, the cost entry actually priced from the
// seeded migration 056 rate (3700 micros/credit), and idempotent replay writing nothing
// twice.

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')

// Distinct id prefix so this suite never collides with sibling suites sharing the disposable DB.
const IDS = {
    admin: 'e6000000-0000-4000-8000-000000000001',
    org: 'e6000000-0000-4000-8000-000000000002',
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

    // Same chain prospecting-external-runs.db.test.ts applies, plus 055/056 (seeds the
    // email_verification/millionverifier rate this suite prices against) and 064 (the
    // columns/constraint this phase adds).
    await applyMigrationFile(target, path.join(migrationsDir, '046_prospecting_pipeline.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '049_prospect_ai_assessments.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '051_prospecting_journey_and_costs.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '052_lead_email_normalization.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '053_seed_cost_rates.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '054_generalize_prospecting_providers.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '055_seed_email_verification_rate.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '056_email_verification_rate_entry_tier.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '064_prospecting_run_verification.sql'))

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl as string, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES (${IDS.admin}::uuid, 'verify-admin@example.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'Verification Org', 'verification-org', ${IDS.admin}::uuid)
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

async function registerRun(externalRunId: string, discoveredCount = 100) {
    const result = await post(`/external-runs?organizationId=${IDS.org}`, {
        provider: 'xcraper',
        externalRunId,
        resultCount: discoveredCount,
        importedCount: discoveredCount,
    })
    expect(result.status).toBe(201)
    return result.body.run.id as string
}

const VALID_BODY = {
    provider: 'xcraper' as const,
    checked: 98,
    ok: 69,
    catchAll: 9,
    unknown: 2,
    invalid: 18,
    creditsUsed: 38,
    verificationProvider: 'millionverifier' as const,
    verifiedAt: '2026-09-08T12:00:00.000Z',
}

describe('POST /external-runs/:externalRunId/verification', () => {
    it('404s when no run was registered for this provider/externalRunId', async () => {
        const result = await post(`/external-runs/never-registered/verification?organizationId=${IDS.org}`, VALID_BODY)
        expect(result.status).toBe(404)
    })

    it('rejects checked != ok + catchAll + unknown + invalid with 400', async () => {
        const externalRunId = 'verify-run-400'
        await registerRun(externalRunId)
        const result = await post(`/external-runs/${externalRunId}/verification?organizationId=${IDS.org}`, {
            ...VALID_BODY,
            checked: 99,
        })
        expect(result.status).toBe(400)
    })

    it('201s, records the journey event, and prices the cost entry from the seeded 056 rate (3700 micros/credit)', async () => {
        const externalRunId = 'verify-run-201'
        const runId = await registerRun(externalRunId, 100)

        const result = await post(`/external-runs/${externalRunId}/verification?organizationId=${IDS.org}`, VALID_BODY)
        expect(result.status).toBe(201)
        expect(result.body.runId).toBe(runId)
        expect(result.body.eventId).toBeTruthy()
        expect(result.body.costEntryId).toBeTruthy()

        const [run] = await sql`SELECT verified_ok_count, verified_at FROM prospecting_runs WHERE id = ${runId}::uuid`
        expect(run.verified_ok_count).toBe(69)
        expect(run.verified_at).toBeTruthy()

        const [event] = await sql`SELECT * FROM prospecting_run_events WHERE run_id = ${runId}::uuid AND code = 'verify.completed'`
        expect(event).toBeTruthy()
        expect(event.phase).toBe('verify')
        expect(event.detail.verifiedEmailRate).toBeCloseTo(0.69)

        const [entry] = await sql`SELECT * FROM outreach_cost_entries WHERE run_id = ${runId}::uuid AND category = 'email_verification'`
        expect(entry).toBeTruthy()
        expect(entry.unit).toBe('credit')
        expect(entry.basis).toBe('actual')
        expect(Number(entry.quantity)).toBe(38)
        // 38 credits * 3700 micros/credit (migration 056's seeded rate) = 140600.
        expect(Number(entry.unit_cost_micros)).toBe(3700)
        expect(Number(entry.amount_micros)).toBe(140_600)
        expect(entry.detail.rate_missing).toBeUndefined()
    })

    it('idempotent replay: an identical repeat writes no second event and no second cost entry', async () => {
        const externalRunId = 'verify-run-replay'
        const runId = await registerRun(externalRunId, 100)

        const first = await post(`/external-runs/${externalRunId}/verification?organizationId=${IDS.org}`, VALID_BODY)
        expect(first.status).toBe(201)

        const second = await post(`/external-runs/${externalRunId}/verification?organizationId=${IDS.org}`, VALID_BODY)
        expect(second.status).toBe(200)
        expect(second.body.idempotentReplay).toBe(true)
        expect(second.body.eventId).toBe(first.body.eventId)
        expect(second.body.costEntryId).toBe(first.body.costEntryId)

        const events = await sql`SELECT id FROM prospecting_run_events WHERE run_id = ${runId}::uuid AND code = 'verify.completed'`
        expect(events).toHaveLength(1)
        const entries = await sql`SELECT id FROM outreach_cost_entries WHERE run_id = ${runId}::uuid AND category = 'email_verification'`
        expect(entries).toHaveLength(1)
    })
})
