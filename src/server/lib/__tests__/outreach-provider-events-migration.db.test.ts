import { readFile } from 'node:fs/promises'
import path from 'node:path'
import postgres from 'postgres'
import { beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

// Only the harness-provisioned disposable database is ever touched here. The
// application DATABASE_URL is never read and never falls back to — assertSafeTestDatabaseUrl
// rejects non-loopback hosts, databases without a test marker, and the configured
// application URL itself.
const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '039_outreach_provider_events.sql',
)

const ORG_A = '30000000-0000-4000-8000-000000000001'
const ORG_B = '30000000-0000-4000-8000-000000000002'
const ACCOUNT_A = '30000000-0000-4000-8000-000000000011'
const OWNER = '30000000-0000-4000-8000-000000000021'

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }

    // Applying twice proves the migration is re-runnable: a partially applied
    // production run must be safe to repeat.
    await applyMigrationFile(target, migrationPath)
    await applyMigrationFile(target, migrationPath)

    const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
    try {
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'events-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO organizations (id, name, slug, owner_id)
            VALUES (${ORG_A}::uuid, 'Events Test A', 'events-test-a', ${OWNER}::uuid),
                   (${ORG_B}::uuid, 'Events Test B', 'events-test-b', ${OWNER}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${ACCOUNT_A}::uuid, ${ORG_A}::uuid, 'events@example.test', 'localhost', 'events', 'not-a-real-secret', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }
})

function connect() {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max: 1, prepare: false })
}

