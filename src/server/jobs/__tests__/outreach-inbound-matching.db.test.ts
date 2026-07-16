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
const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '038_outreach_dispatch_state_machine.sql')

let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    await applyMigrationFile({ databaseUrl: testDatabaseUrl, runGuard }, migrationPath)
    process.env.DATABASE_URL = testDatabaseUrl

    const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
    try {
        const ids = {
            userA: '30000000-0000-4000-8000-000000000001', userB: '30000000-0000-4000-8000-000000000002',
            orgA: '30000000-0000-4000-8000-000000000011', orgB: '30000000-0000-4000-8000-000000000012',
            accountA: '30000000-0000-4000-8000-000000000021', accountB: '30000000-0000-4000-8000-000000000022',
            campaignA: '30000000-0000-4000-8000-000000000031', campaignB: '30000000-0000-4000-8000-000000000032',
            leadA: '30000000-0000-4000-8000-000000000041', leadB: '30000000-0000-4000-8000-000000000042',
            sequenceA: '30000000-0000-4000-8000-000000000051', sequenceB: '30000000-0000-4000-8000-000000000052',
            stepA: '30000000-0000-4000-8000-000000000061', stepB: '30000000-0000-4000-8000-000000000062',
            campaignLeadA: '30000000-0000-4000-8000-000000000071', campaignLeadB: '30000000-0000-4000-8000-000000000072',
            emailA: '30000000-0000-4000-8000-000000000081', emailB: '30000000-0000-4000-8000-000000000082',
        }
        await sql`
            INSERT INTO users (id, email) VALUES
                (${ids.userA}::uuid, 'inbound-a@example.test'),
                (${ids.userB}::uuid, 'inbound-b@example.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO organizations (id, name, slug, owner_id) VALUES
                (${ids.orgA}::uuid, 'Inbound A', 'inbound-a', ${ids.userA}::uuid),
                (${ids.orgB}::uuid, 'Inbound B', 'inbound-b', ${ids.userB}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO email_accounts (
                id, organization_id, email, status, smtp_host, smtp_username, smtp_password
            ) VALUES
                (${ids.accountA}::uuid, ${ids.orgA}::uuid, 'sender-a@example.test', 'verified', 'localhost', 'a', 'test'),
                (${ids.accountB}::uuid, ${ids.orgB}::uuid, 'sender-b@example.test', 'verified', 'localhost', 'b', 'test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO campaigns (id, organization_id, name) VALUES
                (${ids.campaignA}::uuid, ${ids.orgA}::uuid, 'Campaign A'),
                (${ids.campaignB}::uuid, ${ids.orgB}::uuid, 'Campaign B')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO leads (id, organization_id, email) VALUES
                (${ids.leadA}::uuid, ${ids.orgA}::uuid, 'lead-a@example.test'),
                (${ids.leadB}::uuid, ${ids.orgB}::uuid, 'lead-b@example.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO sequences (id, campaign_id, name) VALUES
                (${ids.sequenceA}::uuid, ${ids.campaignA}::uuid, 'Sequence A'),
                (${ids.sequenceB}::uuid, ${ids.campaignB}::uuid, 'Sequence B')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO sequence_steps (id, sequence_id, step_order, subject, plain_body) VALUES
                (${ids.stepA}::uuid, ${ids.sequenceA}::uuid, 1, 'A', 'A'),
                (${ids.stepB}::uuid, ${ids.sequenceB}::uuid, 1, 'B', 'B')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, assigned_email_account_id, current_step_id) VALUES
                (${ids.campaignLeadA}::uuid, ${ids.campaignA}::uuid, ${ids.leadA}::uuid, ${ids.accountA}::uuid, ${ids.stepA}::uuid),
                (${ids.campaignLeadB}::uuid, ${ids.campaignB}::uuid, ${ids.leadB}::uuid, ${ids.accountB}::uuid, ${ids.stepB}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, origin, idempotency_key, to_address,
                campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
                tracking_token, subject, message_id, status, sent_at
            ) VALUES
                (${ids.emailA}::uuid, ${ids.orgA}::uuid, 'campaign', 'inbound:a', 'lead-a@example.test',
                 ${ids.campaignA}::uuid, ${ids.campaignLeadA}::uuid, ${ids.stepA}::uuid, ${ids.accountA}::uuid,
                 'inbound-token-a', 'A', 'shared-message@example.test', 'sent', NOW()),
                (${ids.emailB}::uuid, ${ids.orgB}::uuid, 'campaign', 'inbound:b', 'lead-b@example.test',
                 ${ids.campaignB}::uuid, ${ids.campaignLeadB}::uuid, ${ids.stepB}::uuid, ${ids.accountB}::uuid,
                 'inbound-token-b', 'B', 'shared-message@example.test', 'sent', NOW())
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }

    const database = await import('../../../db')
    closeApplicationDatabase = database.closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
})

describe('tenant-safe inbound Message-ID matching', () => {
    it('returns only the outreach email owned by the active reply account', async () => {
        const { findOutreachEmailByMessageId } = await import('../processReplies')
        const matched = await findOutreachEmailByMessageId(
            '<shared-message@example.test>',
            '30000000-0000-4000-8000-000000000021',
        )
        expect(matched).toMatchObject({
            id: '30000000-0000-4000-8000-000000000081',
            organizationId: '30000000-0000-4000-8000-000000000011',
            emailAccountId: '30000000-0000-4000-8000-000000000021',
        })
    })

    it('requires both the bounce account and its organization', async () => {
        const { findBouncedOutreachEmailByMessageId } = await import('../processBounces')
        await expect(findBouncedOutreachEmailByMessageId(
            'shared-message@example.test',
            '30000000-0000-4000-8000-000000000021',
            '30000000-0000-4000-8000-000000000011',
        )).resolves.toMatchObject({ id: '30000000-0000-4000-8000-000000000081' })
        await expect(findBouncedOutreachEmailByMessageId(
            'shared-message@example.test',
            '30000000-0000-4000-8000-000000000021',
            '30000000-0000-4000-8000-000000000012',
        )).resolves.toBeNull()
    })
})
