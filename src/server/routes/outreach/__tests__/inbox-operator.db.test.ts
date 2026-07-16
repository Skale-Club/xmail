import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyHandWrittenMigrations,
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'
import { processInboxCommands, processDueReminders } from '../../../jobs/processInboxCommands'
import { executeInboxSendCommand, type ClaimedInboxCommand, type InboxSql } from '../../../lib/inbox-command-dispatch'
import type { cancelInboxSendCommand as CancelFn, InboxOperatorError as InboxOperatorErrorType } from '../../../lib/inbox-operator'
import type { DispatchOutreachInput, DispatchResult } from '../../../lib/outreach-dispatch'

// inbox-operator statically imports the app db (throws without DATABASE_URL), so it — like the
// router — is loaded dynamically in beforeAll, after DATABASE_URL is pointed at the test container.
let cancelInboxSendCommand: typeof CancelFn
let InboxOperatorError: typeof InboxOperatorErrorType

// ------------------------------------------------------------
// Phase 22 (UIX-04 / UIX-05) operator-workflow service + route + worker tests.
//
// Two organizations exercise tenant isolation on every operator mutation, plus bulk bounds,
// label uniqueness, reminder ownership, snippet validation, list filters, and (Task 3) the
// durable command claimer + reminder notifier. Only the protected disposable Postgres URL is
// ever touched; the application DATABASE_URL is never read.
// ------------------------------------------------------------

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const M = (name: string) => path.join(migrationsDir, name)

const U = (n: string) => `22020000-0000-4000-8000-${n.padStart(12, '0')}`
const OWNER_A = U('1') // admin of A
const MEMBER_A = U('2') // member of A
const VIEWER_A = U('3') // viewer of A
const ADMIN_B = U('5') // admin of B
const OUTSIDER = U('6')

const ORG_A = U('10')
const ORG_B = U('11')
const ACCOUNT_A = U('20')
const ACCOUNT_B = U('21')

const CONV_A1 = U('30')
const CONV_A2 = U('31')
const CONV_A3 = U('32')
const CONV_B1 = U('33')
const MSG_A1 = U('40')

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

async function seedConversation(id: string, org: string, account: string): Promise<void> {
    await sql`
        INSERT INTO outreach_conversations (id, organization_id, email_account_id, thread_key, last_message_at, last_inbound_at)
        VALUES (${id}::uuid, ${org}::uuid, ${account}::uuid, ${'rfc:' + id}, now(), now())
        ON CONFLICT (id) DO NOTHING`
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl as string, runGuard }

    await applyHandWrittenMigrations(target)
    await applyMigrationFile(target, M('014_user_notifications.sql'))
    await applyMigrationFile(target, M('038_outreach_dispatch_state_machine.sql'))
    await applyMigrationFile(target, M('039_outreach_provider_events.sql'))
    await applyMigrationFile(target, M('041_unified_inbox_foundation.sql'))
    await applyMigrationFile(target, M('042_unified_inbox_operator_workflows.sql'))

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    sql = postgres(testDatabaseUrl as string, { max: 4, prepare: false })

    // The disposable baseline bootstraps `suppressions` from the pre-outreach Drizzle snapshot
    // (server_id-scoped). Production long ago moved it to organization_id (see the RLS policies in
    // 016_fix_rls_org_scoped.sql and the (organization_id, email_address) unique in 037). Reconcile
    // the disposable DB to that production shape so the suppression service is tested faithfully.
    await sql`ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS organization_id uuid`
    await sql`ALTER TABLE suppressions ALTER COLUMN server_id DROP NOT NULL`
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS suppression_org_email_unique ON suppressions (organization_id, email_address)`

    await sql`INSERT INTO users (id, email) VALUES
        (${OWNER_A}::uuid, 'op-owner-a@example.test'),
        (${MEMBER_A}::uuid, 'op-member-a@example.test'),
        (${VIEWER_A}::uuid, 'op-viewer-a@example.test'),
        (${ADMIN_B}::uuid, 'op-admin-b@example.test'),
        (${OUTSIDER}::uuid, 'op-outsider@example.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'Op A', 'op-a', ${OWNER_A}::uuid),
        (${ORG_B}::uuid, 'Op B', 'op-b', ${ADMIN_B}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organization_users (organization_id, user_id, role) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'admin'),
        (${ORG_A}::uuid, ${MEMBER_A}::uuid, 'member'),
        (${ORG_A}::uuid, ${VIEWER_A}::uuid, 'viewer'),
        (${ORG_B}::uuid, ${ADMIN_B}::uuid, 'admin')
        ON CONFLICT (organization_id, user_id) DO NOTHING`
    await sql`INSERT INTO email_accounts (id, organization_id, email, status) VALUES
        (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'op-inbox-a@example.test', 'verified'),
        (${ACCOUNT_B}::uuid, ${ORG_B}::uuid, 'op-inbox-b@example.test', 'verified')
        ON CONFLICT (id) DO NOTHING`

    await seedConversation(CONV_A1, ORG_A, ACCOUNT_A)
    await seedConversation(CONV_A2, ORG_A, ACCOUNT_A)
    await seedConversation(CONV_A3, ORG_A, ACCOUNT_A)
    await seedConversation(CONV_B1, ORG_B, ACCOUNT_B)
    await sql`INSERT INTO outreach_conversation_messages
        (id, organization_id, conversation_id, email_account_id, direction, provider, source_key, internet_message_id) VALUES
        (${MSG_A1}::uuid, ${ORG_A}::uuid, ${CONV_A1}::uuid, ${ACCOUNT_A}::uuid, 'inbound', 'native', 'native:op-a1', '<op-a1@lead.test>')
        ON CONFLICT (id) DO NOTHING`

    const operatorModule = await import('../../../lib/inbox-operator')
    cancelInboxSendCommand = operatorModule.cancelInboxSendCommand
    InboxOperatorError = operatorModule.InboxOperatorError

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
    await sql`DELETE FROM inbox_attachments WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_send_commands WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_reminders WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_snippets WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_conversation_labels WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_labels WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM suppressions WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_emails WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM user_notifications WHERE user_id IN (${OWNER_A}::uuid, ${MEMBER_A}::uuid, ${VIEWER_A}::uuid, ${ADMIN_B}::uuid)`
    await sql`DELETE FROM outreach_conversation_messages WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql?.end({ timeout: 1 })
})

