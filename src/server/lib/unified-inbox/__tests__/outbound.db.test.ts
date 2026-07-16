/**
 * Outbound materializer suite (Phase 21 UIF-05).
 *
 * Every durably sent `outreach_emails` row becomes exactly ONE outbound
 * `outreach_conversation_messages` record with `source_key = outreach-email:<id>`. The
 * materializer is idempotent (replay + concurrent), excludes not-yet-sent rows, never sends or
 * mutates the email, and creates/reuses the campaign-lead conversation so a later inbound reply
 * that references the outbound Message-ID threads onto the SAME conversation.
 *
 * Shared disposable database: apply every touched migration in beforeAll; clean up own rows in
 * afterAll (materialized provider events keep processed_at NULL and would pollute Phase 19).
 */
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'
import { materializeOutboundEmail } from '../outbound'
import { materializeProviderEvent } from '../ingest'
import type { UnifiedInboxSql } from '../ingest'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

const P = '21032000-0000-4000-8000-0000000000'
const OWNER = `${P}01`
const ORG_A = `${P}02`
const ACCOUNT_A = `${P}11`
const LEAD_A = `${P}21`
const LEAD_MANUAL = `${P}22`
const CAMP_A = `${P}31`
const CL_A = `${P}41`
const OE_SENT = `${P}51`
const OE_QUEUED = `${P}52`
const OE_FAILED = `${P}53`
const OE_MANUAL = `${P}54`
const OE_AGENTIC = `${P}55`
const CL_AGENTIC = `${P}42`
const LEAD_AGENTIC = `${P}23`
const OE_SENT_MESSAGE_ID = 'outbound-root@mail.test'

function connect(max = 2): postgres.Sql {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max, prepare: false, onnotice: () => {} })
}

const NOW = new Date('2026-07-16T12:00:00.000Z')
function outbound(sql: postgres.Sql, id: string) {
    return materializeOutboundEmail(id, { sql: sql as unknown as UnifiedInboxSql, now: () => NOW })
}

async function messageOf(sql: postgres.Sql, id: string) {
    const rows = await sql<{
        conversation_id: string
        direction: string
        provider: string
        source_key: string
        internet_message_id: string | null
        subject: string | null
        from_address: string | null
        plain_body: string | null
        html_body: string | null
        outreach_email_id: string | null
        match_strategy: string | null
        sent_at: Date | null
        received_at: Date | null
    }[]>`SELECT * FROM outreach_conversation_messages WHERE id = ${id}::uuid`
    return rows[0]
}

async function conversationOf(sql: postgres.Sql, id: string) {
    const rows = await sql<{
        organization_id: string
        lead_id: string | null
        campaign_id: string | null
        campaign_lead_id: string | null
        thread_key: string
        last_outbound_at: Date | null
        last_inbound_at: Date | null
        last_message_id: string | null
    }[]>`SELECT * FROM outreach_conversations WHERE id = ${id}::uuid`
    return rows[0]
}

