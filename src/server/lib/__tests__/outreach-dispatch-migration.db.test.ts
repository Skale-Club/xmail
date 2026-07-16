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

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '038_outreach_dispatch_state_machine.sql',
)

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }

    await applyMigrationFile(target, migrationPath)
    await applyMigrationFile(target, migrationPath)
})

describe('outreach dispatch migration 038', () => {
    it('adds the durable state columns with safe defaults and nullability', async () => {
        assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
        const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
        try {
            const columns = await sql<{
                column_name: string
                is_nullable: 'YES' | 'NO'
                column_default: string | null
            }[]>`
                SELECT column_name, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'outreach_emails'
            `
            const byName = new Map(columns.map((column) => [column.column_name, column]))

            expect(byName.get('origin')).toMatchObject({ is_nullable: 'NO', column_default: "'campaign'::text" })
            expect(byName.get('idempotency_key')?.is_nullable).toBe('NO')
            expect(byName.get('to_address')?.is_nullable).toBe('NO')
            expect(byName.get('attempt_count')).toMatchObject({ is_nullable: 'NO', column_default: '0' })
            expect(byName.get('max_attempts')).toMatchObject({ is_nullable: 'NO', column_default: '3' })

            for (const name of [
                'next_attempt_at',
                'lease_token',
                'lease_expires_at',
                'dispatch_started_at',
                'last_attempt_at',
                'last_error_code',
            ]) {
                expect(byName.get(name)?.is_nullable).toBe('YES')
            }

            for (const name of ['campaign_id', 'campaign_lead_id', 'sequence_step_id', 'tracking_token']) {
                expect(byName.get(name)?.is_nullable).toBe('YES')
            }
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('installs drift-sensitive shape, attempt, idempotency, and eligibility rules', async () => {
        assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
        const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
        try {
            const constraints = await sql<{ conname: string; definition: string }[]>`
                SELECT conname, pg_get_constraintdef(oid) AS definition
                FROM pg_constraint
                WHERE conrelid = 'public.outreach_emails'::regclass
                  AND conname IN (
                    'outreach_emails_origin_check',
                    'outreach_emails_attempts_check',
                    'outreach_emails_recipient_key_check',
                    'outreach_emails_origin_shape_check'
                  )
            `
            expect(constraints.map((row) => row.conname).sort()).toEqual([
                'outreach_emails_attempts_check',
                'outreach_emails_origin_check',
                'outreach_emails_origin_shape_check',
                'outreach_emails_recipient_key_check',
            ])
            expect(constraints.find((row) => row.conname === 'outreach_emails_origin_shape_check')?.definition)
                .toContain("origin = 'campaign'::text")
            expect(constraints.find((row) => row.conname === 'outreach_emails_attempts_check')?.definition)
                .toContain('attempt_count <= max_attempts')

            const indexes = await sql<{ indexname: string; indexdef: string }[]>`
                SELECT indexname, indexdef
                FROM pg_indexes
                WHERE schemaname = 'public'
                  AND tablename = 'outreach_emails'
                  AND indexname IN (
                    'outreach_emails_org_idempotency_unique',
                    'outreach_emails_campaign_lead_step_unique',
                    'idx_outreach_emails_dispatch_eligibility'
                  )
            `
            expect(indexes.map((row) => row.indexname).sort()).toEqual([
                'idx_outreach_emails_dispatch_eligibility',
                'outreach_emails_campaign_lead_step_unique',
                'outreach_emails_org_idempotency_unique',
            ])
            expect(indexes.find((row) => row.indexname === 'outreach_emails_org_idempotency_unique')?.indexdef)
                .toContain('UNIQUE')
            expect(indexes.find((row) => row.indexname === 'idx_outreach_emails_dispatch_eligibility')?.indexdef)
                .toContain("status = ANY (ARRAY['queued'::message_status, 'failed'::message_status])")
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('keeps the Drizzle mirror aligned with every migration identifier', async () => {
        const schema = await readFile(path.join(process.cwd(), 'src', 'db', 'schema.ts'), 'utf8')

        for (const mapping of [
            "origin: text('origin')",
            "idempotencyKey: text('idempotency_key')",
            "toAddress: text('to_address')",
            "attemptCount: integer('attempt_count')",
            "maxAttempts: integer('max_attempts')",
            "nextAttemptAt: timestamp('next_attempt_at')",
            "leaseToken: uuid('lease_token')",
            "leaseExpiresAt: timestamp('lease_expires_at')",
            "dispatchStartedAt: timestamp('dispatch_started_at')",
            "lastAttemptAt: timestamp('last_attempt_at')",
            "lastErrorCode: text('last_error_code')",
            'outreach_emails_org_idempotency_unique',
            'idx_outreach_emails_dispatch_eligibility',
            'outreach_emails_origin_check',
            'outreach_emails_attempts_check',
            'outreach_emails_recipient_key_check',
            'outreach_emails_origin_shape_check',
        ]) {
            expect(schema).toContain(mapping)
        }
    })
})