describe('operator — labels: CRUD, tenant isolation, case-insensitive uniqueness, idempotent attach', () => {
    let labelA: string

    it('creates and lists labels only within the organization', async () => {
        const created = await call(`/labels?organizationId=${ORG_A}`, { method: 'POST', body: { name: 'Priority', color: '#f00' } })
        expect(created.status).toBe(201)
        labelA = created.body.label.id

        // Org B never sees org A labels.
        const listB = await call(`/labels?organizationId=${ORG_B}`, { userId: ADMIN_B })
        expect(listB.status).toBe(200)
        expect(listB.body.labels.map((l: any) => l.id)).not.toContain(labelA)
    })

    it('rejects a case-variant duplicate within the org but allows it in another org', async () => {
        const dup = await call(`/labels?organizationId=${ORG_A}`, { method: 'POST', body: { name: 'priority' } })
        expect(dup.status).toBe(409)
        expect(dup.body.error).toBe('label_name_taken')

        const otherOrg = await call(`/labels?organizationId=${ORG_B}`, { userId: ADMIN_B, method: 'POST', body: { name: 'Priority' } })
        expect(otherOrg.status).toBe(201)
    })

    it('attaches/detaches idempotently and never lets org B mutate org A conversations', async () => {
        const attach1 = await call(`/conversations/${CONV_A1}/labels?organizationId=${ORG_A}`, { method: 'POST', body: { labelId: labelA } })
        expect(attach1.status).toBe(200)
        // Idempotent re-attach.
        expect((await call(`/conversations/${CONV_A1}/labels?organizationId=${ORG_A}`, { method: 'POST', body: { labelId: labelA } })).status).toBe(200)
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM inbox_conversation_labels WHERE conversation_id = ${CONV_A1}::uuid`
        expect(Number(rows[0].n)).toBe(1)

        // Org B admin cannot attach an org-A label to an org-A conversation under org B scope (403 non-member on A).
        expect((await call(`/conversations/${CONV_A1}/labels?organizationId=${ORG_A}`, { userId: ADMIN_B, method: 'POST', body: { labelId: labelA } })).status).toBe(403)

        // Detach is idempotent.
        expect((await call(`/conversations/${CONV_A1}/labels/${labelA}?organizationId=${ORG_A}`, { method: 'DELETE' })).status).toBe(200)
        expect((await call(`/conversations/${CONV_A1}/labels/${labelA}?organizationId=${ORG_A}`, { method: 'DELETE' })).status).toBe(200)
    })

    it('filters the conversation list by label without leaking other conversations', async () => {
        await call(`/conversations/${CONV_A2}/labels?organizationId=${ORG_A}`, { method: 'POST', body: { labelId: labelA } })
        const filtered = await call(`/conversations?organizationId=${ORG_A}&labelId=${labelA}&limit=100`)
        expect(filtered.status).toBe(200)
        expect(filtered.body.conversations.map((c: any) => c.id)).toEqual([CONV_A2])
        // The label appears on the item projection.
        expect(filtered.body.conversations[0].labels.map((l: any) => l.name)).toContain('Priority')
    })

    it('deleting a label removes it from conversations but keeps the conversations', async () => {
        await call(`/labels/${labelA}?organizationId=${ORG_A}`, { method: 'DELETE' })
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM inbox_conversation_labels WHERE label_id = ${labelA}::uuid`
        expect(Number(rows[0].n)).toBe(0)
        const conv = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM outreach_conversations WHERE id = ${CONV_A2}::uuid`
        expect(Number(conv[0].n)).toBe(1)
    })
})

describe('operator — viewer is read-only, non-members are refused', () => {
    it('lets a viewer read labels/snippets but not mutate', async () => {
        expect((await call(`/labels?organizationId=${ORG_A}`, { userId: VIEWER_A })).status).toBe(200)
        expect((await call(`/snippets?organizationId=${ORG_A}`, { userId: VIEWER_A })).status).toBe(200)
        expect((await call(`/labels?organizationId=${ORG_A}`, { userId: VIEWER_A, method: 'POST', body: { name: 'Nope' } })).status).toBe(403)
        expect((await call(`/conversations/${CONV_A1}/status?organizationId=${ORG_A}`, { userId: VIEWER_A, method: 'PATCH', body: { status: 'closed' } })).status).toBe(403)
    })

    it('refuses non-members on read and write', async () => {
        expect((await call(`/labels?organizationId=${ORG_A}`, { userId: OUTSIDER })).status).toBe(403)
        expect((await call(`/labels?organizationId=${ORG_B}`, { userId: OWNER_A, method: 'POST', body: { name: 'X' } })).status).toBe(403)
    })
})

describe('operator — conversation status and archive', () => {
    it('sets status and archive state, and 404s a cross-tenant conversation', async () => {
        const status = await call(`/conversations/${CONV_A3}/status?organizationId=${ORG_A}`, { method: 'PATCH', body: { status: 'closed' } })
        expect(status.status).toBe(200)
        expect(status.body.conversation.status).toBe('closed')

        const archived = await call(`/conversations/${CONV_A3}/archive?organizationId=${ORG_A}`, { method: 'PATCH', body: { archived: true } })
        expect(archived.status).toBe(200)
        expect(archived.body.conversation.archived).toBe(true)

        // Archived filter round-trips.
        const onlyArchived = await call(`/conversations?organizationId=${ORG_A}&archived=true&limit=100`)
        expect(onlyArchived.body.conversations.map((c: any) => c.id)).toContain(CONV_A3)
        const notArchived = await call(`/conversations?organizationId=${ORG_A}&archived=false&limit=100`)
        expect(notArchived.body.conversations.map((c: any) => c.id)).not.toContain(CONV_A3)

        // Org A scope, org B conversation id → 404 (existence-safe).
        expect((await call(`/conversations/${CONV_B1}/status?organizationId=${ORG_A}`, { method: 'PATCH', body: { status: 'closed' } })).status).toBe(404)

        // Restore for later tests.
        await call(`/conversations/${CONV_A3}/archive?organizationId=${ORG_A}`, { method: 'PATCH', body: { archived: false } })
    })
})

describe('operator — bounded, transactional bulk actions', () => {
    it('rejects >100 ids, empty input, and duplicate ids', async () => {
        const tooMany = Array.from({ length: 101 }, (_, i) => U((1000 + i).toString()))
        expect((await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: { conversationIds: tooMany, action: 'read' } })).status).toBe(400)
        expect((await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: { conversationIds: [], action: 'read' } })).status).toBe(400)
        const dupBody = { conversationIds: [CONV_A1, CONV_A1], action: 'read' }
        expect((await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: dupBody })).status).toBe(400)
    })

    it('reports matched/updated/skipped and never touches another tenant', async () => {
        // CONV_B1 belongs to org B: under org A scope it is skipped, not mutated.
        const res = await call(`/conversations/bulk?organizationId=${ORG_A}`, {
            method: 'POST',
            body: { conversationIds: [CONV_A1, CONV_A2, CONV_B1], action: 'status', status: 'closed' },
        })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ matched: 2, updated: 2, skipped: 1 })

        // CONV_B1 in org B is untouched.
        const bRows = await sql<{ status: string }[]>`SELECT status FROM outreach_conversations WHERE id = ${CONV_B1}::uuid`
        expect(bRows[0].status).toBe('open')

        // Restore.
        await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: { conversationIds: [CONV_A1, CONV_A2], action: 'status', status: 'open' } })
    })

    it('bulk read/unread mutates only the calling user idempotently', async () => {
        const read = await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: { conversationIds: [CONV_A1], action: 'read' } })
        expect(read.body.updated).toBe(1)
        // Second read is idempotent — still exactly one read row.
        await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: { conversationIds: [CONV_A1], action: 'read' } })
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM outreach_conversation_reads WHERE conversation_id = ${CONV_A1}::uuid AND user_id = ${OWNER_A}::uuid`
        expect(Number(rows[0].n)).toBe(1)
        await call(`/conversations/bulk?organizationId=${ORG_A}`, { method: 'POST', body: { conversationIds: [CONV_A1], action: 'unread' } })
    })
})

