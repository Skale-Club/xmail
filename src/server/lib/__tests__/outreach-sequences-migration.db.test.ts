import { readFile } from 'node:fs/promises'
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
const target = { databaseUrl: testDatabaseUrl as string, runGuard }
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '040_outreach_product_consistency.sql',
)

const IDS = {
    user: 'b0000000-0000-4000-8000-000000000001',
    org: 'b0000000-0000-4000-8000-000000000002',
    account: 'b0000000-0000-4000-8000-000000000003',
}

let sql: ReturnType<typeof postgres>

async function reapply() {
    await applyMigrationFile(target, migrationPath)
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    // 038 adds outreach_emails.origin/idempotency_key/to_address, which the merge test needs to
    // prove send-history references survive. It is idempotent and shared with the dispatch suite.
    await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', '038_outreach_dispatch_state_machine.sql'))
    // The migration test owns the guarded disposable URL explicitly and never touches
    // the application DATABASE_URL. Applying twice proves idempotency.
    await reapply()
    await reapply()

    sql = postgres(testDatabaseUrl as string, { max: 2, prepare: false })
    await sql`INSERT INTO users (id, email) VALUES (${IDS.user}::uuid, 'migration-owner@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'Migration Org', 'migration-org', ${IDS.user}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
        VALUES (${IDS.account}::uuid, ${IDS.org}::uuid, 'migration-sender@example.test', 'localhost', 'sender', 'not-a-real-secret', 'verified')
        ON CONFLICT (id) DO NOTHING
    `
})

afterAll(async () => {
    await sql?.end({ timeout: 1 })
})

