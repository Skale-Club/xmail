/**
 * W-2: the operator backfill and the scheduled cron materializer must be MUTUALLY EXCLUSIVE.
 *
 * Both jobs reuse the SAME live idempotent materializers over READ COMMITTED transactions. If they
 * ran concurrently, a header-less-root thread could be split into two conversations: one job's E2
 * reply cannot see the other job's uncommitted E1 root, so it derives an rfc:<E1> thread_key while
 * E1 lands under its generated gen:<uuid> key. The fix makes the backfill acquire the CRON
 * MATERIALIZER's advisory lock (not a distinct one), so only one of {cron, backfill} ever holds it.
 *
 * These tests lock that invariant two ways:
 *   1. structurally — the backfill's lock NAME is the materializer's, so computeLockKey maps both to
 *      one key (they contend on the same lock);
 *   2. behaviorally — while the materializer lock is held, the backfill runner skips (its
 *      pg_try_advisory_lock returns false), and it runs only once the lock is released.
 *
 * Shared disposable database: apply the tables the backfill scans in beforeAll; this suite seeds no
 * rows (it scopes to an empty org), so there is nothing to clean up.
 */
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import { MATERIALIZE_LOCK_NAME } from '../materializeUnifiedInbox'
import { BACKFILL_LOCK_NAME, runBackfillUnifiedInboxWithLock } from '../backfillUnifiedInbox'
import type { UnifiedInboxSql } from '../../lib/unified-inbox/ingest'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations')
const dispatchMigration = path.join(migrationsDir, '038_outreach_dispatch_state_machine.sql')
const providerEventsMigration = path.join(migrationsDir, '039_outreach_provider_events.sql')
const unifiedInboxMigration = path.join(migrationsDir, '041_unified_inbox_foundation.sql')

// A distinct org with no seeded rows: the backfill scans it to a zero-row result (still non-null),
// so a non-null return unambiguously proves the locked body executed.
const ORG = '2102cc00-0000-4000-8000-0000000000a1'

// Imported lazily (after DATABASE_URL is set) because cron-lock and the db module read it at import.
let computeLockKey: (name: string) => bigint
let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, dispatchMigration)
    await applyMigrationFile(target, providerEventsMigration)
    await applyMigrationFile(target, unifiedInboxMigration)

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    computeLockKey = (await import('../../lib/cron-lock')).computeLockKey
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
})

describe('unified inbox job locks — backfill/cron mutual exclusion (W-2)', () => {
    it('runs the backfill under the SAME advisory lock as the cron materializer', () => {
        // The lock is keyed purely by name, so sharing the name is what makes the two jobs contend
        // on one key. This guards against a future regression reintroducing a distinct backfill lock.
        expect(BACKFILL_LOCK_NAME).toBe(MATERIALIZE_LOCK_NAME)
        expect(computeLockKey(BACKFILL_LOCK_NAME)).toBe(computeLockKey(MATERIALIZE_LOCK_NAME))
    })

    it('skips the backfill while the materializer lock is held, and runs it once released', async () => {
        const holder = postgres(testDatabaseUrl!, { max: 1, prepare: false, onnotice: () => {} })
        const work = postgres(testDatabaseUrl!, { max: 1, prepare: false, onnotice: () => {} })
        const key = computeLockKey(MATERIALIZE_LOCK_NAME).toString()
        const deps = {
            sql: work as unknown as UnifiedInboxSql,
            organizationId: ORG,
            now: () => new Date('2026-07-16T12:00:00Z'),
        }
        try {
            // Simulate the cron materializer (or a peer backfill) holding the lock on its session.
            await holder`SELECT pg_advisory_lock(${key}::bigint)`

            // The operator backfill must NOT run concurrently: runWithLock's pg_try_advisory_lock
            // returns false, so the runner returns null (skipped — the locked body never executed).
            const skipped = await runBackfillUnifiedInboxWithLock(deps)
            expect(skipped).toBeNull()

            // Release the lock; now the backfill acquires it and runs to a (zero-row) result.
            await holder`SELECT pg_advisory_unlock(${key}::bigint)`
            const ran = await runBackfillUnifiedInboxWithLock(deps)
            expect(ran).not.toBeNull()
        } finally {
            await holder.end({ timeout: 1 })
            await work.end({ timeout: 1 })
        }
    })
})