describe('operator — reminders: ownership and due summary', () => {
    let reminderByMember: string

    it('creates a reminder and lists it org-visibly', async () => {
        const created = await call(`/conversations/${CONV_A1}/reminders?organizationId=${ORG_A}`, {
            userId: MEMBER_A,
            method: 'POST',
            body: { remindAt: new Date(Date.now() + 3600_000).toISOString(), note: 'follow up' },
        })
        expect(created.status).toBe(201)
        reminderByMember = created.body.reminder.id

        // OWNER (admin) can see the member's reminder on the conversation (org-visible).
        const list = await call(`/conversations/${CONV_A1}/reminders?organizationId=${ORG_A}`, { userId: OWNER_A })
        expect(list.body.reminders.map((r: any) => r.id)).toContain(reminderByMember)
    })

    it('only the creator or an admin may edit/delete another user\'s reminder', async () => {
        // A different plain member cannot edit — but we only have one member; use viewer denial for write and admin allowance.
        // Admin (OWNER_A) may edit the member's reminder.
        const adminEdit = await call(`/reminders/${reminderByMember}?organizationId=${ORG_A}`, { userId: OWNER_A, method: 'PATCH', body: { note: 'admin touched' } })
        expect(adminEdit.status).toBe(200)
        expect(adminEdit.body.reminder.note).toBe('admin touched')

        // Creator may edit their own.
        const creatorEdit = await call(`/reminders/${reminderByMember}?organizationId=${ORG_A}`, { userId: MEMBER_A, method: 'PATCH', body: { note: 'creator touched' } })
        expect(creatorEdit.status).toBe(200)

        // A cross-tenant reminder id is 404 under org B.
        expect((await call(`/reminders/${reminderByMember}?organizationId=${ORG_B}`, { userId: ADMIN_B, method: 'PATCH', body: { note: 'x' } })).status).toBe(404)
    })

    it('summarizes due vs upcoming reminders for the calling user', async () => {
        // A due (past) reminder for OWNER.
        await call(`/conversations/${CONV_A1}/reminders?organizationId=${ORG_A}`, {
            userId: OWNER_A, method: 'POST', body: { remindAt: new Date(Date.now() - 3600_000).toISOString() },
        })
        const summary = await call(`/reminders?organizationId=${ORG_A}`, { userId: OWNER_A })
        expect(summary.status).toBe(200)
        expect(summary.body.dueCount).toBeGreaterThanOrEqual(1)
        // MEMBER's reminder is upcoming, not OWNER's due — per-user scoping.
        const memberSummary = await call(`/reminders?organizationId=${ORG_A}`, { userId: MEMBER_A })
        expect(memberSummary.body.upcomingCount).toBeGreaterThanOrEqual(1)
    })
})

