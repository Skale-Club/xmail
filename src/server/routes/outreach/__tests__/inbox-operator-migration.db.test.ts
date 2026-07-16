import path from 'node:path'
import postgres from 'postgres'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyHandWrittenMigrations,
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'
import {
    inboxLabels,
    inboxConversationLabels,
    inboxReminders,
    inboxSnippets,
    inboxSendCommands,
    inboxAttachments,
    INBOX_ATTACHMENTS_BUCKET,
} from '../../../../db/schema'

// ------------------------------------------------------------
// Phase 22 (UIX-04 / UIX-05) operator-workflow migration test.
//
// This ONLY ever touches the Phase 18 protected disposable Postgres URL. It never reads
// or falls back to the application DATABASE_URL — assertSafeTestDatabaseUrl rejects
// non-loopback hosts, databases without a `test` marker, and the configured application
// URL itself. Migration 042 is applied TWICE to prove it is re-runnable (a partially
// applied production run must be safe to repeat).
//
// Manual production apply (never Drizzle generate/push):
//   psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/042_unified_inbox_operator_workflows.sql
// ------------------------------------------------------------

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')
const operatorMigration = path.join(migrationsDir, '042_unified_inbox_operator_workflows.sql')

// Distinct id space so this suite never collides with sibling .db suites on the shared DB.
const U = (n: string) => `22010000-0000-4000-8000-${n.padStart(12, '0')}`
const OWNER_A = U('1')
const OWNER_B = U('2')
const ORG_A = U('10')
const ORG_B = U('11')
const ACCOUNT_A = U('20')
const ACCOUNT_B = U('21')
const CONV_A = U('30')
const CONV_B = U('31')
const MSG_A = U('40')
const LABEL_A = U('50')

let sql: ReturnType<typeof postgres>

function connect(max = 2) {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl as string, { max, prepare: false, onnotice: () => {} })
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl as string, runGuard }

    await applyHandWrittenMigrations(target)
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    // A minimal private-storage stub so 042's guarded bucket-configuration block runs and
    // its privacy assertion is testable. Production has the real Supabase `storage` schema;
    // 042 guards on schema existence so it is a no-op where storage is absent.
    const stub = connect(1)
    try {
        await stub.unsafe(`
            CREATE SCHEMA IF NOT EXISTS storage;
            CREATE TABLE IF NOT EXISTS storage.buckets (
                id text PRIMARY KEY,
                name text NOT NULL,
                public boolean NOT NULL DEFAULT false
            );
        `)
    } finally {
        await stub.end({ timeout: 1 })
    }

    // Apply the migration under test TWICE — idempotency is a hard requirement.
    await applyMigrationFile(target, operatorMigration)
    await applyMigrationFile(target, operatorMigration)

    sql = connect()

    await sql`INSERT INTO users (id, email) VALUES
        (${OWNER_A}::uuid, 'op-mig-owner-a@example.test'),
        (${OWNER_B}::uuid, 'op-mig-owner-b@example.test')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG_A}::uuid, 'Op Mig A', 'op-mig-a', ${OWNER_A}::uuid),
        (${ORG_B}::uuid, 'Op Mig B', 'op-mig-b', ${OWNER_B}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO email_accounts (id, organization_id, email, status) VALUES
        (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'acc-a@example.test', 'verified'),
        (${ACCOUNT_B}::uuid, ${ORG_B}::uuid, 'acc-b@example.test', 'verified')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO outreach_conversations (id, organization_id, email_account_id, thread_key) VALUES
        (${CONV_A}::uuid, ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, ${'rfc:conv-a'}),
        (${CONV_B}::uuid, ${ORG_B}::uuid, ${ACCOUNT_B}::uuid, ${'rfc:conv-b'})
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO outreach_conversation_messages
        (id, organization_id, conversation_id, email_account_id, direction, provider, source_key) VALUES
        (${MSG_A}::uuid, ${ORG_A}::uuid, ${CONV_A}::uuid, ${ACCOUNT_A}::uuid, 'inbound', 'native', 'native:mig-a')
        ON CONFLICT (id) DO NOTHING`
})