describe('outreach provider events migration 039', () => {
    it('creates both staging tables with the documented column shape', async () => {
        const sql = connect()
        try {
            const columns = await sql<{
                table_name: string
                column_name: string
                data_type: string
                is_nullable: 'YES' | 'NO'
            }[]>`
                SELECT table_name, column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name IN ('outreach_provider_events', 'outreach_provider_cursors')
            `
            const key = (table: string, column: string) =>
                columns.find((row) => row.table_name === table && row.column_name === column)

            for (const column of [
                'organization_id',
                'email_account_id',
                'provider',
                'provider_message_id',
                'classification',
            ]) {
                expect(key('outreach_provider_events', column)?.is_nullable, column).toBe('NO')
            }

            // Bodies and metadata are retained for Phase 21 conversation materialization.
            for (const column of [
                'message_id',
                'in_reply_to',
                'message_references',
                'from_address',
                'subject',
                'text_body',
                'html_body',
                'processed_at',
                'processing_error',
            ]) {
                expect(key('outreach_provider_events', column)?.is_nullable, column).toBe('YES')
            }
            expect(key('outreach_provider_events', 'headers')?.data_type).toBe('jsonb')
            expect(key('outreach_provider_events', 'attachments')?.data_type).toBe('jsonb')
            expect(key('outreach_provider_events', 'to_addresses')?.data_type).toBe('jsonb')
            expect(key('outreach_provider_events', 'received_at')?.is_nullable).toBe('NO')

            for (const column of ['organization_id', 'email_account_id', 'provider']) {
                expect(key('outreach_provider_cursors', column)?.is_nullable, column).toBe('NO')
            }
            // Bounded resumable state: Graph delta link, IMAP uid validity/high-water,
            // native received-at/id tie breaker, lease, and error/retry bookkeeping.
            for (const column of [
                'delta_cursor',
                'uid_validity',
                'last_uid',
                'last_received_at',
                'last_provider_message_id',
                'lease_token',
                'lease_expires_at',
                'last_success_at',
                'last_error',
                'retry_at',
            ]) {
                expect(key('outreach_provider_cursors', column), column).toBeDefined()
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('deduplicates provider messages on the tenant-scoped event key', async () => {
        const sql = connect()
        try {
            const indexes = await sql<{ indexname: string; indexdef: string }[]>`
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = 'public'
                  AND tablename IN ('outreach_provider_events', 'outreach_provider_cursors')
            `
            const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]))

            const eventUnique = byName.get('outreach_provider_events_provider_message_unique')
            expect(eventUnique).toContain('UNIQUE')
            expect(eventUnique).toContain('organization_id')
            expect(eventUnique).toContain('email_account_id')
            expect(eventUnique).toContain('provider')
            expect(eventUnique).toContain('provider_message_id')

            const cursorUnique = byName.get('outreach_provider_cursors_account_provider_unique')
            expect(cursorUnique).toContain('UNIQUE')
            expect(cursorUnique).toContain('email_account_id')
            expect(cursorUnique).toContain('provider')

            // Unprocessed-by-classification is the query both consumers run every tick.
            const pending = byName.get('idx_outreach_provider_events_pending')
            expect(pending).toContain('classification')
            expect(pending).toContain('processed_at IS NULL')

            expect(byName.get('idx_outreach_provider_events_org_received')).toContain('organization_id')

            // The real dedupe behaviour, not just the index definition.
            const insertEvent = (providerMessageId: string) => sql`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id,
                    classification, received_at
                ) VALUES (
                    ${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', ${providerMessageId},
                    'reply', now()
                )
                ON CONFLICT (organization_id, email_account_id, provider, provider_message_id)
                DO NOTHING
                RETURNING id
            `
            const first = await insertEvent('dedupe-1')
            expect(first).toHaveLength(1)
            const second = await insertEvent('dedupe-1')
            expect(second).toHaveLength(0)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('rejects unknown classifications, unknown providers, and blank provider keys', async () => {
        const sql = connect()
        try {
            await expect(sql`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id, classification, received_at
                ) VALUES (${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', 'bad-classification', 'spam', now())
            `).rejects.toThrow(/outreach_provider_events_classification_check/)

            await expect(sql`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id, classification, received_at
                ) VALUES (${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'carrier-pigeon', 'bad-provider', 'reply', now())
            `).rejects.toThrow(/outreach_provider_events_provider_check/)

            await expect(sql`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id, classification, received_at
                ) VALUES (${ORG_A}::uuid, ${ACCOUNT_A}::uuid, 'native', '   ', 'reply', now())
            `).rejects.toThrow(/outreach_provider_events_provider_message_id_check/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('refuses to bind an event to an account owned by another organization', async () => {
        const sql = connect()
        try {
            // ACCOUNT_A belongs to ORG_A. Claiming it under ORG_B must fail in the
            // database, not only in access.ts — Phase 18 proved matching cannot cross
            // an account/organization boundary and this staging table must not reopen it.
            await expect(sql`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id, classification, received_at
                ) VALUES (${ORG_B}::uuid, ${ACCOUNT_A}::uuid, 'native', 'cross-tenant', 'reply', now())
            `).rejects.toThrow(/outreach_provider_events_account_org_fkey/)

            await expect(sql`
                INSERT INTO outreach_provider_cursors (organization_id, email_account_id, provider)
                VALUES (${ORG_B}::uuid, ${ACCOUNT_A}::uuid, 'native')
            `).rejects.toThrow(/outreach_provider_cursors_account_org_fkey/)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('enables row level security with organization membership policies', async () => {
        const sql = connect()
        try {
            const tables = await sql<{ relname: string; relrowsecurity: boolean }[]>`
                SELECT relname, relrowsecurity
                FROM pg_class
                WHERE relnamespace = 'public'::regnamespace
                  AND relname IN ('outreach_provider_events', 'outreach_provider_cursors')
            `
            expect(tables).toHaveLength(2)
            for (const table of tables) {
                expect(table.relrowsecurity, table.relname).toBe(true)
            }

            const policies = await sql<{ tablename: string; policyname: string; qual: string | null }[]>`
                SELECT tablename, policyname, qual
                FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename IN ('outreach_provider_events', 'outreach_provider_cursors')
            `
            expect(policies.map((row) => row.policyname).sort()).toEqual([
                'outreach_provider_cursors_select',
                'outreach_provider_events_select',
            ])
            for (const policy of policies) {
                expect(policy.qual, policy.policyname).toContain('is_org_member')
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('keeps the Drizzle mirror aligned with every migration identifier', async () => {
        const schema = await readFile(path.join(process.cwd(), 'src', 'db', 'schema.ts'), 'utf8')

        for (const mapping of [
            "export const outreachProviderEvents = pgTable('outreach_provider_events'",
            "export const outreachProviderCursors = pgTable('outreach_provider_cursors'",
            "providerMessageId: text('provider_message_id')",
            "classification: text('classification')",
            "messageId: text('message_id')",
            "inReplyTo: text('in_reply_to')",
            "messageReferences: text('message_references')",
            "fromAddress: text('from_address')",
            "toAddresses: jsonb('to_addresses')",
            "textBody: text('text_body')",
            "htmlBody: text('html_body')",
            "headers: jsonb('headers')",
            "attachments: jsonb('attachments')",
            "receivedAt: timestamp('received_at')",
            "processedAt: timestamp('processed_at')",
            "processingError: text('processing_error')",
            "deltaCursor: text('delta_cursor')",
            "uidValidity: bigint('uid_validity'",
            "lastUid: bigint('last_uid'",
            "lastReceivedAt: timestamp('last_received_at')",
            "lastProviderMessageId: text('last_provider_message_id')",
            "leaseToken: uuid('lease_token')",
            "leaseExpiresAt: timestamp('lease_expires_at')",
            "lastSuccessAt: timestamp('last_success_at')",
            "lastError: text('last_error')",
            "retryAt: timestamp('retry_at')",
            'outreach_provider_events_provider_message_unique',
            'outreach_provider_cursors_account_provider_unique',
            'idx_outreach_provider_events_pending',
            'idx_outreach_provider_events_org_received',
            'OutreachProviderEvent',
            'OutreachProviderCursor',
        ]) {
            expect(schema, mapping).toContain(mapping)
        }
    })
})
