/**
 * Bounded restart-safe backfill suite (Phase 21 UIF-05).
 *
 * The backfill closes any crash window between a durable send / staged inbound event and its
 * Unified Inbox materialization WITHOUT resending mail or duplicating side effects. It uses
 * tenant-leading `NOT EXISTS` anti-joins over `outreach-email:<id>` / provider source keys with
 * deterministic `(sent_at,id)` / `(received_at,id)` ordering and reuses the live idempotent
 * materializers. Because a materialized row disappears from the anti-join, interruption and
 * restart converge to the same row counts as one run, with no separate checkpoint table.
 *
 * Outbound batches run BEFORE inbound batches so a historical reply's References attach to the
 * outbound root's conversation.
 *
 * Shared disposable database: apply every touched migration in beforeAll; clean up own rows.
 */
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import { backfillUnifiedInbox } from '../backfillUnifiedInbox'
import type { UnifiedInboxSql } from '../../lib/unified-inbox/ingest'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

const P = '21033000-0000-4000-8000-0000000000'
const OWNER = `${P}01`
const ORG_A = `${P}02`
const ACCOUNT_A = `${P}11`
const LEAD_A = `${P}21`
const CAMP_A = `${P}31`
const CL_A = `${P}41`
const S1 = `${P}51`
const S2 = `${P}52`
const S3 = `${P}53`
const S1_MESSAGE_ID = 's1-root@mail.test'

function connect(max = 3): postgres.Sql {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max, prepare: false, onnotice: () => {} })
}

const NOW = new Date('2026-07-16T12:00:00.000Z')
function deps(sql: postgres.Sql, extra: Record<string, unknown> = {}) {
    return { sql: sql as unknown as UnifiedInboxSql, now: () => NOW, organizationId: ORG_A, ...extra }
}

async function countMessages(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM outreach_conversation_messages WHERE organization_id = ${ORG_A}::uuid
    `
    return Number(rows[0].n)
}

async function seedSentEmails(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO outreach_emails (
            id, organization_id, origin, idempotency_key, to_address, subject, plain_body,
            campaign_id, campaign_lead_id, email_account_id, message_id, status, sent_at
        ) VALUES
            (${S1}::uuid, ${ORG_A}::uuid, 'agentic', 'bf-s1', 'alice@lead.test', 'S1', 'Body 1',
             ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, ${S1_MESSAGE_ID}, 'sent', ${new Date('2026-07-16T10:00:00Z')}),
            (${S2}::uuid, ${ORG_A}::uuid, 'agentic', 'bf-s2', 'alice@lead.test', 'S2', 'Body 2',
             ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, 's2-root@mail.test', 'sent', ${new Date('2026-07-16T10:05:00Z')}),
            (${S3}::uuid, ${ORG_A}::uuid, 'agentic', 'bf-s3', 'alice@lead.test', 'S3', 'Body 3',
             ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, 's3-root@mail.test', 'sent', ${new Date('2026-07-16T10:10:00Z')})
        ON CONFLICT (id) DO NOTHING
    `
}

async function seedInboundReply(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO outreach_provider_events (
            organization_id, email_account_id, provider, provider_message_id,
            message_id, in_reply_to, classification, from_address, to_addresses,
            subject, text_body, received_at
        ) VALUES (
            ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', 'bf-reply-to-s1',
            '<bf-reply-1@lead.test>', ${`<${S1_MESSAGE_ID}>`}, 'reply', 'alice@lead.test',
            ${JSON.stringify(['inbox-a@example.test'])}::jsonb, 'Re: S1', 'Historical reply body.',
            ${new Date('2026-07-16T11:00:00Z')}
        )
        ON CONFLICT (organization_id, email_account_id, provider, provider_message_id) DO NOTHING
    `
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    const sql = connect()
    try {
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'bf-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG_A}::uuid, 'Backfill A', 'backfill-a', ${OWNER}::uuid) ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'inbox-a@example.test', 'localhost', 'a', 'x', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`INSERT INTO leads (id, organization_id, email) VALUES (${LEAD_A}::uuid, ${ORG_A}::uuid, 'alice@lead.test') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO campaigns (id, organization_id, name) VALUES (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Camp A') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES (${CL_A}::uuid, ${CAMP_A}::uuid, ${LEAD_A}::uuid) ON CONFLICT (id) DO NOTHING`
    } finally {
        await sql.end({ timeout: 1 })
    }
})