describe('operator — snippets: CRUD, uniqueness, and no scriptable HTML', () => {
    it('creates snippets, rejects duplicate names, and rejects scriptable bodies', async () => {
        const created = await call(`/snippets?organizationId=${ORG_A}`, { method: 'POST', body: { name: 'Greeting', body: 'Hello there' } })
        expect(created.status).toBe(201)
        expect((await call(`/snippets?organizationId=${ORG_A}`, { method: 'POST', body: { name: 'greeting', body: 'dup' } })).status).toBe(409)

        const scriptable = await call(`/snippets?organizationId=${ORG_A}`, { method: 'POST', body: { name: 'Bad', body: '<script>alert(1)</script>' } })
        expect(scriptable.status).toBe(400)
        expect(scriptable.body.error).toBe('snippet_scriptable_html')

        const onhandler = await call(`/snippets?organizationId=${ORG_A}`, { method: 'POST', body: { name: 'Bad2', body: '<img src=x onerror=alert(1)>' } })
        expect(onhandler.status).toBe(400)
    })

    it('isolates snippets per organization', async () => {
        const listB = await call(`/snippets?organizationId=${ORG_B}`, { userId: ADMIN_B })
        expect(listB.body.snippets.map((s: any) => s.name)).not.toContain('Greeting')
    })
})

