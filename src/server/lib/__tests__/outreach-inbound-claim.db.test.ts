import path from 'node:path'
import postgres from 'postgres'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'
import {
    consumeClassifiedEvents,
    createSqlInboundEventStore,
    type InboundSqlClient,
} from '../outreach-inbound'

/**
 * C-2 — the claim must not outlive a crash.
 *
 * `claimPending` committed `processed_at = now()` for a whole batch as a standalone
 * autocommit statement, then `consumeClassifiedEvents` looped calling the handler. The
 * claim was durable before any side effect existed and nothing un-claimed a row.
 *
 * Concretely: a bounce tick claims 200 events and commits processed_at for all 200. The
 * container is SIGKILLed 3 events in — routine, because build-deploy.yml's blue-green
 * rollout stops `xmail` on every push to main. On restart the claim filters
 * `processed_at IS NULL`, so the other 197 are invisible forever: markAsBounced never
 * runs, leads stay `sent`, no suppression row is written, and every hard-bounced address
 * keeps receiving its sequence.
 *
 * These assertions only mean anything against a real database — the guarantee is a
 * transactional one, and an in-memory fake cannot fail the way Postgres does.
 */

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]
const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '039_outreach_provider_events.sql',
)

const ORG = '50000000-0000-4000-8000-000000000001'
const ACCOUNT = '50000000-0000-4000-8000-000000000011'
const OWNER = '50000000-0000-4000-8000-000000000021'

function connect() {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    return postgres(testDatabaseUrl, { max: 2, prepare: false, onnotice: () => {} })
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    // The baseline schema is already applied once by postgres-global-setup; re-applying it
    // here races the other .db suites for the same catalog locks.
    const target = { databaseUrl: testDatabaseUrl, runGuard }
    await applyMigrationFile(target, migrationPath)

    const sql = connect()
    try {
        await sql`INSERT INTO users (id, email) VALUES (${OWNER}::uuid, 'claim-owner@example.test') ON CONFLICT (id) DO NOTHING`
        await sql`
            INSERT INTO organizations (id, name, slug, owner_id)
            VALUES (${ORG}::uuid, 'Claim Test', 'claim-test', ${OWNER}::uuid)
            ON CONFLICT (id) DO NOTHING
        `
        await sql`
            INSERT INTO email_accounts (id, organization_id, email, smtp_host, smtp_username, smtp_password, status)
            VALUES (${ACCOUNT}::uuid, ${ORG}::uuid, 'claim@example.test', 'localhost', 'claim', 'not-a-real-secret', 'verified')
            ON CONFLICT (id) DO NOTHING
        `
    } finally {
        await sql.end({ timeout: 1 })
    }
})

async function seedEvents(
    sql: postgres.Sql,
    events: Array<{ key: string; classification: string }>,
): Promise<void> {
    for (const [index, event] of events.entries()) {
        await sql`
            INSERT INTO outreach_provider_events (
                organization_id, email_account_id, provider, provider_message_id,
                classification, from_address, subject, text_body, received_at
            ) VALUES (
                ${ORG}::uuid, ${ACCOUNT}::uuid, 'native', ${event.key},
                ${event.classification}, 'lead@prospect.test', 'subject', 'body',
                ${new Date(Date.UTC(2026, 6, 16, 10, index))}
            )
        `
    }
}

function storeOn(sql: postgres.Sql) {
    return createSqlInboundEventStore(async () => sql as unknown as InboundSqlClient)
}

beforeEach(async () => {
    const sql = connect()
    try {
        await sql`DELETE FROM outreach_provider_events WHERE organization_id = ${ORG}::uuid`
    } finally {
        await sql.end({ timeout: 1 })
    }
})