async function cleanup(): Promise<void> {
    const sql = connect()
    try {
        await sql`DELETE FROM outreach_provider_events WHERE organization_id = ${ORG_A}::uuid`
        await sql`DELETE FROM outreach_conversations WHERE organization_id = ${ORG_A}::uuid`
        await sql`DELETE FROM outreach_emails WHERE organization_id = ${ORG_A}::uuid`
    } finally {
        await sql.end({ timeout: 1 })
    }
}

beforeEach(cleanup)
afterAll(cleanup)

describe('backfillUnifiedInbox', () => {
    it('materializes sent outreach emails and staged inbound events that lack a normalized message', async () => {
        const sql = connect()
        try {
            await seedSentEmails(sql)
            await seedInboundReply(sql)

            const result = await backfillUnifiedInbox(deps(sql))
            expect(result.outbound.scanned).toBe(3)
            expect(result.outbound.inserted).toBe(3)
            expect(result.inbound.scanned).toBe(1)
            expect(result.inbound.inserted).toBe(1)
            expect(await countMessages(sql)).toBe(4)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('is restart-safe: a second run inserts nothing and changes no row counts', async () => {
        const sql = connect()
        try {
            await seedSentEmails(sql)
            await seedInboundReply(sql)

            await backfillUnifiedInbox(deps(sql))
            const afterFirst = await countMessages(sql)

            const second = await backfillUnifiedInbox(deps(sql))
            expect(second.outbound.scanned).toBe(0)
            expect(second.outbound.inserted).toBe(0)
            expect(second.inbound.scanned).toBe(0)
            expect(await countMessages(sql)).toBe(afterFirst)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('converges to the same row counts when interrupted and restarted', async () => {
        const sql = connect()
        try {
            await seedSentEmails(sql)
            await seedInboundReply(sql)

            // A bounded partial run: one outbound batch of one row, then interrupted.
            await backfillUnifiedInbox(deps(sql, { batchSize: 1, maxBatches: 1 }))
            // A second bounded partial run.
            await backfillUnifiedInbox(deps(sql, { batchSize: 1, maxBatches: 1 }))
            // Then an unbounded run to completion.
            await backfillUnifiedInbox(deps(sql))

            expect(await countMessages(sql)).toBe(4)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('runs outbound before inbound so a historical reply threads onto the outbound conversation', async () => {
        const sql = connect()
        try {
            await seedSentEmails(sql)
            await seedInboundReply(sql)

            await backfillUnifiedInbox(deps(sql))

            // The inbound reply and the S1 outbound share one conversation.
            const conversations = await sql<{ id: string; message_count: string }[]>`
                SELECT c.id, count(m.id)::text AS message_count
                FROM outreach_conversations c
                JOIN outreach_conversation_messages m ON m.conversation_id = c.id
                WHERE c.organization_id = ${ORG_A}::uuid
                GROUP BY c.id
                ORDER BY message_count DESC
            `
            // S1's conversation holds the outbound root + the inbound reply.
            expect(conversations[0].message_count).toBe('2')
            const directions = await sql<{ direction: string }[]>`
                SELECT m.direction
                FROM outreach_conversation_messages m
                WHERE m.conversation_id = ${conversations[0].id}::uuid
                ORDER BY m.direction
            `
            expect(directions.map((d) => d.direction)).toEqual(['inbound', 'outbound'])
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('never resends or mutates outreach emails', async () => {
        const sql = connect()
        try {
            await seedSentEmails(sql)
            const before = await sql<{ n: string; sum: string | null }[]>`
                SELECT count(*)::text AS n, string_agg(status::text, ',' ORDER BY id) AS sum
                FROM outreach_emails WHERE organization_id = ${ORG_A}::uuid
            `
            await backfillUnifiedInbox(deps(sql))
            const after = await sql<{ n: string; sum: string | null }[]>`
                SELECT count(*)::text AS n, string_agg(status::text, ',' ORDER BY id) AS sum
                FROM outreach_emails WHERE organization_id = ${ORG_A}::uuid
            `
            // No new outreach_emails, no status change (no resend).
            expect(after[0].n).toBe(before[0].n)
            expect(after[0].sum).toBe(before[0].sum)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