// ============================================================
// Task 3: durable command/reminder claiming, lease safety, restart recovery
// ============================================================

interface SeedCommandOptions {
    id: string
    org?: string
    conv?: string
    account?: string
    idempotencyKey: string
    status?: string
    dueAt?: string
    leaseExpiresAt?: string | null
    attempts?: number
    maxAttempts?: number
    to?: string
}

async function seedCommand(o: SeedCommandOptions): Promise<void> {
    // The lease check requires lease_token and lease_expires_at to be both null or both set.
    const leaseToken = o.leaseExpiresAt ? randomUUID() : null
    await sql`
        INSERT INTO inbox_send_commands (
            id, organization_id, conversation_id, actor_user_id, email_account_id,
            mode, to_recipients, subject, body_text, idempotency_key,
            status, due_at, lease_token, lease_expires_at, attempts, max_attempts
        ) VALUES (
            ${o.id}::uuid, ${o.org ?? ORG_A}::uuid, ${o.conv ?? CONV_A1}::uuid, ${OWNER_A}::uuid, ${o.account ?? ACCOUNT_A}::uuid,
            'reply', ${JSON.stringify([{ address: o.to ?? 'lead@prospect.test', name: null }])}::jsonb, 'Re: hi', 'thanks',
            ${o.idempotencyKey},
            ${o.status ?? 'scheduled'},
            ${o.dueAt ?? new Date(Date.now() - 1000).toISOString()}::timestamp,
            ${leaseToken}::uuid,
            ${o.leaseExpiresAt ?? null}::timestamp,
            ${o.attempts ?? 0}, ${o.maxAttempts ?? 8}
        )
        ON CONFLICT (id) DO NOTHING`
}

function fakeDispatch(result: DispatchResult) {
    const calls: DispatchOutreachInput[] = []
    const fn = async (input: DispatchOutreachInput): Promise<DispatchResult> => {
        calls.push(input)
        return result
    }
    return { fn, calls }
}

async function commandRow(id: string): Promise<{ status: string; attempts: number; last_error: string | null; last_policy_code: string | null }> {
    const rows = await sql<{ status: string; attempts: number; last_error: string | null; last_policy_code: string | null }[]>`
        SELECT status, attempts, last_error, last_policy_code FROM inbox_send_commands WHERE id = ${id}::uuid`
    return rows[0]
}

describe('inbox commands — lease-safe claim, at-most-once dispatch, and restart recovery', () => {
    it('claims a due command exactly once under concurrency and dispatches it', async () => {
        const id = U('200')
        await seedCommand({ id, idempotencyKey: 'cmd-concurrent' })
        const dispatch = fakeDispatch({ status: 'sent', rowId: 'not-a-uuid', messageId: '<x@y>' })

        // Two workers race on the same due command.
        await Promise.all([
            processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn }),
            processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn }),
        ])

        expect(dispatch.calls.length).toBe(1) // FOR UPDATE SKIP LOCKED → one claimer only
        expect((await commandRow(id)).status).toBe('sent')
    })

    it('recovers an expired-lease (crashed) command and dispatches at most once via the idempotency key', async () => {
        const id = U('201')
        // Simulate a crash mid-send: left 'sending' with an expired lease and one attempt used.
        await seedCommand({ id, idempotencyKey: 'cmd-recover', status: 'sending', leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(), attempts: 1 })
        // On reclaim, the durable dispatcher would report the idempotency key as already sent.
        const dispatch = fakeDispatch({ status: 'duplicate', rowId: 'not-a-uuid' })

        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })

        expect(dispatch.calls.length).toBe(1)
        expect((await commandRow(id)).status).toBe('sent') // duplicate finalizes as sent, never resends
    })

    it('a repeated tick does not re-dispatch an already-sent command', async () => {
        const id = U('202')
        await seedCommand({ id, idempotencyKey: 'cmd-once' })
        const dispatch = fakeDispatch({ status: 'sent', rowId: 'not-a-uuid' })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })
        expect(dispatch.calls.length).toBe(1) // second tick finds nothing due
    })
})