afterAll(async () => {
    // Clean this suite's rows so the shared database stays pristine for sibling suites.
    await sql`DELETE FROM inbox_attachments WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_send_commands WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_reminders WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_snippets WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_conversation_labels WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM inbox_labels WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversation_messages WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql`DELETE FROM outreach_conversations WHERE organization_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`
    await sql?.end({ timeout: 1 })
})

async function tableExists(name: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ${name}`
    return Number(rows[0].n) === 1
}

async function columnExists(table: string, column: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`
    return Number(rows[0].n) === 1
}

async function indexExists(name: string): Promise<boolean> {
    const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${name}`
    return Number(rows[0].n) === 1
}

describe('042 operator-workflow migration — tables and columns', () => {
    it('creates every operator-workflow table', async () => {
        for (const name of [
            'inbox_labels',
            'inbox_conversation_labels',
            'inbox_reminders',
            'inbox_snippets',
            'inbox_send_commands',
            'inbox_attachments',
        ]) {
            expect(await tableExists(name), `${name} exists`).toBe(true)
        }
    })

    it('adds archive state to the Phase 21 conversation table without touching its status vocab', async () => {
        expect(await columnExists('outreach_conversations', 'archived_at')).toBe(true)
        expect(await columnExists('outreach_conversations', 'archived_by_user_id')).toBe(true)
        // The Phase 21 open/closed status check is unchanged (archive is orthogonal).
        const rows = await sql<{ def: string }[]>`
            SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'public.outreach_conversations'::regclass
              AND conname = 'outreach_conversations_status_check'`
        expect(rows[0].def).toContain(`'open'`)
        expect(rows[0].def).toContain(`'closed'`)
        expect(rows[0].def).not.toContain(`'archived'`)
    })

    it('gives send commands a full durable lifecycle: leases, bounded attempts, idempotency, and result links', async () => {
        for (const column of [
            'actor_user_id', 'organization_id', 'conversation_id', 'source_message_id', 'email_account_id',
            'mode', 'to_recipients', 'cc_recipients', 'bcc_recipients', 'subject', 'body_text', 'body_html',
            'in_reply_to', 'message_references', 'attachment_ids', 'status', 'scheduled_at', 'due_at',
            'lease_token', 'lease_expires_at', 'attempts', 'max_attempts', 'last_error', 'last_policy_code',
            'idempotency_key', 'resulting_conversation_message_id', 'resulting_outreach_email_id',
            'created_at', 'updated_at',
        ]) {
            expect(await columnExists('inbox_send_commands', column), `inbox_send_commands.${column}`).toBe(true)
        }
    })
})

describe('042 operator-workflow migration — tenant keys, uniqueness, bounds, and lease indexes', () => {
    it('enforces one send command per (organization, idempotency_key)', async () => {
        const rows = await sql<{ def: string }[]>`
            SELECT pg_get_constraintdef(c.oid) AS def
            FROM pg_constraint c
            WHERE c.conrelid = 'public.inbox_send_commands'::regclass AND c.contype = 'u'`
        const idxRows = await sql<{ def: string }[]>`
            SELECT indexdef AS def FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'inbox_send_commands'`
        const all = [...rows.map((r) => r.def), ...idxRows.map((r) => r.def)].join('\n')
        expect(all).toMatch(/organization_id[^)]*idempotency_key|idempotency_key[^)]*organization_id/)
    })

    it('indexes due send commands for the lease claimer and by conversation/status', async () => {
        expect(await indexExists('idx_inbox_send_commands_due')).toBe(true)
        expect(await indexExists('idx_inbox_send_commands_conversation')).toBe(true)
    })

    it('bounds send-command attempts and constrains its status/mode vocab', async () => {
        const rows = await sql<{ def: string; name: string }[]>`
            SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'public.inbox_send_commands'::regclass AND contype = 'c'`
        const defs = rows.map((r) => r.def).join('\n')
        expect(defs).toContain('attempts')
        expect(defs).toContain(`'sending'`)
        expect(defs).toContain(`'reply'`)
    })

    it('enforces case-insensitive label-name uniqueness within an organization', async () => {
        await sql`INSERT INTO inbox_labels (id, organization_id, name) VALUES (${LABEL_A}::uuid, ${ORG_A}::uuid, 'Priority')`
        // A case variant in the SAME org must collide.
        let collided = false
        try {
            await sql`INSERT INTO inbox_labels (organization_id, name) VALUES (${ORG_A}::uuid, 'priority')`
        } catch {
            collided = true
        }
        expect(collided).toBe(true)
        // Another org may reuse the same name.
        await sql`INSERT INTO inbox_labels (organization_id, name) VALUES (${ORG_B}::uuid, 'Priority')`
    })

    it('binds every operator row to its organization via composite keys', async () => {
        // A send command may not point at a conversation owned by another org.
        let crossTenantRejected = false
        try {
            await sql`INSERT INTO inbox_send_commands
                (organization_id, actor_user_id, conversation_id, email_account_id, mode, idempotency_key, due_at)
                VALUES (${ORG_A}::uuid, ${OWNER_A}::uuid, ${CONV_B}::uuid, ${ACCOUNT_A}::uuid, 'reply', 'x-cross', now())`
        } catch {
            crossTenantRejected = true
        }
        expect(crossTenantRejected).toBe(true)
    })
})

