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

// B-1 regression: the legacy DELETE /sequences/:sequenceId and DELETE /sequences/steps/:stepId
// endpoints must honour the SAME history-preservation contract as PUT /:campaignId/sequence.
// A step referenced by sent send history cannot be hard-deleted (outreach_emails.sequence_step_id
// is ON DELETE CASCADE), and a campaign's single canonical sequence can never be dropped to zero.

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')

// Distinct id prefix so this suite never collides with sibling suites sharing the disposable DB.
const IDS = {
    admin: 'a2000000-0000-4000-8000-000000000001',
    viewer: 'a2000000-0000-4000-8000-000000000002',
    outsider: 'a2000000-0000-4000-8000-000000000003',
    org: 'a2000000-0000-4000-8000-000000000004',
    account: 'a2000000-0000-4000-8000-000000000005',
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

async function seedDraftCampaign(id: string): Promise<void> {
    await sql`
        INSERT INTO campaigns (id, organization_id, name, status)
        VALUES (${id}::uuid, ${IDS.org}::uuid, 'Delete guard', 'draft'::campaign_status)
        ON CONFLICT (id) DO NOTHING
    `
}

async function seedSequence(campaignId: string, steps: unknown[]): Promise<{ sequenceId: string; stepIds: string[] }> {
    const result = await call(`/${campaignId}/sequence`, { method: 'PUT', userId: IDS.admin, body: { steps } })
    expect(result.status).toBe(200)
    return {
        sequenceId: result.body.sequence.id as string,
        stepIds: result.body.sequence.steps.map((s: any) => s.id as string),
    }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    // 038 provides outreach_emails.origin/idempotency_key/to_address for the send-history fixtures;
    // 040 provides the canonical-sequence contract. Both idempotent + advisory-locked.
    await applyMigrationFile(target, path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql'))
    await applyMigrationFile(target, path.join(migrationsDir, '040_outreach_product_consistency.sql'))

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`
        INSERT INTO users (id, email) VALUES
            (${IDS.admin}::uuid, 'del-admin@example.test'),
            (${IDS.viewer}::uuid, 'del-viewer@example.test'),
            (${IDS.outsider}::uuid, 'del-outsider@example.test')
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id) VALUES
            (${IDS.org}::uuid, 'Delete Org', 'delete-org', ${IDS.admin}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO organization_users (organization_id, user_id, role) VALUES
            (${IDS.org}::uuid, ${IDS.admin}::uuid, 'admin'),
            (${IDS.org}::uuid, ${IDS.viewer}::uuid, 'viewer')
        ON CONFLICT (organization_id, user_id) DO NOTHING
    `
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
        VALUES (${IDS.account}::uuid, ${IDS.org}::uuid, 'del-sender@example.test', 'localhost', 'sender', 'not-a-real-secret', 'verified')
        ON CONFLICT (id) DO NOTHING
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('DELETE /sequences/steps/:stepId — history preservation (B-1)', () => {
    it('refuses to delete a step referenced by a sent outreach_email and keeps the send history', async () => {
        const campaignId = 'a2000000-0000-4000-8000-0000000000a1'
        await seedDraftCampaign(campaignId)
        const { stepIds } = await seedSequence(campaignId, [
            { type: 'email', subject: 'One', plainBody: 'Body one' },
            { type: 'email', subject: 'Two', plainBody: 'Body two' },
        ])
        const referencedStepId = stepIds[1]

        const leadId = 'a2000000-0000-4000-8000-0000000000a2'
        const campaignLeadId = 'a2000000-0000-4000-8000-0000000000a3'
        const emailId = 'a2000000-0000-4000-8000-0000000000a4'
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${leadId}::uuid, ${IDS.org}::uuid, 'del-ref@example.test')`
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, current_step_id, current_step_order, status)
            VALUES (${campaignLeadId}::uuid, ${campaignId}::uuid, ${leadId}::uuid, ${referencedStepId}::uuid, 2, 'contacted')
        `
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, origin, idempotency_key, to_address,
                campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
                tracking_token, subject, status, sent_at
            ) VALUES (
                ${emailId}::uuid, ${IDS.org}::uuid, 'campaign', 'del:a4', 'del-ref@example.test',
                ${campaignId}::uuid, ${campaignLeadId}::uuid, ${referencedStepId}::uuid, ${IDS.account}::uuid,
                'tok-a4', 'Two', 'sent', NOW()
            )
        `

        const del = await call(`/sequences/steps/${referencedStepId}`, { method: 'DELETE', userId: IDS.admin })
        expect(del.status).toBe(409)
        expect(del.body.code).toBe('sequence_step_referenced')

        // The referenced step and, crucially, the sent send-history row both survive.
        const [{ count: emailCount }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM outreach_emails WHERE id = ${emailId}::uuid
        `
        expect(Number(emailCount)).toBe(1)
        const [{ count: stepCount }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequence_steps WHERE id = ${referencedStepId}::uuid
        `
        expect(Number(stepCount)).toBe(1)
    })

    it('still deletes an unreferenced trailing step', async () => {
        const campaignId = 'a2000000-0000-4000-8000-0000000000b1'
        await seedDraftCampaign(campaignId)
        const { stepIds } = await seedSequence(campaignId, [
            { type: 'email', subject: 'Keep', plainBody: 'Keep body' },
            { type: 'email', subject: 'Drop', plainBody: 'Drop body' },
        ])
        const unreferencedTail = stepIds[1]

        const del = await call(`/sequences/steps/${unreferencedTail}`, { method: 'DELETE', userId: IDS.admin })
        expect(del.status).toBe(200)
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequence_steps WHERE id = ${unreferencedTail}::uuid
        `
        expect(Number(count)).toBe(0)
    })

    it('keeps the requireOutreachWrite guard (a viewer cannot delete a step)', async () => {
        const campaignId = 'a2000000-0000-4000-8000-0000000000d1'
        await seedDraftCampaign(campaignId)
        const { stepIds } = await seedSequence(campaignId, [
            { type: 'email', subject: 'Keep', plainBody: 'Keep body' },
            { type: 'email', subject: 'Tail', plainBody: 'Tail body' },
        ])

        const del = await call(`/sequences/steps/${stepIds[1]}`, { method: 'DELETE', userId: IDS.viewer })
        expect(del.status).toBe(403)
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequence_steps WHERE id = ${stepIds[1]}::uuid
        `
        expect(Number(count)).toBe(1)
    })
})

describe('DELETE /sequences/:sequenceId — canonical invariant (B-1)', () => {
    it('refuses to delete a campaign down to zero sequences', async () => {
        const campaignId = 'a2000000-0000-4000-8000-0000000000c1'
        await seedDraftCampaign(campaignId)
        const { sequenceId } = await seedSequence(campaignId, [
            { type: 'email', subject: 'Only', plainBody: 'Only body' },
        ])

        const del = await call(`/sequences/${sequenceId}`, { method: 'DELETE', userId: IDS.admin })
        expect(del.status).toBe(409)

        // The campaign still resolves exactly one canonical sequence (CONS-01 invariant).
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequences WHERE campaign_id = ${campaignId}::uuid
        `
        expect(Number(count)).toBe(1)
    })
})
