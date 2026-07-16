import postgres from 'postgres'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    applyMigrationFile,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const userId = '40000000-0000-4000-8000-000000000001'
const organizationId = '40000000-0000-4000-8000-000000000002'

let sql: ReturnType<typeof postgres>
let markCompletedCampaigns: () => Promise<void>
let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const migrationTarget = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(migrationTarget, path.join(process.cwd(), 'supabase', 'migrations', '012_add_provider_to_email_accounts.sql'))
    await applyMigrationFile(migrationTarget, path.join(process.cwd(), 'supabase', 'migrations', '033_email_accounts_provider_source.sql'))
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })
    await sql`INSERT INTO users (id, email) VALUES (${userId}::uuid, 'lifecycle@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${organizationId}::uuid, 'Lifecycle', 'lifecycle', ${userId}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    const processor = await import('../processOutreachSequences')
    markCompletedCampaigns = processor.markCompletedCampaigns
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
    await sql.end({ timeout: 1 })
})

describe('campaign completion lifecycle', () => {
    // Phase 23 (AI-03/04): the direct-send follow-up path is retired. processFollowUps no longer
    // sends from a legacy next_follow_up_at row — it DRAINS the armed column (no send) so the campaign
    // can complete, while autonomous sends now flow only through audited, leased runs. The campaign
    // lifecycle (stay active while a follow-up is armed, then complete once drained) is unchanged.
    it('keeps an agentic campaign active until its persisted follow-up is drained', async () => {
        const campaignId = '40000000-0000-4000-8000-000000000011'
        const leadId = '40000000-0000-4000-8000-000000000012'
        const campaignLeadId = '40000000-0000-4000-8000-000000000013'
        await sql`
            INSERT INTO campaigns (id, organization_id, name, status, agentic_followup_enabled)
            VALUES (${campaignId}::uuid, ${organizationId}::uuid, 'Agentic lifecycle', 'active', TRUE)
        `
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${leadId}::uuid, ${organizationId}::uuid, 'agentic-lead@example.test')`
        await sql`
            INSERT INTO campaign_leads (
                id, campaign_id, lead_id, status, next_scheduled_at,
                next_follow_up_at, last_reply_message_id, last_reply_text
            ) VALUES (
                ${campaignLeadId}::uuid, ${campaignId}::uuid, ${leadId}::uuid, 'replied', NULL,
                NOW(), 'reply-agentic@example.test', 'Please tell me more'
            )
        `

        await markCompletedCampaigns()
        const [pending] = await sql<{ status: string }[]>`SELECT status::text AS status FROM campaigns WHERE id = ${campaignId}::uuid`
        expect(pending.status).toBe('active')

        const { processFollowUps } = await import('../processFollowUps')
        const followUpResult = await processFollowUps()
        // The legacy row is DRAINED (cleared, never sent); no autonomous run exists for it.
        expect(followUpResult.legacyDrained).toBe(1)
        const [followedUp] = await sql<{ next_follow_up_at: Date | null }[]>`
            SELECT next_follow_up_at FROM campaign_leads WHERE id = ${campaignLeadId}::uuid
        `
        expect(followedUp.next_follow_up_at).toBeNull()

        await markCompletedCampaigns()
        const [completed] = await sql<{ status: string }[]>`SELECT status::text AS status FROM campaigns WHERE id = ${campaignId}::uuid`
        expect(completed.status).toBe('completed')
    })

    it('rechecks progress after a concurrent enrollment commits under the shared campaign lock', async () => {
        const campaignId = '40000000-0000-4000-8000-000000000021'
        const terminalLeadId = '40000000-0000-4000-8000-000000000022'
        const terminalCampaignLeadId = '40000000-0000-4000-8000-000000000023'
        const newLeadId = '40000000-0000-4000-8000-000000000024'
        const newCampaignLeadId = '40000000-0000-4000-8000-000000000025'
        await sql`
            INSERT INTO campaigns (id, organization_id, name, status)
            VALUES (${campaignId}::uuid, ${organizationId}::uuid, 'Concurrent enrollment', 'active')
        `
        await sql`
            INSERT INTO leads (id, organization_id, email) VALUES
                (${terminalLeadId}::uuid, ${organizationId}::uuid, 'terminal@example.test'),
                (${newLeadId}::uuid, ${organizationId}::uuid, 'new@example.test')
        `
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, status)
            VALUES (${terminalCampaignLeadId}::uuid, ${campaignId}::uuid, ${terminalLeadId}::uuid, 'replied')
        `

        let enrollmentLocked!: () => void
        const locked = new Promise<void>((resolve) => { enrollmentLocked = resolve })
        let releaseEnrollment!: () => void
        const release = new Promise<void>((resolve) => { releaseEnrollment = resolve })
        const enrollment = (async () => {
            const reserved = await sql.reserve()
            try {
                await reserved`BEGIN`
                await reserved`SELECT id FROM campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`
                await reserved`
                INSERT INTO campaign_leads (id, campaign_id, lead_id, status, next_scheduled_at)
                VALUES (${newCampaignLeadId}::uuid, ${campaignId}::uuid, ${newLeadId}::uuid, 'new', NOW())
                `
                enrollmentLocked()
                await release
                await reserved`COMMIT`
            } catch (error) {
                await reserved`ROLLBACK`
                throw error
            } finally {
                reserved.release()
            }
        })()

        await locked
        const completion = markCompletedCampaigns()
        await new Promise((resolve) => setTimeout(resolve, 50))
        releaseEnrollment()
        await Promise.all([enrollment, completion])

        const [campaign] = await sql<{ status: string }[]>`SELECT status::text AS status FROM campaigns WHERE id = ${campaignId}::uuid`
        expect(campaign.status).toBe('active')
        const [newLead] = await sql<{ status: string }[]>`SELECT status::text AS status FROM campaign_leads WHERE id = ${newCampaignLeadId}::uuid`
        expect(newLead.status).toBe('new')
    })
})