describe('042 operator-workflow migration — attachments avoid binary-in-Postgres', () => {
    it('stores only object metadata + a private bucket reference, never blobs', async () => {
        for (const column of ['storage_bucket', 'storage_path', 'filename', 'mime_type', 'size_bytes', 'checksum', 'status']) {
            expect(await columnExists('inbox_attachments', column), `inbox_attachments.${column}`).toBe(true)
        }
        // No bytea/blob column may exist on the metadata table.
        const blobRows = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'inbox_attachments' AND data_type = 'bytea'`
        expect(Number(blobRows[0].n)).toBe(0)
        // Object identity is unique so two rows can't claim one stored object.
        const idxRows = await sql<{ def: string }[]>`
            SELECT indexdef AS def FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'inbox_attachments'`
        expect(idxRows.map((r) => r.def).join('\n')).toMatch(/storage_bucket[^)]*storage_path|storage_path[^)]*storage_bucket/)
    })

    it('configures exactly one PRIVATE storage bucket (public = false)', async () => {
        const rows = await sql<{ public: boolean }[]>`
            SELECT public FROM storage.buckets WHERE id = ${INBOX_ATTACHMENTS_BUCKET}`
        expect(rows.length).toBe(1)
        expect(rows[0].public).toBe(false)
    })
})

describe('042 operator-workflow migration — deliberate cascade/restrict behavior', () => {
    it('deleting a label removes its conversation joins but never the conversation or audit rows', async () => {
        const labelId = U('60')
        await sql`INSERT INTO inbox_labels (id, organization_id, name) VALUES (${labelId}::uuid, ${ORG_A}::uuid, 'Detachable')`
        await sql`INSERT INTO inbox_conversation_labels (organization_id, conversation_id, label_id)
            VALUES (${ORG_A}::uuid, ${CONV_A}::uuid, ${labelId}::uuid)`

        await sql`DELETE FROM inbox_labels WHERE id = ${labelId}::uuid`

        const joinRows = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM inbox_conversation_labels WHERE label_id = ${labelId}::uuid`
        expect(Number(joinRows[0].n)).toBe(0)
        const convRows = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM outreach_conversations WHERE id = ${CONV_A}::uuid`
        expect(Number(convRows[0].n)).toBe(1)
    })

    it('nulls a send command\'s source-message link instead of deleting the command when a message is removed', async () => {
        const cmdId = U('70')
        const msgId = U('71')
        await sql`INSERT INTO outreach_conversation_messages
            (id, organization_id, conversation_id, email_account_id, direction, provider, source_key) VALUES
            (${msgId}::uuid, ${ORG_A}::uuid, ${CONV_A}::uuid, ${ACCOUNT_A}::uuid, 'inbound', 'native', 'native:mig-src')`
        await sql`INSERT INTO inbox_send_commands
            (id, organization_id, actor_user_id, conversation_id, source_message_id, email_account_id, mode, idempotency_key, due_at)
            VALUES (${cmdId}::uuid, ${ORG_A}::uuid, ${OWNER_A}::uuid, ${CONV_A}::uuid, ${msgId}::uuid, ${ACCOUNT_A}::uuid, 'reply', 'x-src-null', now())`

        await sql`DELETE FROM outreach_conversation_messages WHERE id = ${msgId}::uuid`

        const rows = await sql<{ source_message_id: string | null }[]>`
            SELECT source_message_id FROM inbox_send_commands WHERE id = ${cmdId}::uuid`
        expect(rows.length).toBe(1)
        expect(rows[0].source_message_id).toBeNull()
    })
})

describe('042 operator-workflow migration — schema mirror', () => {
    it('mirrors the SQL table names byte-for-byte in src/db/schema.ts', () => {
        expect(getTableConfig(inboxLabels).name).toBe('inbox_labels')
        expect(getTableConfig(inboxConversationLabels).name).toBe('inbox_conversation_labels')
        expect(getTableConfig(inboxReminders).name).toBe('inbox_reminders')
        expect(getTableConfig(inboxSnippets).name).toBe('inbox_snippets')
        expect(getTableConfig(inboxSendCommands).name).toBe('inbox_send_commands')
        expect(getTableConfig(inboxAttachments).name).toBe('inbox_attachments')
    })

    it('exports the private bucket id used by the migration and the attachment service', () => {
        expect(INBOX_ATTACHMENTS_BUCKET).toBe('inbox-attachments')
    })
})