describe('inbound event claim durability', () => {
    it('does not commit processed_at before the side effect has succeeded', async () => {
        // The exact defect. An independent connection is what survives a crash: whatever
        // it can see committed is what a restarted container inherits. If it sees the row
        // already processed while the handler is still running, then SIGKILL at this
        // instant loses the bounce forever with no processing_error to find it by.
        const sql = connect()
        const observer = connect()
        try {
            await seedEvents(sql, [{ key: 'crash-1', classification: 'bounce' }])

            let visibleDuringHandle: Date | null | undefined
            await consumeClassifiedEvents({
                store: storeOn(sql),
                classification: 'bounce',
                handle: async () => {
                    const rows = await observer<{ processed_at: Date | null }[]>`
                        SELECT processed_at FROM outreach_provider_events
                        WHERE provider_message_id = 'crash-1'
                    `
                    visibleDuringHandle = rows[0]?.processed_at
                },
            })

            expect(
                visibleDuringHandle,
                'a crash here would leave the event marked processed but never acted on',
            ).toBeNull()

            // ...and once the side effect really did succeed, it is durably processed.
            const after = await observer<{ processed_at: Date | null }[]>`
                SELECT processed_at FROM outreach_provider_events WHERE provider_message_id = 'crash-1'
            `
            expect(after[0].processed_at).not.toBeNull()
        } finally {
            await sql.end({ timeout: 1 })
            await observer.end({ timeout: 1 })
        }
    })

    it('does not claim a whole batch upfront, so a mid-loop death loses nothing', async () => {
        // The 200-event scenario in miniature. A worker takes a batch and is SIGKILLed
        // partway through. Whatever the batch claim already committed is what is lost, so
        // the test asks: while event 1 is being handled, what does a restarted container
        // see? Every event it has not yet acted on must still be pending.
        const sql = connect()
        const observer = connect()
        try {
            await seedEvents(sql, [
                { key: 'batch-1', classification: 'bounce' },
                { key: 'batch-2', classification: 'bounce' },
                { key: 'batch-3', classification: 'bounce' },
                { key: 'batch-4', classification: 'bounce' },
                { key: 'batch-5', classification: 'bounce' },
            ])

            let pendingDuringFirstHandle: string[] = []
            await consumeClassifiedEvents({
                store: storeOn(sql),
                classification: 'bounce',
                handle: async (event) => {
                    if (event.providerMessageId !== 'batch-1') return
                    const rows = await observer<{ provider_message_id: string }[]>`
                        SELECT provider_message_id FROM outreach_provider_events
                        WHERE organization_id = ${ORG}::uuid AND processed_at IS NULL
                        ORDER BY received_at
                    `
                    pendingDuringFirstHandle = rows.map((row) => row.provider_message_id)
                },
            })

            // Under the batch claim every one of these was already committed as processed
            // while only batch-1 had run, so a SIGKILL here silently dropped four bounces.
            expect(pendingDuringFirstHandle).toEqual(['batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5'])
        } finally {
            await sql.end({ timeout: 1 })
            await observer.end({ timeout: 1 })
        }
    })

    it('retries an event whose handler failed, instead of burying the error on a processed row', async () => {
        const sql = connect()
        try {
            await seedEvents(sql, [{ key: 'transient-1', classification: 'bounce' }])
            const store = storeOn(sql)

            const failing = await consumeClassifiedEvents({
                store,
                classification: 'bounce',
                handle: async () => { throw new Error('database unavailable') },
            })
            expect(failing).toMatchObject({ claimed: 1, processed: 0, failed: 1 })

            const row = await sql<{ processed_at: Date | null; processing_error: string | null }[]>`
                SELECT processed_at, processing_error FROM outreach_provider_events
                WHERE provider_message_id = 'transient-1'
            `
            expect(row[0].processing_error).toContain('database unavailable')
            // A transient failure must not consume the event. Marking it processed was the
            // second half of C-2: the error was stamped on an already-claimed row, so the
            // bounce was never applied and never retried.
            expect(row[0].processed_at).toBeNull()

            // The backoff keeps a poison event from re-running every tick; age the row past
            // it to prove the retry actually happens rather than merely being pending.
            await sql`
                UPDATE outreach_provider_events SET updated_at = now() - interval '1 hour'
                WHERE provider_message_id = 'transient-1'
            `

            const retried = await consumeClassifiedEvents({
                store,
                classification: 'bounce',
                handle: async () => {},
            })
            expect(retried).toMatchObject({ claimed: 1, processed: 1 })
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('backs a failed event off rather than spinning on it every tick', async () => {
        const sql = connect()
        try {
            await seedEvents(sql, [{ key: 'poison-1', classification: 'bounce' }])
            const store = storeOn(sql)

            await consumeClassifiedEvents({
                store,
                classification: 'bounce',
                handle: async () => { throw new Error('poison') },
            })

            // Immediately after failing, the same tick must not pick it up again.
            const immediate = await consumeClassifiedEvents({
                store,
                classification: 'bounce',
                handle: async () => {},
            })
            expect(immediate).toMatchObject({ claimed: 0 })
        } finally {
            await sql.end({ timeout: 1 })
        }
    })

    it('never hands one event to two concurrent workers', async () => {
        // Preserved from the original claim: FOR UPDATE SKIP LOCKED still means a second
        // worker skips a row that is already leased rather than duplicating its side effect.
        const first = connect()
        const second = connect()
        try {
            await seedEvents(first, [{ key: 'race-1', classification: 'bounce' }])

            const handledBy: string[] = []
            let releaseFirst: (() => void) | undefined
            const firstEntered = new Promise<void>((resolve) => {
                releaseFirst = resolve
            })
            let firstIsInside: (() => void) | undefined
            const insideSignal = new Promise<void>((resolve) => {
                firstIsInside = resolve
            })

            const workerA = consumeClassifiedEvents({
                store: storeOn(first),
                classification: 'bounce',
                handle: async () => {
                    handledBy.push('A')
                    firstIsInside?.()
                    await firstEntered
                },
            })

            await insideSignal
            // While A holds its claim, B runs a full tick and must find nothing.
            const resultB = await consumeClassifiedEvents({
                store: storeOn(second),
                classification: 'bounce',
                handle: async () => { handledBy.push('B') },
            })
            releaseFirst?.()
            await workerA

            expect(resultB.claimed).toBe(0)
            expect(handledBy).toEqual(['A'])
        } finally {
            await first.end({ timeout: 1 })
            await second.end({ timeout: 1 })
        }
    })

    it('never lets a reply consumer claim a bounce-classified row', async () => {
        const sql = connect()
        try {
            await seedEvents(sql, [
                { key: 'dsn-1', classification: 'bounce' },
                { key: 'human-1', classification: 'reply' },
            ])
            const store = storeOn(sql)

            const seenByReplies: string[] = []
            await consumeClassifiedEvents({
                store,
                classification: 'reply',
                handle: async (event) => { seenByReplies.push(event.providerMessageId) },
            })

            // Not an equality assertion: the claim is deliberately org-wide, so a sibling
            // suite's reply rows may legitimately show up here. The guarantee under test is
            // about classification, not tenancy.
            expect(seenByReplies).toContain('human-1')
            expect(seenByReplies).not.toContain('dsn-1')
        } finally {
            await sql.end({ timeout: 1 })
        }
    })
})
