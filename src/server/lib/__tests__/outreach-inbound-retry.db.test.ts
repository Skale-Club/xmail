import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

/**
 * W-5 (retry_at half) — a provider-stated backoff must actually pause the account.
 *
 * recordCursorRetry persists Graph's Retry-After onto outreach_provider_cursors.retry_at,
 * and the column is indexed for it, but loadCursor never selected it and the ingest loop
 * never consulted it. Ingestion therefore visited every verified account on every tick and
 * the backoff was pure bookkeeping — we re-hammered a mailbox that had just told us to stop,
 * which widens exactly the throttle window W-1 turned into a bogus activation.
 *
 * The behaviour lives entirely in a SQL predicate, so it is asserted against real Postgres.
 */

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const IDS = {
    user: '80000000-0000-4000-8000-000000000001',
    org: '80000000-0000-4000-8000-000000000002',
    due: '80000000-0000-4000-8000-000000000011',
    backedOff: '80000000-0000-4000-8000-000000000012',
}

const NOW = new Date('2026-07-16T12:00:00.000Z')

let sql: ReturnType<typeof postgres>
let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, path.join(process.cwd(), 'supabase', 'migrations', '039_outreach_provider_events.sql'))
    process.env.DATABASE_URL = testDatabaseUrl

    sql = postgres(testDatabaseUrl, { max: 2, prepare: false })
    await sql`INSERT INTO users (id, email) VALUES (${IDS.user}::uuid, 'retry@example.test') ON CONFLICT (id) DO NOTHING`
    await sql`
        INSERT INTO organizations (id, name, slug, owner_id)
        VALUES (${IDS.org}::uuid, 'Retry', 'retry-backoff', ${IDS.user}::uuid)
        ON CONFLICT (id) DO NOTHING
    `
    // Two verified native accounts, identical except for their cursor's backoff.
    await sql`
        INSERT INTO email_accounts (id, organization_id, email, provider, status) VALUES
            (${IDS.due}::uuid, ${IDS.org}::uuid, 'due@example.test', 'native', 'verified'),
            (${IDS.backedOff}::uuid, ${IDS.org}::uuid, 'backed-off@example.test', 'native', 'verified')
        ON CONFLICT (id) DO NOTHING
    `
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
    await sql.end({ timeout: 1 })
})

beforeEach(async () => {
    await sql`DELETE FROM outreach_provider_cursors WHERE organization_id = ${IDS.org}::uuid`
})

async function setRetryAt(emailAccountId: string, retryAt: Date | null): Promise<void> {
    await sql`
        INSERT INTO outreach_provider_cursors (organization_id, email_account_id, provider, retry_at, last_error)
        VALUES (${IDS.org}::uuid, ${emailAccountId}::uuid, 'native', ${retryAt}, 'provider_throttled')
        ON CONFLICT (organization_id, email_account_id, provider)
        DO UPDATE SET retry_at = EXCLUDED.retry_at
    `
}

async function ingestable(now: Date): Promise<string[]> {
    const { loadIngestableAccounts } = await import('../outreach-inbound-sources')
    const accounts = await loadIngestableAccounts(now)
    return accounts
        .filter((account) => account.organizationId === IDS.org)
        .map((account) => account.email)
        .sort()
}

describe('provider backoff is honoured by the ingest loop', () => {
    it('skips an account whose provider asked us to back off', async () => {
        await setRetryAt(IDS.backedOff, new Date(NOW.getTime() + 10 * 60_000))

        expect(await ingestable(NOW)).toEqual(['due@example.test'])
    })

    it('resumes the account once the backoff has elapsed', async () => {
        await setRetryAt(IDS.backedOff, new Date(NOW.getTime() + 10 * 60_000))

        expect(await ingestable(new Date(NOW.getTime() + 11 * 60_000)))
            .toEqual(['backed-off@example.test', 'due@example.test'])
    })

    it('ingests an account whose cursor carries no backoff', async () => {
        await setRetryAt(IDS.backedOff, null)

        expect(await ingestable(NOW)).toEqual(['backed-off@example.test', 'due@example.test'])
    })

    it('ingests accounts that have never synced and so have no cursor row at all', async () => {
        // The first tick of a new account must not be blocked by a missing cursor.
        expect(await ingestable(NOW)).toEqual(['backed-off@example.test', 'due@example.test'])
    })

    it('lets a successful sync clear the backoff, so a stuck value cannot strand an account', async () => {
        await setRetryAt(IDS.backedOff, new Date(NOW.getTime() + 10 * 60_000))
        expect(await ingestable(NOW)).toEqual(['due@example.test'])

        // saveCursor writes retry_at = NULL on every success. Proving it here is what makes
        // the skip above safe: the pause can only ever be as long as the value it carries.
        const { createSqlInboundEventStore } = await import('../outreach-inbound')
        const store = createSqlInboundEventStore(async () => sql as never)
        await store.saveCursor(IDS.backedOff, 'native', {
            deltaCursor: null,
            uidValidity: null,
            lastUid: null,
            lastReceivedAt: null,
            lastProviderMessageId: null,
        })

        expect(await ingestable(NOW)).toEqual(['backed-off@example.test', 'due@example.test'])
    })
})
