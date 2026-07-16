import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
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

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
// The read API reads outreach_emails (038), the Phase 19 staging table's sibling schema (039),
// and the Phase 21 conversation tables (041). Apply every migration this seed touches, in order.
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

// Distinct id space so this suite never collides with sibling .db suites on the shared database.
const P = '21040000-0000-4000-8000-0000'
const OWNER_A = `${P}000001`
const MEMBER_A = `${P}000002`
const VIEWER_A = `${P}000003`
const USER2_A = `${P}000004`
const ADMIN_B = `${P}000005`
const OUTSIDER = `${P}000006` // authenticated but member of no org

const ORG_A = `${P}000010`
const ORG_B = `${P}000011`

const ACCOUNT_A = `${P}000020`
const ACCOUNT_A2 = `${P}000021`
const ACCOUNT_B = `${P}000022`

const LEAD_A1 = `${P}000030`
const CAMP_A = `${P}000040`
const CL_A1 = `${P}000050`

// Secrets that must NEVER appear in any response body.
const SMTP_PW_SENTINEL = 'SUPER_SECRET_SMTP_PW_21040000'
const DELTA_CURSOR_SENTINEL = 'DELTA-CURSOR-TOKEN-DO-NOT-LEAK-21040000'

// Org A conversations (account A unless noted). All carry last_inbound_at so they all have an
// incoming message; unread then depends purely on per-user read rows.
const CONV_TOP = `${P}000110`
const CONV_T1 = `${P}000101`
const CONV_T2 = `${P}000102`
const CONV_T3 = `${P}000103`
const CONV_T4 = `${P}000104`
const CONV_T5 = `${P}000105`
const CONV_T6 = `${P}000106`
const CONV_CLOSED = `${P}000111`
const CONV_ACC2 = `${P}000112`
const CONV_SEARCH = `${P}000113`
const CONV_READ = `${P}000114`
const CONV_CAMP = `${P}000116`
const CONV_STALE = `${P}000117`
const CONV_WILD1 = `${P}000118`
const CONV_WILD2 = `${P}000119`

const CONV_B = `${P}000210`

// The full org A ordering under (last_message_at DESC, id DESC). The six 12:00 ties break by id DESC.
const EXPECTED_ORDER = [
    CONV_TOP, // 13:00
    CONV_T6, CONV_T5, CONV_T4, CONV_T3, CONV_T2, CONV_T1, // 12:00 ties, id DESC
    CONV_CLOSED, // 11:00
    CONV_ACC2, // 10:00
    CONV_SEARCH, // 09:00
    CONV_READ, // 08:00
    CONV_CAMP, // 07:30
    CONV_STALE, // 06:00
    CONV_WILD1, // 05:00
    CONV_WILD2, // 04:30
]