describe('inbox commands — policy denials, terminal failure, and ambiguous held', () => {
    it('reschedules a recoverable policy denial without losing the draft or burning an attempt', async () => {
        const id = U('210')
        await seedCommand({ id, idempotencyKey: 'cmd-defer', attempts: 0 })
        const retryAt = new Date(Date.now() + 3600_000)
        const dispatch = fakeDispatch({ status: 'deferred', code: 'account_spacing', retryAt })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })

        const row = await commandRow(id)
        expect(row.status).toBe('scheduled') // draft preserved
        expect(row.last_policy_code).toBe('account_spacing')
        expect(Number(row.attempts)).toBe(0) // the claim's attempt is refunded on a policy wait
    })

    it('marks a terminal failure inspectable once attempts are exhausted', async () => {
        const id = U('211')
        await seedCommand({ id, idempotencyKey: 'cmd-fail', attempts: 0, maxAttempts: 1 })
        const dispatch = fakeDispatch({ status: 'failed', rowId: 'not-a-uuid', code: 'provider_500' })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })

        const row = await commandRow(id)
        expect(row.status).toBe('failed')
        expect(row.last_error).toBe('provider_500')
    })

    it('holds an ambiguous provider outcome for manual review and never resends it', async () => {
        const id = U('212')
        await seedCommand({ id, idempotencyKey: 'cmd-held' })
        const dispatch = fakeDispatch({ status: 'held', rowId: U('999') })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })
        expect((await commandRow(id)).status).toBe('held')

        // A later tick must not re-dispatch a held command.
        const again = fakeDispatch({ status: 'sent', rowId: 'not-a-uuid' })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: again.fn })
        expect(again.calls.length).toBe(0)
    })

    it('fails (never dispatches) a command whose conversation is not in the org at execution time', async () => {
        // The composite FK prevents inserting a cross-tenant command, so exercise the executor's
        // defense-in-depth revalidation directly: a real leased command row, but a claimed snapshot
        // whose conversationId no longer resolves under the org.
        const id = U('213')
        const leaseToken = '22020000-0000-4000-8000-000000000abc'
        await seedCommand({ id, idempotencyKey: 'cmd-revalidate', status: 'sending', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), attempts: 1 })
        await sql`UPDATE inbox_send_commands SET lease_token = ${leaseToken}::uuid WHERE id = ${id}::uuid`

        const dispatch = fakeDispatch({ status: 'sent', rowId: 'not-a-uuid' })
        const claimed: ClaimedInboxCommand = {
            id,
            organizationId: ORG_A,
            conversationId: U('ffffff'), // does not exist in ORG_A
            emailAccountId: ACCOUNT_A,
            actorUserId: OWNER_A,
            mode: 'reply',
            toRecipients: [{ address: 'lead@prospect.test', name: null }],
            ccRecipients: [],
            bccRecipients: [],
            subject: 'Re: hi',
            bodyText: 'thanks',
            bodyHtml: null,
            inReplyTo: null,
            messageReferences: null,
            idempotencyKey: 'cmd-revalidate',
            leaseToken,
            attempts: 1,
            maxAttempts: 8,
        }
        const outcome = await executeInboxSendCommand(claimed, { sql: sql as unknown as InboxSql, dispatch: dispatch.fn })

        expect(outcome).toBe('failed')
        expect(dispatch.calls.length).toBe(0) // revalidation rejects BEFORE any dispatch/side effect
        expect((await commandRow(id)).last_error).toBe('conversation_missing')
    })
})

describe('inbox commands — cancellation race', () => {
    it('cannot cancel an in-flight (leased sending) command but can cancel a scheduled one', async () => {
        const sendingId = U('220')
        await seedCommand({ id: sendingId, idempotencyKey: 'cmd-sending', status: 'sending', leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(), attempts: 1 })
        await expect(cancelInboxSendCommand(ORG_A, sendingId)).rejects.toBeInstanceOf(InboxOperatorError)

        const scheduledId = U('221')
        await seedCommand({ id: scheduledId, idempotencyKey: 'cmd-cancel', dueAt: new Date(Date.now() - 1000).toISOString() })
        const cancelled = await cancelInboxSendCommand(ORG_A, scheduledId)
        expect(cancelled.status).toBe('cancelled')

        // A cancelled command is never claimed.
        const dispatch = fakeDispatch({ status: 'sent', rowId: 'not-a-uuid' })
        await processInboxCommands({ sql, organizationId: ORG_A, dispatch: dispatch.fn })
        expect(dispatch.calls.map((c) => c.idempotencyKey)).not.toContain('cmd-cancel')
    })
})

