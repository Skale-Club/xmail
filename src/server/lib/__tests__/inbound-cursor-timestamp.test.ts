/**
 * Regression cover for the defect that made native outreach ingestion throw on
 * every tick, ~770 times a day, for every account.
 *
 * `outreach_provider_cursors.last_received_at` is a genuine `timestamp` column,
 * declared `Date` through `CursorRow` and `ProviderCursorState`, and production
 * still returned the string `"2026-08-29 04:16:43"` — Postgres's own text
 * rendering, not even ISO. `fetchPage` then handed it to `sqlTimestamp()`, which
 * called `.toISOString()` on a string and threw before a single message could be
 * read. Nothing caught it: every declaration in the chain said `Date`, and the
 * other suites mock the store rather than its SQL client.
 *
 * So this test asserts the mapping against a client that returns what the real
 * driver actually returned, rather than what its types promise.
 */
import { describe, expect, it } from 'vitest'
import { createSqlInboundEventStore, type InboundSqlClient } from '../outreach-inbound'

/** A client that answers every query with one fixed row. */
function clientReturning(row: unknown): InboundSqlClient {
    const client = (async () => [row]) as unknown as InboundSqlClient
    client.begin = async (fn) => fn(client)
    return client
}

const BASE_ROW = {
    delta_cursor: null,
    uid_validity: null,
    last_uid: null,
    last_provider_message_id: '852f8c20-b07d-462c-9a09-a8335ebe7bc1',
}

describe('loadCursor timestamp mapping', () => {
    it('turns the string production actually returned into a Date', async () => {
        const store = createSqlInboundEventStore(async () =>
            clientReturning({ ...BASE_ROW, last_received_at: '2026-08-29 04:16:43' }))

        const cursor = await store.loadCursor('account-1', 'native')

        expect(cursor?.lastReceivedAt).toBeInstanceOf(Date)
        expect(cursor?.lastReceivedAt?.toISOString())
            .toBe(new Date('2026-08-29 04:16:43').toISOString())
    })

    it('leaves a real Date untouched', async () => {
        const when = new Date('2026-08-29T04:16:43.000Z')
        const store = createSqlInboundEventStore(async () =>
            clientReturning({ ...BASE_ROW, last_received_at: when }))

        const cursor = await store.loadCursor('account-1', 'native')

        expect(cursor?.lastReceivedAt).toBeInstanceOf(Date)
        expect(cursor?.lastReceivedAt?.getTime()).toBe(when.getTime())
    })

    it('keeps null null, so a fresh account still starts from the beginning', async () => {
        const store = createSqlInboundEventStore(async () =>
            clientReturning({ ...BASE_ROW, last_received_at: null }))

        expect((await store.loadCursor('account-1', 'native'))?.lastReceivedAt).toBeNull()
    })

    it('degrades an unparseable value to null instead of failing the account', async () => {
        // Restarting a cursor re-reads mail that outreach_provider_events already
        // deduplicates. Throwing here would take the account's ingestion down —
        // which is the failure this whole change exists to remove.
        const store = createSqlInboundEventStore(async () =>
            clientReturning({ ...BASE_ROW, last_received_at: 'corrupt' }))

        expect((await store.loadCursor('account-1', 'native'))?.lastReceivedAt).toBeNull()
    })
})
