import path from 'node:path'
import postgres from 'postgres'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'
import { materializeProviderEvent, type UnifiedInboxSql } from '../ingest'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
// The materializer reads outreach_emails (038 dispatch columns), consumes the Phase 19
// staging table (039), and writes the Phase 21 conversation tables + materialization
// lifecycle (041). Each .db suite applies every migration its own rows touch, in order.
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

// Distinct id space so this suite's rows never collide with sibling .db suites on the
// shared disposable database.
const P = '21020000-0000-4000-8000-0000000000'
const OWNER = `${P}01`
const ORG_A = `${P}02`
const ORG_B = `${P}03`
const ACCOUNT_A = `${P}11`
const ACCOUNT_A2 = `${P}12`
const ACCOUNT_B = `${P}13`
const LEAD_A1 = `${P}21`
const LEAD_A_DUP1 = `${P}22`
const LEAD_A_DUP2 = `${P}23`
const LEAD_A_MULTI = `${P}24`
const LEAD_B1 = `${P}25`
const CAMP_A = `${P}31`
const CAMP_A2 = `${P}32`
const CAMP_B = `${P}33`
const CL_A1 = `${P}41`
const CL_A_DUP1 = `${P}42`
const CL_A_DUP2 = `${P}43`
const CL_A_MULTI_A = `${P}44`
const CL_A_MULTI_A2 = `${P}45`
const CL_B1 = `${P}46`
const OE_A1 = `${P}51`
const OE_A_DUP1 = `${P}52`
const OE_A_DUP2 = `${P}53`
const OE_A_MULTI_A = `${P}54`
const OE_A_MULTI_A2 = `${P}55`
const OE_B1 = `${P}56`

// OE_A1's Message-ID is deliberately mixed-case to prove header matching is case-insensitive.
const OE_A1_MESSAGE_ID = 'Thread-A1-Root@Mail.test'

function connect(max = 2): postgres.Sql {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max, prepare: false, onnotice: () => {} })
}

async function materialize(sql: postgres.Sql, eventId: string) {
    return materializeProviderEvent(eventId, {
        sql: sql as unknown as UnifiedInboxSql,
        now: () => new Date('2026-07-16T12:00:00Z'),
    })
}

interface EventOverrides {
    id?: string
    organizationId?: string
    emailAccountId?: string
    provider?: string
    providerMessageId: string
    classification?: string
    messageId?: string | null
    inReplyTo?: string | null
    references?: string | null
    fromAddress?: string | null
    toAddresses?: string[]
    subject?: string | null
    textBody?: string | null
    htmlBody?: string | null
    attachments?: unknown[]
    headers?: Record<string, string>
    processedAt?: boolean
}

