import { describe, expect, it } from 'vitest'
import {
    ConversationCursorError,
    decodeConversationCursor,
    encodeConversationCursor,
    fingerprintConversationFilters,
    type ConversationCursorFilters,
    type ConversationCursorPosition,
} from '../cursor'

// A canonical filter set the cursor is minted under. Any change to any field must
// invalidate a cursor minted under this set (filter-binding), so the client cannot
// replay a keyset position against a different query.
const BASE_FILTERS: ConversationCursorFilters = {
    organizationId: '21040000-0000-4000-8000-0000000000aa',
    unread: false,
    status: null,
    campaignId: null,
    emailAccountId: null,
    search: null,
}

const POSITION: ConversationCursorPosition = {
    lastMessageAt: '2026-07-16 12:00:00.123456',
    id: '21040000-0000-4000-8000-0000000000c1',
}

describe('conversation cursor — opaque, stable, keyset codec', () => {
    it('round-trips a position when the filter set is unchanged', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const decoded = decodeConversationCursor(cursor, BASE_FILTERS)
        expect(decoded).toEqual(POSITION)
    })

    it('is opaque and URL-safe: no raw filter values, no base64 padding/url-unsafe chars', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        // URL-safe base64url only.
        expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
        // The raw organization id / search text must never appear, even decoded — the
        // cursor binds to a fingerprint (hash) of the filters, not their plaintext.
        const rawJson = Buffer.from(cursor, 'base64url').toString('utf8')
        expect(rawJson).not.toContain(BASE_FILTERS.organizationId)
    })

    it('preserves ordering across equal timestamps via the unique id tie-breaker', () => {
        const a: ConversationCursorPosition = { lastMessageAt: '2026-07-16 12:00:00', id: '21040000-0000-4000-8000-0000000000a1' }
        const b: ConversationCursorPosition = { lastMessageAt: '2026-07-16 12:00:00', id: '21040000-0000-4000-8000-0000000000b2' }
        const ca = encodeConversationCursor(a, BASE_FILTERS)
        const cb = encodeConversationCursor(b, BASE_FILTERS)
        expect(ca).not.toEqual(cb)
        expect(decodeConversationCursor(ca, BASE_FILTERS).id).toBe(a.id)
        expect(decodeConversationCursor(cb, BASE_FILTERS).id).toBe(b.id)
    })

    it('rejects a cursor replayed under a DIFFERENT filter set (one field per case)', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const mutations: Array<Partial<ConversationCursorFilters>> = [
            { organizationId: '21040000-0000-4000-8000-0000000000bb' },
            { unread: true },
            { status: 'open' },
            { campaignId: '21040000-0000-4000-8000-0000000000dd' },
            { emailAccountId: '21040000-0000-4000-8000-0000000000ee' },
            { search: 'invoice' },
        ]
        for (const mutation of mutations) {
            expect(() => decodeConversationCursor(cursor, { ...BASE_FILTERS, ...mutation })).toThrow(ConversationCursorError)
        }
    })

    it('rejects malformed, non-base64, and tampered cursors', () => {
        expect(() => decodeConversationCursor('not a cursor!!', BASE_FILTERS)).toThrow(ConversationCursorError)
        expect(() => decodeConversationCursor('', BASE_FILTERS)).toThrow(ConversationCursorError)
        // Valid base64url of non-JSON garbage.
        const garbage = Buffer.from('this is not json', 'utf8').toString('base64url')
        expect(() => decodeConversationCursor(garbage, BASE_FILTERS)).toThrow(ConversationCursorError)
        // Valid base64url of JSON with the wrong shape.
        const wrongShape = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url')
        expect(() => decodeConversationCursor(wrongShape, BASE_FILTERS)).toThrow(ConversationCursorError)
    })

    it('rejects a cursor from an unknown version', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        payload.v = 999
        const bumped = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
        expect(() => decodeConversationCursor(bumped, BASE_FILTERS)).toThrow(ConversationCursorError)
    })

    it('rejects a cursor whose keyset fields have the wrong types', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        payload.i = 12345 // id should be a string
        const bad = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
        expect(() => decodeConversationCursor(bad, BASE_FILTERS)).toThrow(ConversationCursorError)
    })

    // W-1: the fingerprint is UNKEYED, so a caller can recompute it for their own filters and
    // craft a well-shaped cursor whose `t`/`i` are strings but not a real timestamp / UUID. Those
    // must be rejected in the codec (→ ConversationCursorError → 400) rather than passed through to
    // the query, where the ::timestamp / ::uuid cast throws and surfaces as a self-inflicted 500.
    it('rejects a valid-fingerprint cursor whose timestamp field is not a timestamp', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        expect(payload.f).toBe(fingerprintConversationFilters(BASE_FILTERS)) // fingerprint still matches
        payload.t = 'not-a-timestamp'
        const bad = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
        expect(() => decodeConversationCursor(bad, BASE_FILTERS)).toThrow(ConversationCursorError)
    })

    it('rejects a valid-fingerprint cursor whose id field is not a UUID', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        expect(payload.f).toBe(fingerprintConversationFilters(BASE_FILTERS))
        payload.i = 'not-a-uuid'
        const bad = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
        expect(() => decodeConversationCursor(bad, BASE_FILTERS)).toThrow(ConversationCursorError)
    })

    // N-1 (Phase 21 re-review residual of W-1): the original `t` guard used `Date.parse`, which is
    // MORE LENIENT than Postgres `::timestamp`. Calendar-invalid dates — Feb 30, Feb 29 of a
    // non-leap year, Apr 31 — parse in JS (it silently rolls them over: `2026-02-30` becomes Mar 2)
    // and so pass `Date.parse`, but Postgres rejects them ("date/time field value out of range"),
    // so the ${t}::timestamp cast throws downstream and surfaces the exact self-inflicted 500 W-1
    // targets. The codec must reject a calendar-invalid `t` itself (→ ConversationCursorError → 400).
    it('rejects a valid-fingerprint cursor whose timestamp is calendar-invalid (Date.parse-valid, Postgres-invalid)', () => {
        const cursor = encodeConversationCursor(POSITION, BASE_FILTERS)
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        expect(payload.f).toBe(fingerprintConversationFilters(BASE_FILTERS)) // fingerprint genuinely matches
        for (const calendarInvalid of ['2026-02-30 12:00:00', '2027-02-29 12:00:00', '2026-04-31 12:00:00']) {
            expect(Number.isNaN(Date.parse(calendarInvalid))).toBe(false) // Date.parse accepts it (the residual gap)
            const bad = Buffer.from(JSON.stringify({ ...payload, t: calendarInvalid }), 'utf8').toString('base64url')
            expect(() => decodeConversationCursor(bad, BASE_FILTERS)).toThrow(ConversationCursorError)
        }
    })

    // Positive counterpart: a genuine full-precision `last_message_at::text` value (microsecond
    // fractional seconds, space separator, no timezone) must still decode — the stricter `t` guard
    // must not reject real Postgres timestamp renderings.
    it('still decodes a real microsecond-precision last_message_at::text value', () => {
        const microsecond: ConversationCursorPosition = {
            lastMessageAt: '2026-07-16 12:00:00.123456',
            id: '21040000-0000-4000-8000-0000000000c1',
        }
        const cursor = encodeConversationCursor(microsecond, BASE_FILTERS)
        expect(decodeConversationCursor(cursor, BASE_FILTERS)).toEqual(microsecond)
    })
})
