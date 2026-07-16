import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '040_outreach_product_consistency.sql',
)

// Distinct id prefix so this suite never collides with the route or migration suites
// that share the single disposable database.
const IDS = {
    user: '90000000-0000-4000-8000-000000000001',
    org: '90000000-0000-4000-8000-000000000002',
    otherOrg: '90000000-0000-4000-8000-000000000003',
    account: '90000000-0000-4000-8000-000000000004',
}

let sql: ReturnType<typeof postgres>
let service: typeof import('../outreach-sequences')
let closeApplicationDatabase: (() => Promise<void>) | undefined

async function seedCampaign(campaignId: string, opts: { status?: string; orgId?: string } = {}) {
    const orgId = opts.orgId ?? IDS.org
    const status = opts.status ?? 'draft'
    await sql`
        INSERT INTO campaigns (id, organization_id, name, status)
        VALUES (${campaignId}::uuid, ${orgId}::uuid, 'Canonical', ${status}::campaign_status)
        ON CONFLICT (id) DO NOTHING
    `
    const [sequence] = await sql<{ id: string }[]>`
        INSERT INTO sequences (id, campaign_id, name)
        VALUES (gen_random_uuid(), ${campaignId}::uuid, 'Main Sequence')
        RETURNING id
    `
    return sequence.id
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    // Idempotent, advisory-locked; safe when a sibling suite already applied it.
    await applyMigrationFile(target, migrationPath)
    await applyMigrationFile(target, migrationPath)

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES (${IDS.user}::uuid, 'seq-owner@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id) VALUES
            (${IDS.org}::uuid, 'Seq Org', 'seq-org', ${IDS.user}::uuid),
            (${IDS.otherOrg}::uuid, 'Other Org', 'seq-other-org', ${IDS.user}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
        VALUES (${IDS.account}::uuid, ${IDS.org}::uuid, 'sender@example.test', 'localhost', 'sender', 'not-a-real-secret', 'verified')
        ON CONFLICT (id) DO NOTHING
    `

    service = await import('../outreach-sequences')
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('sequencePayloadSchema', () => {
    it('requires at least one step', () => {
        const result = service.sequencePayloadSchema.safeParse({ steps: [] })
        expect(result.success).toBe(false)
    })

    it('requires a subject and a body on email steps', () => {
        expect(service.sequencePayloadSchema.safeParse({
            steps: [{ type: 'email', subject: '', htmlBody: '<p>hi</p>' }],
        }).success).toBe(false)
        expect(service.sequencePayloadSchema.safeParse({
            steps: [{ type: 'email', subject: 'Hello', plainBody: '', htmlBody: '' }],
        }).success).toBe(false)
        expect(service.sequencePayloadSchema.safeParse({
            steps: [{ type: 'email', subject: 'Hello', plainBody: 'Body' }],
        }).success).toBe(true)
    })

    it('forbids sendable content on non-email steps', () => {
        expect(service.sequencePayloadSchema.safeParse({
            steps: [{ type: 'delay', delayHours: 24, subject: 'sneaky' }],
        }).success).toBe(false)
        expect(service.sequencePayloadSchema.safeParse({
            steps: [
                { type: 'email', subject: 'Hi', plainBody: 'Body' },
                { type: 'delay', delayHours: 48 },
            ],
        }).success).toBe(true)
    })

    it('rejects a negative delay', () => {
        expect(service.sequencePayloadSchema.safeParse({
            steps: [{ type: 'delay', delayHours: -1 }],
        }).success).toBe(false)
    })
})

describe('getCanonicalSequence', () => {
    it('resolves the single sequence scoped through the campaign organization', async () => {
        const campaignId = '90000000-0000-4000-8000-0000000000a1'
        await seedCampaign(campaignId)

        const canonical = await service.getCanonicalSequence(campaignId, IDS.org)
        expect(canonical).not.toBeNull()
        expect(canonical?.campaignId).toBe(campaignId)
        expect(Array.isArray(canonical?.steps)).toBe(true)
    })

    it('denies cross-tenant reads', async () => {
        const campaignId = '90000000-0000-4000-8000-0000000000a2'
        await seedCampaign(campaignId)
        expect(await service.getCanonicalSequence(campaignId, IDS.otherOrg)).toBeNull()
    })
})

describe('replaceCanonicalSequence', () => {
    it('writes a one-based contiguous step set and is idempotent for the same payload', async () => {
        const campaignId = '90000000-0000-4000-8000-0000000000b1'
        await seedCampaign(campaignId)
        const payload = service.sequencePayloadSchema.parse({
            steps: [
                { type: 'email', subject: 'Intro', plainBody: 'Hi there' },
                { type: 'delay', delayHours: 48 },
                { type: 'email', subject: 'Follow up', htmlBody: '<p>Following up</p>' },
            ],
        })

        const first = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.org, payload })
        expect(first.ok).toBe(true)
        if (!first.ok) throw new Error('expected success')
        expect(first.sequence.steps.map((s) => s.stepOrder)).toEqual([1, 2, 3])
        const firstIds = first.sequence.steps.map((s) => s.id)

        const second = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.org, payload })
        expect(second.ok).toBe(true)
        if (!second.ok) throw new Error('expected success')
        // Idempotent: same positions keep their identity and the row count does not grow.
        expect(second.sequence.steps.map((s) => s.id)).toEqual(firstIds)

        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequence_steps ss
            JOIN sequences s ON s.id = ss.sequence_id
            WHERE s.campaign_id = ${campaignId}::uuid
        `
        expect(Number(count)).toBe(3)
    })

    it('rejects edits to an active campaign but allows a paused one', async () => {
        const activeId = '90000000-0000-4000-8000-0000000000b2'
        await seedCampaign(activeId, { status: 'active' })
        const payload = service.sequencePayloadSchema.parse({
            steps: [{ type: 'email', subject: 'Hi', plainBody: 'Body' }],
        })
        const denied = await service.replaceCanonicalSequence({ campaignId: activeId, organizationId: IDS.org, payload })
        expect(denied.ok).toBe(false)
        if (denied.ok) throw new Error('expected rejection')
        expect(denied.reason).toBe('campaign_not_editable')

        const pausedId = '90000000-0000-4000-8000-0000000000b3'
        await seedCampaign(pausedId, { status: 'paused' })
        const allowed = await service.replaceCanonicalSequence({ campaignId: pausedId, organizationId: IDS.org, payload })
        expect(allowed.ok).toBe(true)
    })

    it('denies cross-tenant writes', async () => {
        const campaignId = '90000000-0000-4000-8000-0000000000b4'
        await seedCampaign(campaignId)
        const payload = service.sequencePayloadSchema.parse({
            steps: [{ type: 'email', subject: 'Hi', plainBody: 'Body' }],
        })
        const result = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.otherOrg, payload })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected rejection')
        expect(result.reason).toBe('campaign_not_found')
    })

    it('preserves the id of a referenced step it edits in place', async () => {
        const campaignId = '90000000-0000-4000-8000-0000000000b5'
        await seedCampaign(campaignId)
        const initial = service.sequencePayloadSchema.parse({
            steps: [
                { type: 'email', subject: 'Original', plainBody: 'Original body' },
                { type: 'email', subject: 'Second', plainBody: 'Second body' },
            ],
        })
        const created = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.org, payload: initial })
        if (!created.ok) throw new Error('expected success')
        const firstStepId = created.sequence.steps[0].id

        // Wire the first step to lead + send history.
        const leadId = '90000000-0000-4000-8000-0000000000c5'
        const campaignLeadId = '90000000-0000-4000-8000-0000000000d5'
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${leadId}::uuid, ${IDS.org}::uuid, 'ref-lead-b5@example.test')`
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, current_step_id, current_step_order, status)
            VALUES (${campaignLeadId}::uuid, ${campaignId}::uuid, ${leadId}::uuid, ${firstStepId}::uuid, 1, 'contacted')
        `
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, origin, idempotency_key, to_address,
                campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
                tracking_token, subject, status, sent_at
            ) VALUES (
                gen_random_uuid(), ${IDS.org}::uuid, 'campaign', 'ref:b5', 'ref-lead-b5@example.test',
                ${campaignId}::uuid, ${campaignLeadId}::uuid, ${firstStepId}::uuid, ${IDS.account}::uuid,
                'tok-b5', 'Original', 'sent', NOW()
            )
        `

        const edited = service.sequencePayloadSchema.parse({
            steps: [
                { type: 'email', subject: 'Edited subject', plainBody: 'Edited body' },
                { type: 'email', subject: 'Second', plainBody: 'Second body' },
            ],
        })
        const result = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.org, payload: edited })
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error('expected success')
        // Same position → same id preserved, so the historical references stay valid.
        expect(result.sequence.steps[0].id).toBe(firstStepId)
        expect(result.sequence.steps[0].subject).toBe('Edited subject')

        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM outreach_emails WHERE sequence_step_id = ${firstStepId}::uuid
        `
        expect(Number(count)).toBe(1)
    })

    it('refuses to delete a referenced tail step and leaves history intact', async () => {
        const campaignId = '90000000-0000-4000-8000-0000000000b6'
        await seedCampaign(campaignId)
        const initial = service.sequencePayloadSchema.parse({
            steps: [
                { type: 'email', subject: 'Keep', plainBody: 'Keep body' },
                { type: 'email', subject: 'Referenced', plainBody: 'Referenced body' },
            ],
        })
        const created = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.org, payload: initial })
        if (!created.ok) throw new Error('expected success')
        const tailStepId = created.sequence.steps[1].id

        const leadId = '90000000-0000-4000-8000-0000000000c6'
        const campaignLeadId = '90000000-0000-4000-8000-0000000000d6'
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${leadId}::uuid, ${IDS.org}::uuid, 'ref-lead-b6@example.test')`
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, current_step_id, current_step_order, status)
            VALUES (${campaignLeadId}::uuid, ${campaignId}::uuid, ${leadId}::uuid, ${tailStepId}::uuid, 2, 'contacted')
        `

        const shrink = service.sequencePayloadSchema.parse({
            steps: [{ type: 'email', subject: 'Keep', plainBody: 'Keep body' }],
        })
        const result = await service.replaceCanonicalSequence({ campaignId, organizationId: IDS.org, payload: shrink })
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('expected conflict')
        expect(result.reason).toBe('history_conflict')

        // Nothing was deleted — the referenced step and its lead pointer survive intact.
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM sequence_steps ss
            JOIN sequences s ON s.id = ss.sequence_id
            WHERE s.campaign_id = ${campaignId}::uuid
        `
        expect(Number(count)).toBe(2)
        const [{ current_step_id }] = await sql<{ current_step_id: string | null }[]>`
            SELECT current_step_id FROM campaign_leads WHERE id = ${campaignLeadId}::uuid
        `
        expect(current_step_id).toBe(tailStepId)
    })
})
