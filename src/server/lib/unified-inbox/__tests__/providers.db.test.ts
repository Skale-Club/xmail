/**
 * Provider field-parity and cursor-recovery suite (Phase 21 UIF-02/UIF-03).
 *
 * The three provider adapters (native mail row, raw IMAP MIME, Microsoft Graph delta message)
 * must map onto the SAME provider-neutral normalized shape, so that once staged and
 * materialized their conversation messages are equivalent at the materializer boundary:
 * identical RFC threading fields, addresses, subject, attachment METADATA (never bytes), and
 * safe-header key set. Only the provider-native source identity is expected to differ.
 *
 * It also pins the recovery contract that Phase 19 owns and Phase 21 depends on: an IMAP
 * UIDVALIDITY reset restarts from the beginning, provider ids are stable across a UID reset /
 * folder move when an internet Message-ID exists, and staging never advances the cursor past a
 * message it failed to persist.
 *
 * Shared disposable database rules: apply every migration this suite's rows touch in beforeAll
 * (idempotent under the shared advisory lock) and clean up its own rows in afterAll (materialized
 * events keep processed_at NULL by design and would otherwise pollute Phase 19's org-wide queues).
 */
import path from 'node:path'
import postgres from 'postgres'
import { simpleParser } from 'mailparser'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'
import { materializeProviderEvent, type UnifiedInboxSql } from '../ingest'
import { nativeEventFromMailRow } from '../providers/native'
import { imapEventFromParsedMail } from '../providers/imap'
import { outlookEventFromGraphMessage } from '../providers/outlook'
import type { OutlookGraphMessage } from '../../outlook'
import {
    graphProviderMessageId,
    imapProviderMessageId,
    ingestInboundPage,
    resolveImapCursor,
    type InboundEventStore,
    type InboundSource,
    type NormalizedInboundMessage,
} from '../../outreach-inbound'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

const P = '21030000-0000-4000-8000-0000000000'
const OWNER = `${P}01`
const ORG_A = `${P}02`
const ACCOUNT_A = `${P}11`
const NATIVE_MSG = `${P}21`

// The one logical inbound reply, arriving via three providers. Threading + addresses + subject
// are IDENTICAL by construction; each provider only differs in its source identity + body form.
const MESSAGE_ID = '<reply-parity@lead.test>'
const IN_REPLY_TO = '<thread-parity-root@mail.test>'
const REFERENCES = '<thread-parity-root@mail.test>'
const FROM = 'parity@lead.test'
const TO = 'inbox-a@example.test'
const SUBJECT = 'Re: Parity check'
const RECEIVED = new Date('2026-07-16T12:00:00.000Z')

const SHARED_HEADER_KEYS = ['subject', 'date', 'message-id', 'in-reply-to', 'references', 'from', 'to', 'content-type']

function connect(max = 2): postgres.Sql {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max, prepare: false, onnotice: () => {} })
}

function nativeInput(): NormalizedInboundMessage {
    return nativeEventFromMailRow({
        id: NATIVE_MSG,
        messageId: MESSAGE_ID,
        inReplyTo: IN_REPLY_TO,
        references: REFERENCES,
        fromAddress: FROM,
        toAddresses: [TO],
        ccAddresses: [],
        subject: SUBJECT,
        plainBody: 'Native plain body.',
        htmlBody: '<p>Native plain body.</p>',
        headers: {
            subject: SUBJECT,
            date: 'Thu, 16 Jul 2026 12:00:00 +0000',
            'message-id': MESSAGE_ID,
            'in-reply-to': IN_REPLY_TO,
            references: REFERENCES,
            from: FROM,
            to: TO,
            'content-type': 'multipart/alternative',
        },
        attachments: [
            { id: 'native-att-1', filename: 'brochure.pdf', contentType: 'application/pdf', size: 2048, contentDisposition: 'attachment', cid: null },
            { id: 'native-att-2', filename: 'logo.png', contentType: 'image/png', size: 512, contentDisposition: 'inline', cid: 'logo@x' },
        ],
        receivedAt: RECEIVED,
        createdAt: RECEIVED,
    })
}