async function insertEvent(sql: postgres.Sql, o: EventOverrides): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO outreach_provider_events (
            id, organization_id, email_account_id, provider, provider_message_id,
            classification, message_id, in_reply_to, message_references, from_address,
            to_addresses, subject, text_body, html_body, headers, attachments,
            received_at, processed_at
        ) VALUES (
            COALESCE(${o.id ?? null}::uuid, gen_random_uuid()),
            ${o.organizationId ?? ORG_A}::uuid, ${o.emailAccountId ?? ACCOUNT_A}::uuid,
            ${o.provider ?? 'native'}, ${o.providerMessageId},
            ${o.classification ?? 'reply'}, ${o.messageId ?? null}, ${o.inReplyTo ?? null},
            ${o.references ?? null}, ${o.fromAddress ?? null},
            ${JSON.stringify(o.toAddresses ?? [])}::jsonb, ${o.subject ?? null},
            ${o.textBody ?? null}, ${o.htmlBody ?? null},
            ${JSON.stringify(o.headers ?? {})}::jsonb, ${JSON.stringify(o.attachments ?? [])}::jsonb,
            now(), ${o.processedAt ? sql`now()` : null}
        )
        RETURNING id
    `
    return rows[0].id
}

async function conversationOf(sql: postgres.Sql, conversationId: string) {
    const rows = await sql<{
        organization_id: string
        email_account_id: string
        lead_id: string | null
        campaign_id: string | null
        campaign_lead_id: string | null
        thread_key: string
        last_message_id: string | null
        last_inbound_at: Date | null
        latest_message_preview: string | null
    }[]>`SELECT * FROM outreach_conversations WHERE id = ${conversationId}::uuid`
    return rows[0]
}

async function messageOf(sql: postgres.Sql, messageId: string) {
    const rows = await sql<{
        organization_id: string
        conversation_id: string
        classification: string
        match_strategy: string | null
        match_confidence: string | null
        plain_body: string | null
        html_body: string | null
        has_attachments: boolean
        source_key: string
        outreach_email_id: string | null
    }[]>`SELECT * FROM outreach_conversation_messages WHERE id = ${messageId}::uuid`
    return rows[0]
}

async function countMessages(sql: postgres.Sql, org = ORG_A): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM outreach_conversation_messages WHERE organization_id = ${org}::uuid
    `
    return Number(rows[0].n)
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    const sql = connect()
    try {
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'ingest-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO organizations (id, name, slug, owner_id) VALUES
                (${ORG_A}::uuid, 'Ingest A', 'ingest-a', ${OWNER}::uuid),
                (${ORG_B}::uuid, 'Ingest B', 'ingest-b', ${OWNER}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status) VALUES
                (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'inbox-a@example.test', 'localhost', 'a', 'x', 'verified'),
                (${ACCOUNT_A2}::uuid, ${ORG_A}::uuid, 'inbox-a2@example.test', 'localhost', 'a2', 'x', 'verified'),
                (${ACCOUNT_B}::uuid, ${ORG_B}::uuid, 'inbox-b@example.test', 'localhost', 'b', 'x', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO leads (id, organization_id, email) VALUES
                (${LEAD_A1}::uuid, ${ORG_A}::uuid, 'alice@lead.test'),
                (${LEAD_A_DUP1}::uuid, ${ORG_A}::uuid, 'dup@lead.test'),
                (${LEAD_A_DUP2}::uuid, ${ORG_A}::uuid, 'dup@lead.test'),
                (${LEAD_A_MULTI}::uuid, ${ORG_A}::uuid, 'multi@lead.test'),
                (${LEAD_B1}::uuid, ${ORG_B}::uuid, 'alice@lead.test')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO campaigns (id, organization_id, name) VALUES
                (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Camp A'),
                (${CAMP_A2}::uuid, ${ORG_A}::uuid, 'Camp A2'),
                (${CAMP_B}::uuid, ${ORG_B}::uuid, 'Camp B')
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES
                (${CL_A1}::uuid, ${CAMP_A}::uuid, ${LEAD_A1}::uuid),
                (${CL_A_DUP1}::uuid, ${CAMP_A}::uuid, ${LEAD_A_DUP1}::uuid),
                (${CL_A_DUP2}::uuid, ${CAMP_A}::uuid, ${LEAD_A_DUP2}::uuid),
                (${CL_A_MULTI_A}::uuid, ${CAMP_A}::uuid, ${LEAD_A_MULTI}::uuid),
                (${CL_A_MULTI_A2}::uuid, ${CAMP_A2}::uuid, ${LEAD_A_MULTI}::uuid),
                (${CL_B1}::uuid, ${CAMP_B}::uuid, ${LEAD_B1}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        // Agentic origin lets these carry campaign+lead linkage without a sequence step
        // (038 origin_shape_check), so the seed needs no sequences/steps.
        await sql`
            INSERT INTO outreach_emails (
                id, organization_id, origin, idempotency_key, to_address,
                campaign_id, campaign_lead_id, email_account_id, message_id, status, sent_at
            ) VALUES
                (${OE_A1}::uuid, ${ORG_A}::uuid, 'agentic', 'oe-a1', 'alice@lead.test',
                 ${CAMP_A}::uuid, ${CL_A1}::uuid, ${ACCOUNT_A}::uuid, ${OE_A1_MESSAGE_ID}, 'sent', now()),
                (${OE_A_DUP1}::uuid, ${ORG_A}::uuid, 'agentic', 'oe-dup1', 'dup@lead.test',
                 ${CAMP_A}::uuid, ${CL_A_DUP1}::uuid, ${ACCOUNT_A}::uuid, 'dup1@mail.test', 'sent', now()),
                (${OE_A_DUP2}::uuid, ${ORG_A}::uuid, 'agentic', 'oe-dup2', 'dup@lead.test',
                 ${CAMP_A}::uuid, ${CL_A_DUP2}::uuid, ${ACCOUNT_A}::uuid, 'dup2@mail.test', 'sent', now()),
                (${OE_A_MULTI_A}::uuid, ${ORG_A}::uuid, 'agentic', 'oe-multi-a', 'multi@lead.test',
                 ${CAMP_A}::uuid, ${CL_A_MULTI_A}::uuid, ${ACCOUNT_A}::uuid, 'multiA@mail.test', 'sent', now()),
                (${OE_A_MULTI_A2}::uuid, ${ORG_A}::uuid, 'agentic', 'oe-multi-a2', 'multi@lead.test',
                 ${CAMP_A2}::uuid, ${CL_A_MULTI_A2}::uuid, ${ACCOUNT_A2}::uuid, 'multiA2@mail.test', 'sent', now()),
                (${OE_B1}::uuid, ${ORG_B}::uuid, 'agentic', 'oe-b1', 'alice@lead.test',
                 ${CAMP_B}::uuid, ${CL_B1}::uuid, ${ACCOUNT_B}::uuid, 'thread-b1-root@mail.test', 'sent', now())
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }
})

beforeEach(async () => {
    const sql = connect()
    try {
        await sql`DELETE FROM outreach_provider_events WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
        await sql`DELETE FROM outreach_conversations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    } finally {
        await sql.end({ timeout: 1 })
    }
})

describe('materializeProviderEvent — header attribution', () => {
    it('threads an In-Reply-To reply onto its outreach email, case-insensitively, storing the full body', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-reply-1',
                inReplyTo: '<thread-a1-root@mail.test>',
                messageId: '<reply-1@lead.test>',
                fromAddress: 'alice@lead.test',
                toAddresses: ['inbox-a@example.test'],
                subject: 'Re: Hello',
                textBody: 'Yes I am interested, please send more.',
                htmlBody: '<p>Yes I am interested, please send more.</p>',
                attachments: [{ filename: 'brochure.pdf', contentType: 'application/pdf', size: 1024 }],
            })

            const result = await materialize(sql, eventId)
            expect(result.status).toBe('materialized')
            expect(result.inserted).toBe(true)
            expect(result.attribution.matchStrategy).toBe('in_reply_to')
            expect(result.attribution.matchConfidence).toBe('high')
            expect(result.attribution.leadId).toBe(LEAD_A1)
            expect(result.attribution.campaignId).toBe(CAMP_A)
            expect(result.attribution.campaignLeadId).toBe(CL_A1)
            expect(result.attribution.outreachEmailId).toBe(OE_A1)

            const message = await messageOf(sql, result.conversationMessageId!)
            expect(message.plain_body).toContain('interested')
            expect(message.has_attachments).toBe(true)
            expect(message.match_strategy).toBe('in_reply_to')
            expect(message.outreach_email_id).toBe(OE_A1)

            const conversation = await conversationOf(sql, result.conversationId!)
            expect(conversation.organization_id).toBe(ORG_A)
            expect(conversation.lead_id).toBe(LEAD_A1)
            expect(conversation.thread_key).toBe('rfc:thread-a1-root@mail.test')
            expect(conversation.last_message_id).toBe(result.conversationMessageId)
            expect(conversation.last_inbound_at).not.toBeNull()
            expect(conversation.latest_message_preview).toContain('interested')

            // The claimed event is flipped to materialized and linked to the message.
            const events = await sql<{ materialization_status: string; materialized_at: Date | null; conversation_message_id: string | null }[]>`
                SELECT materialization_status, materialized_at, conversation_message_id
                FROM outreach_provider_events WHERE id = ${eventId}::uuid
            `
            expect(events[0].materialization_status).toBe('materialized')
            expect(events[0].materialized_at).not.toBeNull()
            expect(events[0].conversation_message_id).toBe(result.conversationMessageId)

            // Participants recorded for from + to.
            const participants = await sql<{ address: string; role: string }[]>`
                SELECT address, role FROM outreach_conversation_participants
                WHERE conversation_id = ${result.conversationId}::uuid ORDER BY role
            `
            expect(participants).toEqual(
                expect.arrayContaining([
                    { address: 'alice@lead.test', role: 'from' },
                    { address: 'inbox-a@example.test', role: 'to' },
                ]),
            )
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('threads a multi-token References reply onto the reference root', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-reply-refs',
                references: '<thread-a1-root@mail.test> <intermediate@lead.test>',
                messageId: '<reply-refs@lead.test>',
                fromAddress: 'alice@lead.test',
                textBody: 'Following up on the thread.',
            })
            const result = await materialize(sql, eventId)
            expect(result.attribution.matchStrategy).toBe('references')
            expect(result.attribution.outreachEmailId).toBe(OE_A1)
            const conversation = await conversationOf(sql, result.conversationId!)
            expect(conversation.thread_key).toBe('rfc:thread-a1-root@mail.test')
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('materializeProviderEvent — idempotency', () => {
    it('replaying the same event yields the same message and no duplicate side effect', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-dup',
                inReplyTo: '<thread-a1-root@mail.test>',
                fromAddress: 'alice@lead.test',
                textBody: 'first and only body',
            })
            const first = await materialize(sql, eventId)
            expect(first.inserted).toBe(true)
            const second = await materialize(sql, eventId)
            expect(second.inserted).toBe(false)
            expect(second.status).toBe('duplicate')
            expect(second.conversationMessageId).toBe(first.conversationMessageId)
            expect(await countMessages(sql)).toBe(1)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('two concurrent materializations of one event insert exactly one message', async () => {
        const sql = connect()
        const a = connect()
        const b = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-concurrent',
                inReplyTo: '<thread-a1-root@mail.test>',
                fromAddress: 'alice@lead.test',
                textBody: 'concurrent body',
            })
            const [ra, rb] = await Promise.all([materialize(a, eventId), materialize(b, eventId)])
            const insertedCount = [ra, rb].filter((r) => r.inserted).length
            expect(insertedCount).toBe(1)
            expect(await countMessages(sql)).toBe(1)
            expect(ra.conversationMessageId).toBe(rb.conversationMessageId)
        } finally {
            await sql.end({ timeout: 1 })
            await a.end({ timeout: 1 })
            await b.end({ timeout: 1 })
        }
    })

    it('is independent of the Phase 19 processed_at classification lifecycle', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-processed',
                inReplyTo: '<thread-a1-root@mail.test>',
                fromAddress: 'alice@lead.test',
                textBody: 'already classified',
                processedAt: true,
            })
            const result = await materialize(sql, eventId)
            expect(result.status).toBe('materialized')
            // processed_at is untouched by materialization.
            const rows = await sql<{ processed_at: Date | null; materialization_status: string }[]>`
                SELECT processed_at, materialization_status FROM outreach_provider_events WHERE id = ${eventId}::uuid
            `
            expect(rows[0].processed_at).not.toBeNull()
            expect(rows[0].materialization_status).toBe('materialized')
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('materializeProviderEvent — address heuristic and tenant safety', () => {
    it('attributes a header-less reply by recent outbound to a single lead (low confidence)', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-heuristic',
                fromAddress: 'multi@lead.test',
                emailAccountId: ACCOUNT_A,
                textBody: 'no headers here',
            })
            const result = await materialize(sql, eventId)
            expect(result.attribution.matchStrategy).toBe('address_heuristic')
            expect(result.attribution.matchConfidence).toBe('low')
            expect(result.attribution.leadId).toBe(LEAD_A_MULTI)
            expect(result.attribution.campaignId).toBe(CAMP_A)
            const conversation = await conversationOf(sql, result.conversationId!)
            expect(conversation.thread_key).toBe(`lead:${LEAD_A_MULTI}`)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('scopes the address heuristic to the receiving account', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-heuristic-a2',
                fromAddress: 'multi@lead.test',
                emailAccountId: ACCOUNT_A2,
                textBody: 'to the second account',
            })
            const result = await materialize(sql, eventId)
            expect(result.attribution.campaignId).toBe(CAMP_A2)
            expect(result.attribution.campaignLeadId).toBe(CL_A_MULTI_A2)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('leaves an ambiguous address (two leads, same email) unattributed', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-ambiguous',
                fromAddress: 'dup@lead.test',
                emailAccountId: ACCOUNT_A,
                textBody: 'which lead am I?',
            })
            const result = await materialize(sql, eventId)
            expect(result.attribution.matchStrategy).toBe('none')
            expect(result.attribution.leadId).toBeNull()
            expect(result.attribution.campaignId).toBeNull()
            const conversation = await conversationOf(sql, result.conversationId!)
            expect(conversation.thread_key.startsWith('gen:')).toBe(true)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('never attributes across organizations for a shared lead email', async () => {
        const sql = connect()
        try {
            // alice@lead.test exists in BOTH org A (LEAD_A1) and org B (LEAD_B1). An event on
            // account A must only ever resolve org A's lead.
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-crossorg',
                fromAddress: 'alice@lead.test',
                emailAccountId: ACCOUNT_A,
                textBody: 'cross-org guard',
            })
            const result = await materialize(sql, eventId)
            expect(result.attribution.leadId).toBe(LEAD_A1)
            const conversation = await conversationOf(sql, result.conversationId!)
            expect(conversation.organization_id).toBe(ORG_A)
            // Nothing was written under org B.
            expect(await countMessages(sql, ORG_B)).toBe(0)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('materializeProviderEvent — classification passthrough', () => {
    it('preserves an auto-reply classification without any reply side effect', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-auto',
                classification: 'auto_reply',
                inReplyTo: '<thread-a1-root@mail.test>',
                fromAddress: 'alice@lead.test',
                subject: 'Automatic reply: Out of office',
                textBody: 'I am away until Monday.',
            })
            const result = await materialize(sql, eventId)
            expect(result.classification).toBe('auto_reply')
            const message = await messageOf(sql, result.conversationMessageId!)
            expect(message.classification).toBe('auto_reply')
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('preserves a bounce/DSN classification', async () => {
        const sql = connect()
        try {
            const eventId = await insertEvent(sql, {
                providerMessageId: 'native-dsn',
                classification: 'bounce',
                inReplyTo: '<thread-a1-root@mail.test>',
                fromAddress: 'mailer-daemon@lead.test',
                subject: 'Undeliverable',
                textBody: 'Delivery failed permanently.',
            })
            const result = await materialize(sql, eventId)
            expect(result.classification).toBe('bounce')
            const message = await messageOf(sql, result.conversationMessageId!)
            expect(message.classification).toBe('bounce')
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