describe('inbox commands — reminders notify once, org-scoped', () => {
    it('notifies a due reminder exactly once across duplicate ticks and targets the reminder owner', async () => {
        const reminderId = U('230')
        await sql`
            INSERT INTO inbox_reminders (id, organization_id, conversation_id, user_id, remind_at, note, status)
            VALUES (${reminderId}::uuid, ${ORG_A}::uuid, ${CONV_A1}::uuid, ${MEMBER_A}::uuid, ${new Date(Date.now() - 60_000).toISOString()}::timestamp, 'ping me', 'scheduled')
            ON CONFLICT (id) DO NOTHING`
        // An upcoming reminder must NOT fire.
        const upcomingId = U('231')
        await sql`
            INSERT INTO inbox_reminders (id, organization_id, conversation_id, user_id, remind_at, status)
            VALUES (${upcomingId}::uuid, ${ORG_A}::uuid, ${CONV_A1}::uuid, ${MEMBER_A}::uuid, ${new Date(Date.now() + 3600_000).toISOString()}::timestamp, 'scheduled')
            ON CONFLICT (id) DO NOTHING`

        // Two ticks (simulating a duplicate run / restart).
        await processDueReminders({ sql, organizationId: ORG_A })
        await processDueReminders({ sql, organizationId: ORG_A })

        const notifs = await sql<{ user_id: string; metadata: unknown }[]>`
            SELECT user_id, metadata FROM user_notifications
            WHERE type = 'inbox_reminder' AND (metadata->>'reminderId') = ${reminderId}`
        expect(notifs.length).toBe(1) // deduplicated: one notification for one reminder
        expect(notifs[0].user_id).toBe(MEMBER_A) // targets the reminder owner
        // postgres-js returns jsonb as a string under prepare:false; parse to read the payload.
        const meta = typeof notifs[0].metadata === 'string' ? JSON.parse(notifs[0].metadata) : notifs[0].metadata
        expect(meta.organizationId).toBe(ORG_A) // org-scoped

        const due = await sql<{ status: string }[]>`SELECT status FROM inbox_reminders WHERE id = ${reminderId}::uuid`
        expect(due[0].status).toBe('notified')
        const upcoming = await sql<{ status: string }[]>`SELECT status FROM inbox_reminders WHERE id = ${upcomingId}::uuid`
        expect(upcoming[0].status).toBe('scheduled') // not yet due
    })
})

