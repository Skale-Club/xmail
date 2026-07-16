import { describe, expect, it } from 'vitest'
import {
    ConversationCursorError,
    decodeConversationCursor,
    encodeConversationCursor,
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
})
