import { describe, expect, it } from 'vitest'
import { buildSearchQuery, dateRangeStart, EMPTY_SEARCH_FILTERS } from './search-query'

const now = new Date(2026, 9, 6, 15, 0, 0) // 2026-10-06 local

describe('buildSearchQuery', () => {
    it('returns the free text untouched when no filter is set', () => {
        expect(buildSearchQuery({ ...EMPTY_SEARCH_FILTERS, query: 'dataforseo' }, now)).toBe('dataforseo')
    })

    it('emits operators, quoting values that contain spaces', () => {
        const query = buildSearchQuery({
            ...EMPTY_SEARCH_FILTERS,
            query: 'invoice',
            from: 'Ana Souza',
            to: 'bob@x.com',
            subject: 'final proposal',
            hasAttachment: true,
        }, now)
        expect(query).toBe('invoice from:"Ana Souza" to:bob@x.com subject:"final proposal" has:attachment')
    })

    it('maps relative date ranges to an after: day', () => {
        expect(dateRangeStart('today', now)).toBe('2026-10-06')
        expect(dateRangeStart('week', now)).toBe('2026-09-29')
        expect(dateRangeStart('all', now)).toBeNull()
        expect(buildSearchQuery({ ...EMPTY_SEARCH_FILTERS, dateRange: 'month' }, now)).toBe('after:2026-09-06')
    })

    it('expresses "no attachments" and strips quotes from values', () => {
        expect(buildSearchQuery({ ...EMPTY_SEARCH_FILTERS, hasAttachment: false, from: 'a"b' }, now))
            .toBe('from:ab has:noattachment')
    })
})