const TS = (h: number, m = 0) => `2026-07-16 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

interface CallOptions {
    userId?: string
    method?: string
    body?: unknown
}

async function call(pathname: string, options: CallOptions = {}) {
    const { userId = OWNER_A, method = 'GET', body } = options
    const headers: Record<string, string> = {}
    if (userId) headers['x-user-id'] = userId
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    return { status: response.status, raw: text, body: (text ? JSON.parse(text) : null) as any }
}

async function seedConversation(o: {
    id: string
    lastMessageAt: string
    lastInboundAt?: string | null
    status?: string
    account?: string
    campaign?: string | null
    lead?: string | null
    subject?: string | null
    preview?: string | null
    org?: string
}): Promise<void> {
    await sql`
        INSERT INTO outreach_conversations (
            id, organization_id, email_account_id, lead_id, campaign_id,
            thread_key, normalized_subject, status,
            last_message_at, last_inbound_at, latest_message_preview
        ) VALUES (
            ${o.id}::uuid, ${o.org ?? ORG_A}::uuid, ${o.account ?? ACCOUNT_A}::uuid,
            ${o.lead ?? null}, ${o.campaign ?? null},
            ${'rfc:' + o.id}, ${o.subject ?? null}, ${o.status ?? 'open'},
            ${o.lastMessageAt}::timestamp,
            ${o.lastInboundAt === undefined ? o.lastMessageAt : o.lastInboundAt}::timestamp,
            ${o.preview ?? null}
        )
        ON CONFLICT (id) DO NOTHING
    `
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email) VALUES
        (${OWNER_A}::uuid, 'ui-owner-a@example.test'),
        (${MEMBER_A}::uuid, 'ui-member-a@example.test'),
        (${VIEWER_A}::uuid, 'ui-viewer-a@example.test'),
        (${USER2_A}::uuid, 'ui-user2-a@example.test'),
        (${ADMIN_B}::uuid, 'ui-admin-b@example.test'),
        (${OUTSIDER}::uuid, 'ui-outsider@example.test')
        ON CONFLICT (id) DO NOTHING`

    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'UI Org A', 'ui-org-a', ${OWNER_A}::uuid),
        (${ORG_B}::uuid, 'UI Org B', 'ui-org-b', ${ADMIN_B}::uuid)
        ON CONFLICT (id) DO NOTHING`

    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'admin'),
        (${ORG_A}::uuid, ${MEMBER_A}::uuid, 'member'),
        (${ORG_A}::uuid, ${VIEWER_A}::uuid, 'viewer'),
        (${ORG_A}::uuid, ${USER2_A}::uuid, 'admin'),
        (${ORG_B}::uuid, ${ADMIN_B}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`

    // ACCOUNT_A carries a real SMTP password sentinel that must never surface in any response.
    await sql`INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status) VALUES
        (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'inbox-a@example.test', 'localhost', 'a', ${SMTP_PW_SENTINEL}, 'verified'),
        (${ACCOUNT_A2}::uuid, ${ORG_A}::uuid, 'inbox-a2@example.test', 'localhost', 'a2', 'x', 'verified'),
        (${ACCOUNT_B}::uuid, ${ORG_B}::uuid, 'inbox-b@example.test', 'localhost', 'b', 'x', 'verified')
        ON CONFLICT (id) DO NOTHING`

    await sql`INSERT INTO leads (id, organization_id, email) VALUES
        (${LEAD_A1}::uuid, ${ORG_A}::uuid, 'alice@lead.test') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name) VALUES
        (${CAMP_A}::uuid, ${ORG_A}::uuid, 'Camp A') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaign_leads (id, campaign_id, lead_id) VALUES
        (${CL_A1}::uuid, ${CAMP_A}::uuid, ${LEAD_A1}::uuid) ON CONFLICT (id) DO NOTHING`

    // A provider cursor carrying an opaque Graph delta token that must never leak.
    await sql`INSERT INTO outreach_provider_cursors (organization_id, email_account_id, provider, delta_cursor, last_success_at, last_error, last_error_at)
        VALUES (${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'outlook', ${DELTA_CURSOR_SENTINEL}, ${TS(13, 0)}::timestamp, 'connection refused to imap host', ${TS(12, 0)}::timestamp)
        ON CONFLICT (organization_id, email_account_id, provider) DO NOTHING`

    // Org A conversations.
    await seedConversation({ id: CONV_TOP, lastMessageAt: TS(13), campaign: CAMP_A, lead: LEAD_A1, subject: 'Re: Offer', preview: 'final numbers look good' })
    await seedConversation({ id: CONV_T1, lastMessageAt: TS(12), subject: 'Tie 1' })
    await seedConversation({ id: CONV_T2, lastMessageAt: TS(12), subject: 'Tie 2' })
    await seedConversation({ id: CONV_T3, lastMessageAt: TS(12), subject: 'Tie 3' })
    await seedConversation({ id: CONV_T4, lastMessageAt: TS(12), subject: 'Tie 4' })
    await seedConversation({ id: CONV_T5, lastMessageAt: TS(12), subject: 'Tie 5' })
    await seedConversation({ id: CONV_T6, lastMessageAt: TS(12), subject: 'Tie 6' })
    await seedConversation({ id: CONV_CLOSED, lastMessageAt: TS(11), status: 'closed', subject: 'Closed one' })
    await seedConversation({ id: CONV_ACC2, lastMessageAt: TS(10), account: ACCOUNT_A2, subject: 'Acct2 conv' })
    await seedConversation({ id: CONV_SEARCH, lastMessageAt: TS(9), subject: 'Quarterly Report 2026', preview: 'numbers attached' })
    await seedConversation({ id: CONV_READ, lastMessageAt: TS(8), subject: 'Already read' })
    await seedConversation({ id: CONV_CAMP, lastMessageAt: TS(7, 30), campaign: CAMP_A, lead: LEAD_A1, subject: 'Campaign conv' })
    await seedConversation({ id: CONV_STALE, lastMessageAt: TS(6), subject: 'Stale read' })
    await seedConversation({ id: CONV_WILD1, lastMessageAt: TS(5), subject: '50% off sale', preview: 'limited time' })
    await seedConversation({ id: CONV_WILD2, lastMessageAt: TS(4, 30), subject: '500 off sale', preview: 'great savings' })

    // Org B conversation for cross-tenant tests.
    await seedConversation({ id: CONV_B, org: ORG_B, account: ACCOUNT_B, lastMessageAt: TS(13), subject: 'Org B secret thread' })

    // Participant for participant-search on CONV_SEARCH.
    await sql`INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, name, role) VALUES
        (${ORG_A}::uuid, ${CONV_SEARCH}::uuid, 'zoe@lead.test', 'Zoe Zeta', 'from') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO outreach_conversation_participants (organization_id, conversation_id, address, name, role) VALUES
        (${ORG_A}::uuid, ${CONV_TOP}::uuid, 'alice@lead.test', 'Alice', 'from'),
        (${ORG_A}::uuid, ${CONV_TOP}::uuid, 'inbox-a@example.test', 'Inbox A', 'to') ON CONFLICT DO NOTHING`

    // CONV_TOP messages: one outbound (sent 12:30) + two inbound (12:45, 13:00). Detail must
    // return them in COALESCE(received_at, sent_at, created_at) ASC order with full bodies.
    await sql`INSERT INTO outreach_conversation_messages (
        id, organization_id, conversation_id, email_account_id, direction, provider, source_key,
        internet_message_id, subject, from_address, plain_body, html_body, headers, sent_at, received_at
    ) VALUES
        (${P}000301::uuid, ${ORG_A}::uuid, ${CONV_TOP}::uuid, ${ACCOUNT_A}::uuid, 'outbound', 'native', 'outreach-email:top-1',
         '<top-root@mail.test>', 'Offer', 'inbox-a@example.test', 'Our proposal is attached.', '<p>Our proposal is attached.</p>',
         ${JSON.stringify({ Subject: 'Offer', 'Message-ID': '<top-root@mail.test>' })}::jsonb, ${TS(12, 30)}::timestamp, NULL),
        (${P}000302::uuid, ${ORG_A}::uuid, ${CONV_TOP}::uuid, ${ACCOUNT_A}::uuid, 'inbound', 'native', 'native:top-2',
         '<top-2@lead.test>', 'Re: Offer', 'alice@lead.test', 'Thanks, reviewing now.', '<p>Thanks, reviewing now.</p>',
         ${JSON.stringify({ Subject: 'Re: Offer' })}::jsonb, NULL, ${TS(12, 45)}::timestamp),
        (${P}000303::uuid, ${ORG_A}::uuid, ${CONV_TOP}::uuid, ${ACCOUNT_A}::uuid, 'inbound', 'native', 'native:top-3',
         '<top-3@lead.test>', 'Re: Offer', 'alice@lead.test', 'final numbers look good.', '<p>final numbers look good.</p>',
         ${JSON.stringify({ Subject: 'Re: Offer' })}::jsonb, NULL, ${TS(13, 0)}::timestamp)
        ON CONFLICT (id) DO NOTHING`

    // Pre-seeded read state: OWNER_A has read CONV_READ up to/after its inbound (read),
    // and has a STALE read on CONV_STALE (last_read_at BEFORE last_inbound_at → still unread).
    await sql`INSERT INTO outreach_conversation_reads (organization_id, conversation_id, user_id, last_read_at) VALUES
        (${ORG_A}::uuid, ${CONV_READ}::uuid, ${OWNER_A}::uuid, ${TS(8, 30)}::timestamp),
        (${ORG_A}::uuid, ${CONV_STALE}::uuid, ${OWNER_A}::uuid, ${TS(5, 0)}::timestamp)
        ON CONFLICT (organization_id, conversation_id, user_id) DO NOTHING`

    const unifiedInboxRouter = (await import('../unified-inbox')).default
    closeApplicationDatabase = (await import('../../../../db')).closeDatabaseConnection
    const app = express()
    app.use(express.json())
    app.use('/', unifiedInboxRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    // Clean our rows so the shared database stays pristine for sibling suites.
    await sql`DELETE FROM outreach_conversation_reads WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversation_messages WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversation_participants WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_provider_cursors WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql?.end({ timeout: 1 })
})

function ids(body: any): string[] {
    return (body.conversations as any[]).map((c) => c.id)
}

describe('unified inbox — list contract, filters, and bounded search', () => {
    it('requires authentication and an organization id', async () => {
        expect((await call('/conversations', { userId: '' })).status).toBe(401)
        expect((await call('/conversations')).status).toBe(400)
    })

    it('lists the tenant conversations newest-first with attribution, preview, and no bodies', async () => {
        const res = await call(`/conversations?organizationId=${ORG_A}&limit=100`)
        expect(res.status).toBe(200)
        expect(ids(res.body)).toEqual(EXPECTED_ORDER)
        const top = res.body.conversations.find((c: any) => c.id === CONV_TOP)
        expect(top.campaignId).toBe(CAMP_A)
        expect(top.leadId).toBe(LEAD_A1)
        expect(top.preview).toBe('final numbers look good')
        // No full message bodies anywhere in the list payload.
        expect(res.raw).not.toContain('Our proposal is attached.')
        expect(res.raw).not.toContain('reviewing now')
        // No secrets.
        expect(res.raw).not.toContain(SMTP_PW_SENTINEL)
        expect(res.raw).not.toContain(DELTA_CURSOR_SENTINEL)
    })

    it('rejects out-of-range and malformed query params with 400', async () => {
        expect((await call(`/conversations?organizationId=${ORG_A}&limit=101`)).status).toBe(400)
        expect((await call(`/conversations?organizationId=${ORG_A}&limit=0`)).status).toBe(400)
        expect((await call(`/conversations?organizationId=${ORG_A}&status=bogus`)).status).toBe(400)
        expect((await call(`/conversations?organizationId=${ORG_A}&unread=maybe`)).status).toBe(400)
    })

    it('caps the returned page at the requested limit and reports hasMore', async () => {
        const res = await call(`/conversations?organizationId=${ORG_A}&limit=2`)
        expect(res.body.conversations.length).toBe(2)
        expect(res.body.hasMore).toBe(true)
        expect(res.body.nextCursor).toBeTruthy()
    })

    it('filters by status, campaign, and account without leaking others', async () => {
        const closed = await call(`/conversations?organizationId=${ORG_A}&status=closed&limit=100`)
        expect(ids(closed.body)).toEqual([CONV_CLOSED])

        const campaign = await call(`/conversations?organizationId=${ORG_A}&campaignId=${CAMP_A}&limit=100`)
        expect(ids(campaign.body).sort()).toEqual([CONV_TOP, CONV_CAMP].sort())

        const account = await call(`/conversations?organizationId=${ORG_A}&emailAccountId=${ACCOUNT_A2}&limit=100`)
        expect(ids(account.body)).toEqual([CONV_ACC2])
    })

    it('filters unread conversations for the calling user', async () => {
        // OWNER_A has read CONV_READ (fresh) but has only a STALE read on CONV_STALE.
        const unread = await call(`/conversations?organizationId=${ORG_A}&unread=true&limit=100`, { userId: OWNER_A })
        const unreadIds = ids(unread.body)
        expect(unreadIds).not.toContain(CONV_READ)
        expect(unreadIds).toContain(CONV_STALE)
        expect(unreadIds).toContain(CONV_TOP)
    })

    it('reflects per-user unread flags in the list projection', async () => {
        const forOwner = await call(`/conversations?organizationId=${ORG_A}&limit=100`, { userId: OWNER_A })
        const forUser2 = await call(`/conversations?organizationId=${ORG_A}&limit=100`, { userId: USER2_A })
        const ownerRead = forOwner.body.conversations.find((c: any) => c.id === CONV_READ)
        const user2Read = forUser2.body.conversations.find((c: any) => c.id === CONV_READ)
        expect(ownerRead.unread).toBe(false) // OWNER read it
        expect(user2Read.unread).toBe(true) // USER2 never did — read state is per user
        const ownerStale = forOwner.body.conversations.find((c: any) => c.id === CONV_STALE)
        expect(ownerStale.unread).toBe(true) // stale read (before last inbound) is still unread
    })

    it('runs an escaped, bounded keyword search over subject, preview, and participants', async () => {
        const subject = await call(`/conversations?organizationId=${ORG_A}&search=quarterly&limit=100`)
        expect(ids(subject.body)).toEqual([CONV_SEARCH])

        const participant = await call(`/conversations?organizationId=${ORG_A}&search=${encodeURIComponent('zoe@lead.test')}&limit=100`)
        expect(ids(participant.body)).toEqual([CONV_SEARCH])

        // '%' is a literal, not a wildcard: '50%' matches "50% off" but not "500 off".
        const literal = await call(`/conversations?organizationId=${ORG_A}&search=${encodeURIComponent('50%')}&limit=100`)
        expect(ids(literal.body)).toEqual([CONV_WILD1])

        const empty = await call(`/conversations?organizationId=${ORG_A}&search=nothingmatchesthis&limit=100`)
        expect(empty.body.conversations).toEqual([])
        expect(empty.body.hasMore).toBe(false)
        expect(empty.body.nextCursor).toBeNull()
    })
})

describe('unified inbox — opaque, stable, filter-bound cursor', () => {
    it('paginates every conversation exactly once across many pages with tied timestamps', async () => {
        const collected: string[] = []
        let cursor: string | null = null
        let guard = 0
        do {
            const q = `/conversations?organizationId=${ORG_A}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
            const res: any = await call(q)
            expect(res.status).toBe(200)
            collected.push(...ids(res.body))
            cursor = res.body.nextCursor
            guard += 1
        } while (cursor && guard < 50)
        expect(collected).toEqual(EXPECTED_ORDER) // stable order, no gaps, no reordering across ties
        expect(new Set(collected).size).toBe(collected.length) // no duplicates
    })

    it('rejects a cursor replayed under a changed filter set with 400', async () => {
        const page1 = await call(`/conversations?organizationId=${ORG_A}&limit=2`)
        const cursor = page1.body.nextCursor as string
        expect(cursor).toBeTruthy()
        // Same cursor, different filters → 400 (cannot cross filter sets).
        expect((await call(`/conversations?organizationId=${ORG_A}&limit=2&status=open&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400)
        expect((await call(`/conversations?organizationId=${ORG_A}&limit=2&search=offer&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400)
        // Same filters → still valid.
        expect((await call(`/conversations?organizationId=${ORG_A}&limit=2&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200)
    })

    it('rejects a malformed cursor with 400', async () => {
        expect((await call(`/conversations?organizationId=${ORG_A}&cursor=not-a-real-cursor`)).status).toBe(400)
    })
})

describe('unified inbox — conversation detail', () => {
    it('returns the full ordered thread with bodies, attribution, and participants', async () => {
        const res = await call(`/conversations/${CONV_TOP}?organizationId=${ORG_A}`)
        expect(res.status).toBe(200)
        expect(res.body.conversation.id).toBe(CONV_TOP)
        expect(res.body.conversation.campaignId).toBe(CAMP_A)
        const bodies = res.body.messages.map((m: any) => m.plainBody)
        expect(bodies).toEqual([
            'Our proposal is attached.', // sent_at 12:30
            'Thanks, reviewing now.', // received_at 12:45
            'final numbers look good.', // received_at 13:00
        ])
        const roles = res.body.participants.map((p: any) => p.role).sort()
        expect(roles).toEqual(['from', 'to'])
        // Detail carries safe stored headers but no credentials/tokens.
        expect(res.raw).not.toContain(SMTP_PW_SENTINEL)
        expect(res.raw).not.toContain(DELTA_CURSOR_SENTINEL)
    })

    it('404s an unknown id and never distinguishes it from another tenant’s conversation', async () => {
        const missing = await call(`/conversations/${P}0000ff?organizationId=${ORG_A}`)
        // Org A member asking for an org B conversation id under org A scope: same 404 as missing.
        const crossTenant = await call(`/conversations/${CONV_B}?organizationId=${ORG_A}`)
        expect(missing.status).toBe(404)
        expect(crossTenant.status).toBe(404)
        expect(crossTenant.raw).not.toContain('Org B secret thread')
    })
})

describe('unified inbox — per-user, idempotent read state and unread counts', () => {
    it('counts, mutates, and isolates read state per user idempotently', async () => {
        // Baselines: USER2 read nothing (15 conversations all have inbound); OWNER read CONV_READ (fresh) → 14.
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: USER2_A })).body.unreadCount).toBe(15)
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: OWNER_A })).body.unreadCount).toBe(14)

        // Mark CONV_TOP read for OWNER.
        const marked = await call(`/conversations/${CONV_TOP}/read-state?organizationId=${ORG_A}`, {
            userId: OWNER_A, method: 'PATCH', body: { read: true },
        })
        expect(marked.status).toBe(200)
        expect(marked.body.unread).toBe(false)
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: OWNER_A })).body.unreadCount).toBe(13)

        // Idempotent: marking read again is a no-op (count stable, exactly one read row).
        await call(`/conversations/${CONV_TOP}/read-state?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { read: true } })
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: OWNER_A })).body.unreadCount).toBe(13)
        const rows = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM outreach_conversation_reads
            WHERE conversation_id = ${CONV_TOP}::uuid AND user_id = ${OWNER_A}::uuid`
        expect(Number(rows[0].n)).toBe(1)

        // USER2 is unaffected by OWNER's mutations.
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: USER2_A })).body.unreadCount).toBe(15)

        // Mark unread again → count restored; double mark-unread is also a no-op.
        const unread = await call(`/conversations/${CONV_TOP}/read-state?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { read: false } })
        expect(unread.body.unread).toBe(true)
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: OWNER_A })).body.unreadCount).toBe(14)
        await call(`/conversations/${CONV_TOP}/read-state?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { read: false } })
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: OWNER_A })).body.unreadCount).toBe(14)
    })

    it('validates the read-state body and 404s unknown/cross-tenant ids', async () => {
        expect((await call(`/conversations/${CONV_TOP}/read-state?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { read: 'yes' } })).status).toBe(400)
        expect((await call(`/conversations/${P}0000ff/read-state?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { read: true } })).status).toBe(404)
        // Org A scope, org B id → 404, indistinguishable from missing.
        expect((await call(`/conversations/${CONV_B}/read-state?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { read: true } })).status).toBe(404)
    })
})

