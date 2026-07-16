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
import {
    createSqlDispatchRepository,
    type DispatchOutreachInput,
    type DispatchSqlClient,
} from '../outreach-dispatch'

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
                'in_reply_to',
                'message_references',
                'capacity_reserved_at',
                'capacity_released_at',
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
                    'outreach_emails_origin_shape_check',
                    'outreach_emails_capacity_reservation_check'
                  )
            `
            expect(constraints.map((row) => row.conname).sort()).toEqual([
                'outreach_emails_attempts_check',
                'outreach_emails_capacity_reservation_check',
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
            "inReplyTo: text('in_reply_to')",
            "messageReferences: text('message_references')",
            "capacityReservedAt: timestamp('capacity_reserved_at')",
            "capacityReleasedAt: timestamp('capacity_released_at')",
            'outreach_emails_org_idempotency_unique',
            'idx_outreach_emails_dispatch_eligibility',
            'outreach_emails_origin_check',
            'outreach_emails_attempts_check',
            'outreach_emails_recipient_key_check',
            'outreach_emails_origin_shape_check',
            'outreach_emails_capacity_reservation_check',
        ]) {
            expect(schema).toContain(mapping)
        }
    })

    it('atomically reclaims pre-dispatch leases and holds post-dispatch ambiguity', async () => {
        assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
        const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
        const userId = '10000000-0000-4000-8000-000000000001'
        const organizationId = '10000000-0000-4000-8000-000000000002'
        const accountId = '10000000-0000-4000-8000-000000000003'
        try {
            await sql`
                INSERT INTO users (id, email)
                VALUES (${userId}::uuid, 'dispatch-owner@example.test')
                ON CONFLICT (id) DO NOTHING
            `
            await sql`
                INSERT INTO organizations (id, name, slug, owner_id)
                VALUES (${organizationId}::uuid, 'Dispatch Test', 'dispatch-test', ${userId}::uuid)
                ON CONFLICT (id) DO NOTHING
            `
            await sql`
                INSERT INTO email_accounts (
                    id, organization_id, email, smtp_host, smtp_username, smtp_password, status
                ) VALUES (
                    ${accountId}::uuid, ${organizationId}::uuid, 'sender@example.test',
                    'localhost', 'sender', 'not-a-real-secret', 'verified'
                )
                ON CONFLICT (id) DO NOTHING
            `

            const repository = createSqlDispatchRepository(async () => sql as unknown as DispatchSqlClient)
            const baseInput: DispatchOutreachInput = {
                origin: 'manual',
                organizationId,
                emailAccountId: accountId,
                idempotencyKey: 'manual:lease-recovery',
                to: 'recipient@example.test',
                subject: 'Lease recovery',
                text: 'No provider is called by this repository test.',
            }
            const now = new Date('2026-07-16T12:00:00.000Z')
            const first = await repository.claim(baseInput, {
                now,
                leaseToken: '10000000-0000-4000-8000-000000000010',
                leaseExpiresAt: new Date(now.getTime() + 60_000),
            })
            expect(first.kind).toBe('claimed')

            const contended = await repository.claim(baseInput, {
                now: new Date(now.getTime() + 1_000),
                leaseToken: '10000000-0000-4000-8000-000000000011',
                leaseExpiresAt: new Date(now.getTime() + 61_000),
            })
            expect(contended.kind).toBe('in_progress')

            const reclaimed = await repository.claim(baseInput, {
                now: new Date(now.getTime() + 61_000),
                leaseToken: '10000000-0000-4000-8000-000000000012',
                leaseExpiresAt: new Date(now.getTime() + 121_000),
            })
            expect(reclaimed.kind).toBe('claimed')
            if (reclaimed.kind !== 'claimed') throw new Error('expected reclaimed lease')

            await expect(repository.startDispatch(reclaimed, new Date(now.getTime() + 62_000), {
                account: {
                    id: accountId,
                    organizationId,
                    status: 'verified',
                    dailySendLimit: 50,
                    currentDailySent: 0,
                    warmupEnabled: false,
                    warmupDays: 14,
                    warmupCurrentDay: 14,
                    minMinutesBetweenEmails: 0,
                    lastSentAt: null,
                },
                dailyLimit: 50,
            }))
                .resolves.toEqual({ attemptCount: 1, maxAttempts: 3 })

            const held = await repository.claim(baseInput, {
                now: new Date(now.getTime() + 122_000),
                leaseToken: '10000000-0000-4000-8000-000000000013',
                leaseExpiresAt: new Date(now.getTime() + 182_000),
            })
            expect(held.kind).toBe('held')

            const [row] = await sql<{ status: string; last_error_code: string | null }[]>`
                SELECT status::text AS status, last_error_code
                FROM outreach_emails
                WHERE organization_id = ${organizationId}::uuid
                  AND idempotency_key = ${baseInput.idempotencyKey}
            `
            expect(row).toEqual({ status: 'held', last_error_code: 'ambiguous_stale_lease' })
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('atomically reserves one shared account slot across distinct dispatch origins', async () => {
        assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
        const sql = postgres(testDatabaseUrl, { max: 2, prepare: false })
        const userId = '20000000-0000-4000-8000-000000000001'
        const organizationId = '20000000-0000-4000-8000-000000000002'
        const accountId = '20000000-0000-4000-8000-000000000003'
        const now = new Date('2026-07-16T14:00:00.000Z')
        try {
            await sql`INSERT INTO users (id, email) VALUES (${userId}::uuid, 'capacity-owner@example.test') ON CONFLICT (id) DO NOTHING`
            await sql`
                INSERT INTO organizations (id, name, slug, owner_id)
                VALUES (${organizationId}::uuid, 'Capacity Test', 'capacity-test', ${userId}::uuid)
                ON CONFLICT (id) DO NOTHING
            `
            await sql`
                INSERT INTO email_accounts (
                    id, organization_id, email, smtp_host, smtp_username, smtp_password,
                    status, daily_send_limit, current_daily_sent, min_minutes_between_emails
                ) VALUES (
                    ${accountId}::uuid, ${organizationId}::uuid, 'capacity@example.test',
                    'localhost', 'capacity', 'not-a-real-secret', 'verified', 1, 0, 0
                ) ON CONFLICT (id) DO NOTHING
            `

            const repository = createSqlDispatchRepository(async () => sql as unknown as DispatchSqlClient)
            const makeInput = (key: string): DispatchOutreachInput => ({
                origin: 'manual', organizationId, emailAccountId: accountId,
                idempotencyKey: key, to: 'recipient@example.test', subject: key, text: key,
            })
            const claims = await Promise.all([
                repository.claim(makeInput('manual:capacity-a'), {
                    now, leaseToken: '20000000-0000-4000-8000-000000000010',
                    leaseExpiresAt: new Date(now.getTime() + 60_000),
                }),
                repository.claim(makeInput('manual:capacity-b'), {
                    now, leaseToken: '20000000-0000-4000-8000-000000000011',
                    leaseExpiresAt: new Date(now.getTime() + 60_000),
                }),
            ])
            const claimedRows = claims.filter((claim): claim is Extract<typeof claim, { kind: 'claimed' }> => claim.kind === 'claimed')
            expect(claimedRows).toHaveLength(2)
            const capacity = {
                account: {
                    id: accountId, organizationId, status: 'verified' as const,
                    dailySendLimit: 1, currentDailySent: 0, warmupEnabled: false,
                    warmupDays: 14, warmupCurrentDay: 14,
                    minMinutesBetweenEmails: 0, lastSentAt: null,
                },
                dailyLimit: 1,
            }
            const starts = await Promise.all(claimedRows.map((claim) => repository.startDispatch(claim, now, capacity)))
            expect(starts.filter(Boolean)).toHaveLength(1)

            const [account] = await sql<{ current_daily_sent: number }[]>`
                SELECT current_daily_sent FROM email_accounts WHERE id = ${accountId}::uuid
            `
            expect(account.current_daily_sent).toBe(1)

            const winnerIndex = starts.findIndex(Boolean)
            await repository.finalizeFailure(claimedRows[winnerIndex], {
                status: 'failed',
                failure: {
                    code: 'smtp_421', classification: 'transient', acceptance: 'rejected',
                    retryable: true, message: 'known rejection',
                },
                nextAttemptAt: new Date(now.getTime() + 60_000),
                now,
            })
            const [released] = await sql<{ current_daily_sent: number }[]>`
                SELECT current_daily_sent FROM email_accounts WHERE id = ${accountId}::uuid
            `
            expect(released.current_daily_sent).toBe(0)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