async function countMessages(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM outreach_conversation_messages WHERE organization_id = ${ORG_A}::uuid
    `
    return Number(rows[0].n)
}

async function seedEmails(sql: postgres.Sql): Promise<void> {
    await sql`
        INSERT INTO outreach_emails (
            id, organization_id, origin, idempotency_key, to_address, subject, plain_body, html_body,
            campaign_id, campaign_lead_id, email_account_id, message_id, status, sent_at
        ) VALUES
            (${OE_SENT}::uuid, ${ORG_A}::uuid, 'campaign', 'oe-sent', 'alice@lead.test', 'Intro', 'Hello Alice', '<p>Hello Alice</p>',
             ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, ${OE_SENT_MESSAGE_ID}, 'sent', ${NOW}),
            (${OE_QUEUED}::uuid, ${ORG_A}::uuid, 'campaign', 'oe-queued', 'alice@lead.test', 'Queued', 'Body', null,
             ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, 'queued-root@mail.test', 'queued', null),
            (${OE_FAILED}::uuid, ${ORG_A}::uuid, 'campaign', 'oe-failed', 'alice@lead.test', 'Failed', 'Body', null,
             ${CAMP_A}::uuid, ${CL_A}::uuid, ${ACCOUNT_A}::uuid, 'failed-root@mail.test', 'failed', null),
            (${OE_MANUAL}::uuid, ${ORG_A}::uuid, 'manual', 'oe-manual', 'manual@lead.test', 'Manual note', 'Manual body', null,
             null, null, ${ACCOUNT_A}::uuid, 'manual-root@mail.test', 'sent', ${NOW}),
            (${OE_AGENTIC}::uuid, ${ORG_A}::uuid, 'agentic', 'oe-agentic', 'agentic@lead.test', 'Agentic', 'Agentic body', null,
             ${CAMP_A}::uuid, ${CL_AGENTIC}::uuid, ${ACCOUNT_A}::uuid, 'agentic-root@mail.test', 'sent', ${NOW})
        ON CONFLICT (id) DO NOTHING
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
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'outbound-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG_A}::uuid, 'Outbound A', 'outbound-a', ${OWNER}::uuid) ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'inbox-a@example.test', 'localhost', 'a', 'x', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO leads (id, organization_id, email) VALUES
                (${LEAD_A}::uuid, ${ORG_A}::uuid, 'alice@lead.test'),
                (${LEAD_MANUAL}::uuid, ${ORG_A}::uuid, 'manual@lead.test'),
                (${LEAD_AGENTIC}::uuid, ${ORG_A}::uuid, 'agentic@lead.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`INSERT INTO campaigns (id, organization_id, name) VALUES (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Camp A') ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES
                (${CL_A}::uuid, ${CAMP_A}::uuid, ${LEAD_A}::uuid),
                (${CL_AGENTIC}::uuid, ${CAMP_A}::uuid, ${LEAD_AGENTIC}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
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

beforeEach(async () => {
    await cleanup()
    const sql = connect()
    try {
        await seedEmails(sql)
    } finally {
        await sql.end({ timeout: 1 })
    }
})
afterAll(cleanup)

describe('materializeOutboundEmail', () => {
    it('materializes a durably sent campaign email into one outbound conversation message', async () => {
        const sql = connect()
        try {
            const result = await outbound(sql, OE_SENT)
            expect(result.status).toBe('materialized')
            expect(result.inserted).toBe(true)

            const message = await messageOf(sql, result.conversationMessageId!)
            expect(message.direction).toBe('outbound')
            expect(message.provider).toBe('smtp')
            expect(message.source_key).toBe(`outreach-email:${OE_SENT}`)
            expect(message.internet_message_id).toBe(OE_SENT_MESSAGE_ID)
            expect(message.subject).toBe('Intro')
            expect(message.plain_body).toBe('Hello Alice')
            expect(message.html_body).toBe('<p>Hello Alice</p>')
            expect(message.outreach_email_id).toBe(OE_SENT)
            expect(message.match_strategy).toBe('outbound')
            expect(message.from_address).toBe('inbox-a@example.test')
            expect(message.sent_at).not.toBeNull()
            expect(message.received_at).toBeNull()

            const conversation = await conversationOf(sql, result.conversationId!)
            expect(conversation.lead_id).toBe(LEAD_A)
            expect(conversation.campaign_id).toBe(CAMP_A)
            expect(conversation.campaign_lead_id).toBe(CL_A)
            expect(conversation.thread_key).toBe(`rfc:${OE_SENT_MESSAGE_ID}`)
            expect(conversation.last_outbound_at).not.toBeNull()
            expect(conversation.last_inbound_at).toBeNull()
            expect(conversation.last_message_id).toBe(result.conversationMessageId)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('derives a deterministic source key and dedupes on replay', async () => {
        const sql = connect()
        try {
            const first = await outbound(sql, OE_SENT)
            const second = await outbound(sql, OE_SENT)
            expect(first.inserted).toBe(true)
            expect(second.inserted).toBe(false)
            expect(second.status).toBe('duplicate')
            expect(second.conversationMessageId).toBe(first.conversationMessageId)
            expect(await countMessages(sql)).toBe(1)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('inserts exactly one message under two concurrent materializations', async () => {
        const sql = connect()
        const a = connect()
        const b = connect()
        try {
            const [ra, rb] = await Promise.all([outbound(a, OE_SENT), outbound(b, OE_SENT)])
            expect([ra, rb].filter((r) => r.inserted).length).toBe(1)
            expect(ra.conversationMessageId).toBe(rb.conversationMessageId)
            expect(await countMessages(sql)).toBe(1)
        } finally {
            await sql.end({ timeout: 1 })
            await a.end({ timeout: 1 })
            await b.end({ timeout: 1 })
        }
    })

    it('excludes queued and failed sends', async () => {
        const sql = connect()
        try {
            const queued = await outbound(sql, OE_QUEUED)
            const failed = await outbound(sql, OE_FAILED)
            expect(queued.status).toBe('skipped')
            expect(queued.inserted).toBe(false)
            expect(failed.status).toBe('skipped')
            expect(failed.inserted).toBe(false)
            expect(await countMessages(sql)).toBe(0)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('materializes manual and agentic sends, resolving the lead for a manual send by recipient', async () => {
        const sql = connect()
        try {
            const manual = await outbound(sql, OE_MANUAL)
            expect(manual.inserted).toBe(true)
            const manualConversation = await conversationOf(sql, manual.conversationId!)
            expect(manualConversation.lead_id).toBe(LEAD_MANUAL)
            expect(manualConversation.campaign_id).toBeNull()

            const agentic = await outbound(sql, OE_AGENTIC)
            expect(agentic.inserted).toBe(true)
            const agenticConversation = await conversationOf(sql, agentic.conversationId!)
            expect(agenticConversation.campaign_lead_id).toBe(CL_AGENTIC)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('never mutates the outreach_emails row it materializes', async () => {
        const sql = connect()
        try {
            const before = await sql<{ status: string; sent_at: Date | null; updated_at: Date }[]>`
                SELECT status, sent_at, updated_at FROM outreach_emails WHERE id = ${OE_SENT}::uuid
            `
            await outbound(sql, OE_SENT)
            const after = await sql<{ status: string; sent_at: Date | null; updated_at: Date }[]>`
                SELECT status, sent_at, updated_at FROM outreach_emails WHERE id = ${OE_SENT}::uuid
            `
            expect(after[0].status).toBe(before[0].status)
            expect(after[0].sent_at?.getTime()).toBe(before[0].sent_at?.getTime())
            expect(after[0].updated_at.getTime()).toBe(before[0].updated_at.getTime())
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('threads a later inbound reply onto the same outbound conversation', async () => {
        const sql = connect()
        try {
            const out = await outbound(sql, OE_SENT)

            // An inbound reply that references the outbound Message-ID.
            const eventRows = await sql<{ id: string }[]>`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id,
                    message_id, in_reply_to, classification, from_address, to_addresses,
                    subject, text_body, received_at
                ) VALUES (
                    ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', 'reply-to-outbound',
                    '<reply-1@lead.test>', ${`<${OE_SENT_MESSAGE_ID}>`}, 'reply', 'alice@lead.test',
                    ${JSON.stringify(['inbox-a@example.test'])}::jsonb, 'Re: Intro', 'Yes, interested.', ${NOW}
                )
                RETURNING id
            `
            const inbound = await materializeProviderEvent(eventRows[0].id, {
                sql: sql as unknown as UnifiedInboxSql,
                now: () => NOW,
            })

            expect(inbound.conversationId).toBe(out.conversationId)
            expect(inbound.attribution.leadId).toBe(LEAD_A)
            expect(inbound.attribution.campaignId).toBe(CAMP_A)

            const conversation = await conversationOf(sql, out.conversationId!)
            expect(conversation.last_inbound_at).not.toBeNull()
            expect(conversation.last_outbound_at).not.toBeNull()
            expect(await countMessages(sql)).toBe(2)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
