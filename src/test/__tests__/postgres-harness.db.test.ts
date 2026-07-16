import { existsSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

describe('PostgreSQL safety guard', () => {
    it('rejects a missing per-run guard', () => {
        expect(() => assertSafeTestDatabaseUrl(
            'postgresql://operator:secret@localhost:5432/xmail_test',
            { runGuard: undefined },
        )).toThrow(/per-run test guard/i)
    })

    it('rejects non-PostgreSQL URLs', () => {
        expect(() => assertSafeTestDatabaseUrl(
            'https://localhost/xmail_test',
            { runGuard },
        )).toThrow(/non-PostgreSQL/i)
    })

    it('rejects a remote production-like URL', () => {
        expect(() => assertSafeTestDatabaseUrl(
            'postgresql://operator:secret@db.example.com:5432/xmail_test',
            { runGuard },
        )).toThrow(/non-loopback/i)
    })

    it('rejects the configured application database URL', () => {
        const configuredDatabaseUrl = 'postgresql://operator:secret@localhost:5432/xmail_test_prod'
        expect(() => assertSafeTestDatabaseUrl(configuredDatabaseUrl, {
            runGuard,
            configuredDatabaseUrl,
        })).toThrow(/DATABASE_URL/i)
    })

    it('rejects the current DATABASE_URL when one is configured', () => {
        if (!process.env.DATABASE_URL) return

        expect(() => assertSafeTestDatabaseUrl(process.env.DATABASE_URL, {
            runGuard,
            configuredDatabaseUrl: process.env.DATABASE_URL,
        })).toThrow()
    })

    it('rejects a local database name without a test marker', () => {
        expect(() => assertSafeTestDatabaseUrl(
            'postgresql://operator:secret@localhost:5432/xmail',
            { runGuard },
        )).toThrow(/test marker/i)
    })

    it('accepts the generated disposable database URL', () => {
        expect(() => assertSafeTestDatabaseUrl(testDatabaseUrl, {
            runGuard,
            configuredDatabaseUrl: process.env.DATABASE_URL,
        })).not.toThrow()
    })
})

describe('disposable PostgreSQL lifecycle', () => {
    it('runs against an isolated database with applied migrations', async () => {
        assertSafeTestDatabaseUrl(testDatabaseUrl, {
            runGuard,
            configuredDatabaseUrl: process.env.DATABASE_URL,
        })
        const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
        try {
            const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`
            const [table] = await sql<{ exists: boolean }[]>`
                SELECT to_regclass('public.outreach_emails') IS NOT NULL AS exists
            `
            expect(database.name.toLowerCase()).toContain('test')
            expect(table.exists).toBe(true)
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('applies migration 038 twice when it exists', async () => {
        const migrationPath = path.join(
            process.cwd(),
            'supabase',
            'migrations',
            '038_outreach_dispatch_state_machine.sql',
        )
        if (!existsSync(migrationPath)) return

        assertSafeTestDatabaseUrl(testDatabaseUrl, {
            runGuard,
            configuredDatabaseUrl: process.env.DATABASE_URL,
        })
        const target = {
            databaseUrl: testDatabaseUrl,
            runGuard,
            configuredDatabaseUrl: process.env.DATABASE_URL,
        }
        await applyMigrationFile(target, migrationPath)
        await applyMigrationFile(target, migrationPath)

        const sql = postgres(testDatabaseUrl, { max: 1, prepare: false })
        try {
            const columns = await sql<{ column_name: string }[]>`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'outreach_emails'
                  AND column_name IN ('origin', 'idempotency_key', 'lease_expires_at', 'dispatch_started_at')
            `
            expect(columns.map((row) => row.column_name).sort()).toEqual([
                'dispatch_started_at',
                'idempotency_key',
                'lease_expires_at',
                'origin',
            ])
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