describe('outreach product consistency migration 040', () => {
    it('installs the one-sequence-per-campaign index and step invariants', async () => {
        const indexes = await sql<{ indexname: string; indexdef: string }[]>`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'sequences'
              AND indexname = 'sequences_campaign_id_unique'
        `
        expect(indexes).toHaveLength(1)
        expect(indexes[0].indexdef).toContain('UNIQUE')

        const constraints = await sql<{ conname: string }[]>`
            SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.sequence_steps'::regclass
              AND conname IN (
                'sequence_steps_order_positive',
                'sequence_steps_delay_hours_positive',
                'sequence_steps_ab_test_percentage_bounds',
                'sequence_steps_content_valid'
              )
        `
        expect(constraints.map((c) => c.conname).sort()).toEqual([
            'sequence_steps_ab_test_percentage_bounds',
            'sequence_steps_content_valid',
            'sequence_steps_delay_hours_positive',
            'sequence_steps_order_positive',
        ])
    })

    it('keeps the Drizzle mirror aligned with every migration identifier', async () => {
        const schema = await readFile(path.join(process.cwd(), 'src', 'db', 'schema.ts'), 'utf8')
        for (const identifier of [
            'sequences_campaign_id_unique',
            'sequence_steps_order_positive',
            'sequence_steps_delay_hours_positive',
            'sequence_steps_ab_test_percentage_bounds',
            'sequence_steps_content_valid',
        ]) {
            expect(schema).toContain(identifier)
        }
    })

    it('rejects invalid steps at the PostgreSQL boundary', async () => {
        const campaignId = 'b0000000-0000-4000-8000-0000000000a1'
        const sequenceId = 'b0000000-0000-4000-8000-0000000000a2'
        await sql`
            INSERT INTO campaigns (id, organization_id, name) VALUES (${campaignId}::uuid, ${IDS.org}::uuid, 'SQL boundary')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO sequences (id, campaign_id, name) VALUES (${sequenceId}::uuid, ${campaignId}::uuid, 'Boundary')
            ON CONFLICT (id) DO NOTHING
        `

        // step_order = 0 violates one-based ordering
        await expect(sql`
            INSERT INTO sequence_steps (sequence_id, step_order, type, subject, plain_body)
            VALUES (${sequenceId}::uuid, 0, 'email', 'Hi', 'Body')
        `).rejects.toThrow()

        // negative delay
        await expect(sql`
            INSERT INTO sequence_steps (sequence_id, step_order, type, delay_hours)
            VALUES (${sequenceId}::uuid, 5, 'delay', -1)
        `).rejects.toThrow()

        // body-less email
        await expect(sql`
            INSERT INTO sequence_steps (sequence_id, step_order, type, subject)
            VALUES (${sequenceId}::uuid, 6, 'email', 'No body')
        `).rejects.toThrow()

        // non-email carrying sendable content
        await expect(sql`
            INSERT INTO sequence_steps (sequence_id, step_order, type, subject)
            VALUES (${sequenceId}::uuid, 7, 'delay', 'Sneaky subject')
        `).rejects.toThrow()

        // duplicate position within a sequence
        await sql`
            INSERT INTO sequence_steps (sequence_id, step_order, type, subject, plain_body)
            VALUES (${sequenceId}::uuid, 1, 'email', 'First', 'Body')
        `
        await expect(sql`
            INSERT INTO sequence_steps (sequence_id, step_order, type, subject, plain_body)
            VALUES (${sequenceId}::uuid, 1, 'email', 'Dup', 'Body')
        `).rejects.toThrow()
    })

    it('merges surplus sequences into the oldest while preserving step and history references', async () => {
        const campaignId = 'b0000000-0000-4000-8000-0000000000b1'
        const canonicalId = 'b0000000-0000-4000-8000-0000000000b2'
        const surplusId = 'b0000000-0000-4000-8000-0000000000b3'
        const surplusStepId = 'b0000000-0000-4000-8000-0000000000b4'
        const leadId = 'b0000000-0000-4000-8000-0000000000b5'
        const campaignLeadId = 'b0000000-0000-4000-8000-0000000000b6'
        const emailId = 'b0000000-0000-4000-8000-0000000000b7'

        // Temporarily remove the uniqueness so a pre-migration multi-sequence campaign can exist.
        await sql`DROP INDEX IF EXISTS sequences_campaign_id_unique`
        await sql`
            INSERT INTO campaigns (id, organization_id, name, status) VALUES (${campaignId}::uuid, ${IDS.org}::uuid, 'Merge me', 'draft')
        `
        // Canonical is older; surplus (newer) holds the real steps + all live references.
        await sql`
            INSERT INTO sequences (id, campaign_id, name, created_at) VALUES
                (${canonicalId}::uuid, ${campaignId}::uuid, 'Main Sequence', now() - interval '1 hour')
        `
        await sql`
            INSERT INTO sequences (id, campaign_id, name, created_at) VALUES
                (${surplusId}::uuid, ${campaignId}::uuid, 'Editor Sequence', now())
        `
        await sql`
            INSERT INTO sequence_steps (id, sequence_id, step_order, type, subject, plain_body)
            VALUES (${surplusStepId}::uuid, ${surplusId}::uuid, 1, 'email', 'Historic', 'Historic body')
        `
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${leadId}::uuid, ${IDS.org}::uuid, 'merge-lead@example.test')`
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id, current_step_id, current_step_order, status)
            VALUES (${campaignLeadId}::uuid, ${campaignId}::uuid, ${leadId}::uuid, ${surplusStepId}::uuid, 1, 'contacted')
        `
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, origin, idempotency_key, to_address,
                campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
                tracking_token, subject, status, sent_at
            ) VALUES (
                ${emailId}::uuid, ${IDS.org}::uuid, 'campaign', 'merge:b1', 'merge-lead@example.test',
                ${campaignId}::uuid, ${campaignLeadId}::uuid, ${surplusStepId}::uuid, ${IDS.account}::uuid,
                'tok-merge-b1', 'Historic', 'sent', now()
            )
        `

        await reapply()

        const remaining = await sql<{ id: string }[]>`SELECT id FROM sequences WHERE campaign_id = ${campaignId}::uuid`
        expect(remaining).toHaveLength(1)
        expect(remaining[0].id).toBe(canonicalId)

        // The historic step survived (same id) and now belongs to the canonical sequence.
        const [step] = await sql<{ sequence_id: string }[]>`SELECT sequence_id FROM sequence_steps WHERE id = ${surplusStepId}::uuid`
        expect(step.sequence_id).toBe(canonicalId)

        // Live references stayed intact — no history was orphaned.
        const [lead] = await sql<{ current_step_id: string }[]>`SELECT current_step_id FROM campaign_leads WHERE id = ${campaignLeadId}::uuid`
        expect(lead.current_step_id).toBe(surplusStepId)
        const [email] = await sql<{ sequence_step_id: string }[]>`SELECT sequence_step_id FROM outreach_emails WHERE id = ${emailId}::uuid`
        expect(email.sequence_step_id).toBe(surplusStepId)

        // Uniqueness is restored after reconciliation.
        const restored = await sql<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes WHERE tablename = 'sequences' AND indexname = 'sequences_campaign_id_unique'
        `
        expect(restored).toHaveLength(1)
    })

    it('aborts instead of dropping content when step positions conflict', async () => {
        const campaignId = 'b0000000-0000-4000-8000-0000000000c1'
        const seqA = 'b0000000-0000-4000-8000-0000000000c2'
        const seqB = 'b0000000-0000-4000-8000-0000000000c3'
        const stepA = 'b0000000-0000-4000-8000-0000000000c4'
        const stepB = 'b0000000-0000-4000-8000-0000000000c5'

        await sql`DROP INDEX IF EXISTS sequences_campaign_id_unique`
        await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES (${campaignId}::uuid, ${IDS.org}::uuid, 'Conflict', 'draft')`
        await sql`
            INSERT INTO sequences (id, campaign_id, name, created_at) VALUES
                (${seqA}::uuid, ${campaignId}::uuid, 'Seq A', now() - interval '1 hour'),
                (${seqB}::uuid, ${campaignId}::uuid, 'Seq B', now())
        `
        await sql`
            INSERT INTO sequence_steps (id, sequence_id, step_order, type, subject, plain_body) VALUES
                (${stepA}::uuid, ${seqA}::uuid, 1, 'email', 'A', 'A body'),
                (${stepB}::uuid, ${seqB}::uuid, 1, 'email', 'B', 'B body')
        `

        // The migration aborts (its transaction rolls back) rather than dropping content. The
        // RAISE fires inside a transactional batch, so postgres surfaces the aborted-transaction
        // error; the authoritative proof of non-destruction is that both steps survive below.
        await expect(reapply()).rejects.toThrow(/040_outreach_product_consistency/)

        // Both conflicting steps still exist — nothing was silently dropped.
        const steps = await sql<{ id: string }[]>`
            SELECT id FROM sequence_steps WHERE id IN (${stepA}::uuid, ${stepB}::uuid)
        `
        expect(steps).toHaveLength(2)

        // Repair for the shared database and restore the uniqueness invariant.
        await sql`DELETE FROM campaigns WHERE id = ${campaignId}::uuid`
        await reapply()
        const restored = await sql<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes WHERE tablename = 'sequences' AND indexname = 'sequences_campaign_id_unique'
        `
        expect(restored).toHaveLength(1)
    })
})
