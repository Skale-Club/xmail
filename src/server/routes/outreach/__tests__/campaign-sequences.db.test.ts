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

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '040_outreach_product_consistency.sql',
)

const IDS = {
    admin: 'a0000000-0000-4000-8000-000000000001',
    viewer: 'a0000000-0000-4000-8000-000000000002',
    outsider: 'a0000000-0000-4000-8000-000000000003',
    org: 'a0000000-0000-4000-8000-000000000004',
    otherOrg: 'a0000000-0000-4000-8000-000000000005',
    account: 'a0000000-0000-4000-8000-000000000006',
}

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

interface CallOptions {
    method?: string
    userId?: string
    body?: unknown
}

async function call(pathname: string, options: CallOptions = {}) {
    const headers: Record<string, string> = {}
    if (options.userId) headers['x-user-id'] = options.userId
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${baseUrl}${pathname}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    return { status: response.status, body: json as any }
}

async function createDraftCampaign(name: string): Promise<string> {
    const created = await call(`/?organizationId=${IDS.org}`, {
        method: 'POST',
        userId: IDS.admin,
        body: { name },
    })
    expect(created.status).toBe(201)
    return created.body.campaign.id as string
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, migrationPath)
    await applyMigrationFile(target, migrationPath)

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`
        INSERT INTO users (id, email) VALUES
            (${IDS.admin}::uuid, 'seq-admin@example.test'),
            (${IDS.viewer}::uuid, 'seq-viewer@example.test'),
            (${IDS.outsider}::uuid, 'seq-outsider@example.test')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id) VALUES
            (${IDS.org}::uuid, 'Route Org', 'route-org', ${IDS.admin}::uuid),
            (${IDS.otherOrg}::uuid, 'Route Other Org', 'route-other-org', ${IDS.outsider}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organization_users (organization_id, user_id, role) VALUES
            (${IDS.org}::uuid, ${IDS.admin}::uuid, 'admin'),
            (${IDS.org}::uuid, ${IDS.viewer}::uuid, 'viewer'),
            (${IDS.otherOrg}::uuid, ${IDS.outsider}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING
    `

    const campaignsRouter = (await import('../campaigns')).default
    closeApplicationDatabase = (await import('../../../../db')).closeDatabaseConnection

    const app = express()
    app.use(express.json())
    app.use('/', campaignsRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    // Guard each teardown independently so a partial beforeAll never leaves the hook hanging.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('campaign creation + canonical sequence', () => {
    it('creates a campaign and exactly one sequence in one transaction', async () => {
        const campaignId = await createDraftCampaign('One transaction')
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequences WHERE campaign_id = ${campaignId}::uuid
        `
        expect(Number(count)).toBe(1)
    })

    it('never creates a second sequence through the legacy create endpoint', async () => {
        const campaignId = await createDraftCampaign('No second row')
        const legacy = await call(`/${campaignId}/sequences`, {
            method: 'POST',
            userId: IDS.admin,
            body: { name: 'Second sequence attempt' },
        })
        // Compatibility adapter returns the existing canonical row, it does not add a second.
        expect(legacy.status).toBeLessThan(500)
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequences WHERE campaign_id = ${campaignId}::uuid
        `
        expect(Number(count)).toBe(1)
    })
})

describe('GET /:campaignId/sequence', () => {
    it('returns the singular canonical resource', async () => {
        const campaignId = await createDraftCampaign('Singular get')
        const result = await call(`/${campaignId}/sequence`, { userId: IDS.admin })
        expect(result.status).toBe(200)
        expect(result.body.sequence).toBeTruthy()
        expect(result.body.sequence.campaignId).toBe(campaignId)
        expect(Array.isArray(result.body.sequence.steps)).toBe(true)
    })

    it('denies a non-member', async () => {
        const campaignId = await createDraftCampaign('Get denied')
        const result = await call(`/${campaignId}/sequence`, { userId: IDS.outsider })
        expect(result.status).toBe(403)
    })
})

describe('PUT /:campaignId/sequence', () => {
    const validPayload = {
        steps: [
            { type: 'email', subject: 'Hello', plainBody: 'Body one' },
            { type: 'delay', delayHours: 24 },
            { type: 'email', subject: 'Nudge', htmlBody: '<p>Nudge</p>' },
        ],
    }

    it('replaces the ordered step set and is idempotent', async () => {
        const campaignId = await createDraftCampaign('Replace idempotent')
        const first = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.admin, body: validPayload })
        expect(first.status).toBe(200)
        expect(first.body.sequence.steps.map((s: any) => s.stepOrder)).toEqual([1, 2, 3])
        const ids = first.body.sequence.steps.map((s: any) => s.id)

        const second = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.admin, body: validPayload })
        expect(second.status).toBe(200)
        expect(second.body.sequence.steps.map((s: any) => s.id)).toEqual(ids)
    })

    it('rejects a body-less email at the API boundary', async () => {
        const campaignId = await createDraftCampaign('Body-less email')
        const result = await call(`/${campaignId}/sequence`, {
            method: 'PUT',
            userId: IDS.admin,
            body: { steps: [{ type: 'email', subject: 'No body' }] },
        })
        expect(result.status).toBe(400)
    })

    it('denies a viewer write', async () => {
        const campaignId = await createDraftCampaign('Viewer write')
        const result = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.viewer, body: validPayload })
        expect(result.status).toBe(403)
    })

    it('denies a cross-tenant write', async () => {
        const campaignId = await createDraftCampaign('Cross tenant write')
        const result = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.outsider, body: validPayload })
        expect(result.status).toBe(403)
    })

    it('rejects edits once the campaign is active', async () => {
        const campaignId = await createDraftCampaign('Active edit')
        await sql`UPDATE campaigns SET status = 'active' WHERE id = ${campaignId}::uuid`
        const result = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.admin, body: validPayload })
        expect(result.status).toBe(409)
    })

    it('refuses to orphan a referenced step and preserves history', async () => {
        const campaignId = await createDraftCampaign('History guard')
        const seeded = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.admin, body: validPayload })
        const tailStepId = seeded.body.sequence.steps[2].id

        const leadId = 'a0000000-0000-4000-8000-0000000000f1'
        const campaignLeadId = 'a0000000-0000-4000-8000-0000000000f2'
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${IDS.account}::uuid, ${IDS.org}::uuid, 'route-sender@example.test', 'localhost', 'sender', 'not-a-real-secret', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${leadId}::uuid, ${IDS.org}::uuid, 'history-guard@example.test')`
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, current_step_id, current_step_order, status)
            VALUES (${campaignLeadId}::uuid, ${campaignId}::uuid, ${leadId}::uuid, ${tailStepId}::uuid, 3, 'contacted')
        `

        const shrink = await call(`/${campaignId}/sequence`, {
            method: 'PUT',
            userId: IDS.admin,
            body: { steps: [{ type: 'email', subject: 'Hello', plainBody: 'Body one' }] },
        })
        expect(shrink.status).toBe(409)
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequence_steps ss
            JOIN sequences s ON s.id = ss.sequence_id
            WHERE s.campaign_id = ${campaignId}::uuid
        `
        expect(Number(count)).toBe(3)
    })
})