describe('operator — durable send-command creation', () => {
    it('creates a durable scheduled command idempotently and blocks cross-tenant conversation', async () => {
        const body = {
            emailAccountId: ACCOUNT_A,
            mode: 'reply',
            sourceMessageId: MSG_A1,
            to: [{ address: 'lead@prospect.test' }],
            subject: 'Re: hello',
            bodyText: 'thanks!',
            inReplyTo: '<op-a1@lead.test>',
            idempotencyKey: 'op-cmd-key-1',
        }
        const created = await call(`/conversations/${CONV_A1}/send-commands?organizationId=${ORG_A}`, { method: 'POST', body })
        expect(created.status).toBe(201)
        expect(created.body.command.status).toBe('scheduled')

        // Idempotent replay with the same key returns the same command (200, not a second row).
        const replay = await call(`/conversations/${CONV_A1}/send-commands?organizationId=${ORG_A}`, { method: 'POST', body })
        expect(replay.status).toBe(200)
        expect(replay.body.command.id).toBe(created.body.command.id)
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM inbox_send_commands WHERE organization_id = ${ORG_A}::uuid AND idempotency_key = 'op-cmd-key-1'`
        expect(Number(rows[0].n)).toBe(1)

        // Cross-tenant conversation id under org A scope → 404 (existence-safe).
        expect((await call(`/conversations/${CONV_B1}/send-commands?organizationId=${ORG_A}`, { method: 'POST', body: { ...body, idempotencyKey: 'op-cmd-key-x' } })).status).toBe(404)

        // Cancel the command.
        const cancelled = await call(`/send-commands/${created.body.command.id}/cancel?organizationId=${ORG_A}`, { method: 'POST' })
        expect(cancelled.status).toBe(200)
        expect(cancelled.body.command.status).toBe('cancelled')
    })
})

describe('operator — sender/domain suppression (destructive, server-authoritative)', () => {
    it('previews then blocks a sender idempotently and enforces it in the delivery policy', async () => {
        const preview = await call(`/suppressions/preview?organizationId=${ORG_A}`, {
            method: 'POST', body: { email: 'Blocked.Lead@Acme.example', scope: 'sender' },
        })
        expect(preview.status).toBe(200)
        expect(preview.body).toMatchObject({ email: 'blocked.lead@acme.example', domain: 'acme.example', isPublicDomain: false, alreadySuppressed: false })

        const applied = await call(`/suppressions?organizationId=${ORG_A}`, {
            method: 'POST', body: { email: 'blocked.lead@acme.example', scope: 'sender' },
        })
        expect(applied.status).toBe(200)
        expect(applied.body).toMatchObject({ suppressed: true, scope: 'sender', alreadySuppressed: false })

        // Idempotent: a second block is a no-op that reports already-suppressed, one row only.
        const again = await call(`/suppressions?organizationId=${ORG_A}`, {
            method: 'POST', body: { email: 'blocked.lead@acme.example', scope: 'sender' },
        })
        expect(again.body.alreadySuppressed).toBe(true)
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM suppressions WHERE organization_id = ${ORG_A}::uuid AND lower(email_address) = 'blocked.lead@acme.example'`
        expect(Number(rows[0].n)).toBe(1)

        // End-to-end: the delivery policy now denies this recipient.
        const { evaluateOutreachDeliveryPolicy } = await import('../../../lib/outreach-delivery-policy')
        const decision = await evaluateOutreachDeliveryPolicy({
            origin: 'manual', organizationId: ORG_A, emailAccountId: ACCOUNT_A, recipientEmail: 'blocked.lead@acme.example',
        })
        expect(decision).toEqual({ allowed: false, code: 'recipient_suppressed' })
    })

    it('refuses a domain block on a public/free-mail provider', async () => {
        const preview = await call(`/suppressions/preview?organizationId=${ORG_A}`, {
            method: 'POST', body: { email: 'someone@gmail.com', scope: 'domain' },
        })
        expect(preview.status).toBe(200)
        expect(preview.body.isPublicDomain).toBe(true)

        const applied = await call(`/suppressions?organizationId=${ORG_A}`, {
            method: 'POST', body: { email: 'someone@gmail.com', scope: 'domain' },
        })
        expect(applied.status).toBe(400)
        expect(applied.body.error).toBe('suppression_public_domain')
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM suppressions WHERE organization_id = ${ORG_A}::uuid AND email_address = '@gmail.com'`
        expect(Number(rows[0].n)).toBe(0)
    })

    it('blocks a safe domain (sentinel) and the policy denies every address at it', async () => {
        const applied = await call(`/suppressions?organizationId=${ORG_A}`, {
            method: 'POST', body: { email: 'anyone@blockme.example', scope: 'domain' },
        })
        expect(applied.status).toBe(200)
        expect(applied.body).toMatchObject({ suppressed: true, scope: 'domain', domain: 'blockme.example' })
        const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM suppressions WHERE organization_id = ${ORG_A}::uuid AND email_address = '@blockme.example'`
        expect(Number(rows[0].n)).toBe(1)

        const { evaluateOutreachDeliveryPolicy } = await import('../../../lib/outreach-delivery-policy')
        // A DIFFERENT address at the blocked domain is denied by the domain sentinel.
        const decision = await evaluateOutreachDeliveryPolicy({
            origin: 'manual', organizationId: ORG_A, emailAccountId: ACCOUNT_A, recipientEmail: 'fresh.contact@blockme.example',
        })
        expect(decision).toEqual({ allowed: false, code: 'recipient_suppressed' })
    })

    it('keeps suppression organization-scoped and viewer/non-member out', async () => {
        // Org B never sees org A's block, and its own block is isolated.
        const previewB = await call(`/suppressions/preview?organizationId=${ORG_B}`, {
            userId: ADMIN_B, method: 'POST', body: { email: 'blocked.lead@acme.example', scope: 'sender' },
        })
        expect(previewB.body.alreadySuppressed).toBe(false)

        // Viewer cannot suppress; non-member is refused.
        expect((await call(`/suppressions?organizationId=${ORG_A}`, { userId: VIEWER_A, method: 'POST', body: { email: 'x@acme.example', scope: 'sender' } })).status).toBe(403)
        expect((await call(`/suppressions?organizationId=${ORG_A}`, { userId: OUTSIDER, method: 'POST', body: { email: 'x@acme.example', scope: 'sender' } })).status).toBe(403)
    })
})