const IMAP_RAW = [
    `From: Parity Lead <${FROM}>`,
    `To: ${TO}`,
    `Subject: ${SUBJECT}`,
    `Message-ID: ${MESSAGE_ID}`,
    `In-Reply-To: ${IN_REPLY_TO}`,
    `References: ${REFERENCES}`,
    'Date: Thu, 16 Jul 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'IMAP plain body.',
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>IMAP plain body.</p>',
    '--ALT--',
    '--MIX',
    'Content-Type: application/pdf; name="brochure.pdf"',
    'Content-Disposition: attachment; filename="brochure.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake brochure bytes that must never reach postgres').toString('base64'),
    '--MIX',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo@x>',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PNG fake inline bytes').toString('base64'),
    '--MIX--',
    '',
].join('\r\n')

async function imapInput(): Promise<NormalizedInboundMessage> {
    const parsed = await simpleParser(IMAP_RAW)
    return imapEventFromParsedMail(parsed, 42, 900)
}

function graphMessage(): OutlookGraphMessage {
    return {
        id: 'AAMk-graph-parity',
        internetMessageId: MESSAGE_ID,
        internetMessageHeaders: [
            { name: 'Subject', value: SUBJECT },
            { name: 'Date', value: 'Thu, 16 Jul 2026 12:00:00 +0000' },
            { name: 'Message-ID', value: MESSAGE_ID },
            { name: 'In-Reply-To', value: IN_REPLY_TO },
            { name: 'References', value: REFERENCES },
            { name: 'From', value: FROM },
            { name: 'To', value: TO },
            { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        ],
        from: { emailAddress: { address: FROM, name: 'Parity Lead' } },
        toRecipients: [{ emailAddress: { address: TO } }],
        ccRecipients: [],
        subject: SUBJECT,
        body: { contentType: 'html', content: '<p>Graph body.</p>' },
        bodyPreview: 'Graph body.',
        receivedDateTime: RECEIVED.toISOString(),
        hasAttachments: true,
        isDraft: false,
        attachments: [
            { id: 'graph-att-1', name: 'brochure.pdf', contentType: 'application/pdf', size: 2048, isInline: false, contentId: null },
            { id: 'graph-att-2', name: 'logo.png', contentType: 'image/png', size: 512, isInline: true, contentId: 'logo@x' },
        ],
    }
}

async function stageEvent(sql: postgres.Sql, message: NormalizedInboundMessage): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO outreach_provider_events (
            organization_id, email_account_id, provider, provider_message_id,
            message_id, in_reply_to, message_references, classification, from_address,
            to_addresses, cc_addresses, subject, text_body, html_body, headers, attachments, received_at
        ) VALUES (
            ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, ${message.provider}, ${message.providerMessageId},
            ${message.messageId}, ${message.inReplyTo}, ${message.references}, 'reply', ${message.fromAddress},
            ${JSON.stringify(message.toAddresses)}::jsonb, ${JSON.stringify(message.ccAddresses)}::jsonb,
            ${message.subject}, ${message.textBody}, ${message.htmlBody},
            ${JSON.stringify(message.headers)}::jsonb, ${JSON.stringify(message.attachments)}::jsonb, ${message.receivedAt}
        )
        RETURNING id
    `
    return rows[0].id
}

interface MessageRow {
    id: string
    conversation_id: string
    direction: string
    provider: string
    source_key: string
    internet_message_id: string | null
    in_reply_to: string | null
    message_references: string | null
    subject: string | null
    from_address: string | null
    plain_body: string | null
    html_body: string | null
    headers: Record<string, string>
    attachments: Array<Record<string, unknown>>
    has_attachments: boolean
}

// Depending on the connection's type parsers, postgres-js may hand back jsonb columns as
// already-parsed values OR as raw strings; normalize both so assertions are parser-agnostic.
function asObject(value: unknown): Record<string, string> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string>
    if (typeof value === 'string') return JSON.parse(value)
    return {}
}
function asArray(value: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(value)) return value as Array<Record<string, unknown>>
    if (typeof value === 'string') return JSON.parse(value)
    return []
}

async function messageOf(sql: postgres.Sql, id: string): Promise<MessageRow> {
    const rows = await sql<MessageRow[]>`
        SELECT id, conversation_id, direction, provider, source_key, internet_message_id,
               in_reply_to, message_references, subject, from_address,
               plain_body, html_body, headers, attachments, has_attachments
        FROM outreach_conversation_messages WHERE id = ${id}::uuid
    `
    const row = rows[0]
    return { ...row, headers: asObject(row.headers), attachments: asArray(row.attachments) }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    const sql = connect()
    try {
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'parity-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES (${ORG_A}::uuid, 'Parity A', 'parity-a', ${OWNER}::uuid) ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'inbox-a@example.test', 'localhost', 'a', 'x', 'verified')
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
    } finally {
        await sql.end({ timeout: 1 })
    }
}

beforeEach(cleanup)
afterAll(cleanup)

describe('provider field parity at the materializer boundary', () => {
    it('maps native, IMAP, and Graph onto equivalent normalized message fields', async () => {
        const sql = connect()
        try {
            const nativeMsg = nativeInput()
            const imapMsg = await imapInput()
            const graphMsg = outlookEventFromGraphMessage(graphMessage())
            expect(graphMsg).not.toBeNull()

            const nativeId = await materializeProviderEvent(await stageEvent(sql, nativeMsg), {
                sql: sql as unknown as UnifiedInboxSql,
                now: () => RECEIVED,
            })
            const imapId = await materializeProviderEvent(await stageEvent(sql, imapMsg), {
                sql: sql as unknown as UnifiedInboxSql,
                now: () => RECEIVED,
            })
            const graphId = await materializeProviderEvent(await stageEvent(sql, graphMsg!), {
                sql: sql as unknown as UnifiedInboxSql,
                now: () => RECEIVED,
            })

            const native = await messageOf(sql, nativeId.conversationMessageId!)
            const imap = await messageOf(sql, imapId.conversationMessageId!)
            const graph = await messageOf(sql, graphId.conversationMessageId!)

            // Each provider tags direction + its own provider column.
            expect([native.direction, imap.direction, graph.direction]).toEqual(['inbound', 'inbound', 'inbound'])
            expect(native.provider).toBe('native')
            expect(imap.provider).toBe('smtp')
            expect(graph.provider).toBe('outlook')

            // Source identity is provider-specific by design.
            expect(native.source_key.startsWith('native:')).toBe(true)
            expect(imap.source_key.startsWith('smtp:')).toBe(true)
            expect(graph.source_key.startsWith('outlook:')).toBe(true)

            // RFC threading fields are identical (bracket-stripped) so all three converge.
            for (const message of [native, imap, graph]) {
                expect(message.internet_message_id).toBe('reply-parity@lead.test')
                expect(message.in_reply_to).toBe('thread-parity-root@mail.test')
                expect(message.message_references).toBe('thread-parity-root@mail.test')
                expect(message.subject).toBe(SUBJECT)
                expect(message.from_address).toBe(FROM)
                expect(message.has_attachments).toBe(true)
            }

            // Same conversation for all three: identical reference root threads them together.
            expect(new Set([native.conversation_id, imap.conversation_id, graph.conversation_id]).size).toBe(1)

            // Safe headers: every provider retains the shared header keys.
            for (const message of [native, imap, graph]) {
                for (const key of SHARED_HEADER_KEYS) {
                    expect(Object.keys(message.headers)).toContain(key)
                }
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('stores attachment metadata only, never binary content, for every provider', async () => {
        const sql = connect()
        try {
            const allowedKeys = new Set(['providerId', 'name', 'mimeType', 'size', 'inline', 'contentId'])

            for (const message of [nativeInput(), await imapInput(), outlookEventFromGraphMessage(graphMessage())!]) {
                const result = await materializeProviderEvent(await stageEvent(sql, message), {
                    sql: sql as unknown as UnifiedInboxSql,
                    now: () => RECEIVED,
                })
                const persisted = await messageOf(sql, result.conversationMessageId!)
                expect(persisted.attachments.length).toBe(2)

                for (const attachment of persisted.attachments) {
                    // No key outside the metadata descriptor: no content/bytes/data leak.
                    for (const key of Object.keys(attachment)) {
                        expect(allowedKeys.has(key)).toBe(true)
                    }
                }
                // The base64 body bytes never appear anywhere in the stored attachment JSON.
                const serialized = JSON.stringify(persisted.attachments)
                expect(serialized).not.toContain('fake brochure')
                expect(serialized).not.toContain('PDF-1.4')

                const brochure = persisted.attachments.find((a) => a.name === 'brochure.pdf')
                const logo = persisted.attachments.find((a) => a.name === 'logo.png')
                // Size is provider-derived (IMAP re-derives real decoded bytes), so assert the
                // descriptor shape rather than a cross-provider-identical byte count.
                expect(brochure).toMatchObject({ mimeType: 'application/pdf', inline: false })
                expect(Number(brochure!.size)).toBeGreaterThan(0)
                expect(logo).toMatchObject({ mimeType: 'image/png', inline: true, contentId: 'logo@x' })

                // Events first (clears the composite event->message link so its ON DELETE SET
                // NULL cannot null organization_id), then the conversation (cascades to messages).
                await sql`DELETE FROM outreach_provider_events WHERE organization_id = ${ORG_A}::uuid`
                await sql`DELETE FROM outreach_conversations WHERE organization_id = ${ORG_A}::uuid`
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})

describe('provider cursor recovery is bounded and lossless', () => {
    it('restarts IMAP from the beginning of the mailbox on a UIDVALIDITY reset', () => {
        // Same validity: resume from the stored high-water mark.
        expect(resolveImapCursor(
            { deltaCursor: null, uidValidity: 900, lastUid: 5, lastReceivedAt: null, lastProviderMessageId: null },
            900,
        )).toEqual({ startUid: 5, reset: false, uidValidity: 900 })

        // Changed validity: restart at 0 and flag the reset for the operator signal.
        expect(resolveImapCursor(
            { deltaCursor: null, uidValidity: 900, lastUid: 5, lastReceivedAt: null, lastProviderMessageId: null },
            901,
        )).toEqual({ startUid: 0, reset: true, uidValidity: 901 })
    })

    it('keeps IMAP and Graph source ids stable across a UID reset and a folder move', () => {
        // The internet Message-ID survives a UIDVALIDITY renumber; the id must not change.
        expect(imapProviderMessageId({ messageId: '<m@x>', uidValidity: 900, uid: 5 }))
            .toBe(imapProviderMessageId({ messageId: '<m@x>', uidValidity: 901, uid: 99 }))
        // ...and a Graph folder move mints a new Graph id but the same source key.
        expect(graphProviderMessageId({ messageId: '<m@x>', graphId: 'AAMk-1' }))
            .toBe(graphProviderMessageId({ messageId: '<m@x>', graphId: 'AAMk-2-moved' }))
    })

    it('never advances the ingestion cursor past a message it failed to stage', async () => {
        let cursorSaved = false
        const store: InboundEventStore = {
            recordEvent: async (input) => {
                if (input.providerMessageId === 'poison') throw new Error('staging failed')
                return { inserted: true }
            },
            loadCursor: async () => null,
            saveCursor: async () => { cursorSaved = true },
            withNextPendingEvent: async () => ({ status: 'idle' }),
        }
        const base = {
            provider: 'native' as const,
            messageId: null,
            inReplyTo: null,
            references: null,
            fromAddress: 'x@lead.test',
            toAddresses: [] as string[],
            ccAddresses: [] as string[],
            subject: null,
            textBody: 'x',
            htmlBody: null,
            headers: {},
            attachments: [],
            receivedAt: RECEIVED,
        }
        const source: InboundSource = {
            provider: 'native',
            async fetchPage() {
                return {
                    messages: [
                        { ...base, providerMessageId: 'ok' },
                        { ...base, providerMessageId: 'poison' },
                    ],
                    nextCursor: { deltaCursor: null, uidValidity: null, lastUid: null, lastReceivedAt: RECEIVED, lastProviderMessageId: 'poison' },
                }
            },
        }

        await expect(ingestInboundPage({
            store,
            source,
            account: { id: ACCOUNT_A, organizationId: ORG_A },
        })).rejects.toThrow('staging failed')
        // The cursor is only saved after every message on the page stages durably.
        expect(cursorSaved).toBe(false)
    })
})