describe('unified inbox — role and tenant isolation', () => {
    it('lets a viewer read and manage their own read state', async () => {
        expect((await call(`/conversations?organizationId=${ORG_A}&limit=5`, { userId: VIEWER_A })).status).toBe(200)
        expect((await call(`/conversations/${CONV_TOP}?organizationId=${ORG_A}`, { userId: VIEWER_A })).status).toBe(200)
        expect((await call(`/unread-count?organizationId=${ORG_A}`, { userId: VIEWER_A })).status).toBe(200)
        const patch = await call(`/conversations/${CONV_CAMP}/read-state?organizationId=${ORG_A}`, { userId: VIEWER_A, method: 'PATCH', body: { read: true } })
        expect(patch.status).toBe(200)
        expect(patch.body.unread).toBe(false)
    })

    it('refuses every route for a non-member and never leaks org B existence/content', async () => {
        // OWNER_A is not a member of ORG_B.
        expect((await call(`/conversations?organizationId=${ORG_B}`, { userId: OWNER_A })).status).toBe(403)
        expect((await call(`/unread-count?organizationId=${ORG_B}`, { userId: OWNER_A })).status).toBe(403)
        expect((await call(`/conversations/${CONV_B}?organizationId=${ORG_B}`, { userId: OWNER_A })).status).toBe(403)
        expect((await call(`/conversations/${CONV_B}/read-state?organizationId=${ORG_B}`, { userId: OWNER_A, method: 'PATCH', body: { read: true } })).status).toBe(403)
        // An authenticated user in no org is likewise refused.
        expect((await call(`/conversations?organizationId=${ORG_A}`, { userId: OUTSIDER })).status).toBe(403)
    })

    it('lets org B admin read only org B and never sees org A conversations', async () => {
        const res = await call(`/conversations?organizationId=${ORG_B}&limit=100`, { userId: ADMIN_B })
        expect(res.status).toBe(200)
        expect(ids(res.body)).toEqual([CONV_B])
        expect((await call(`/conversations?organizationId=${ORG_A}`, { userId: ADMIN_B })).status).toBe(403)
    })
})
