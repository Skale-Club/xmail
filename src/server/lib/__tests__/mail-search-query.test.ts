import { describe, expect, it } from 'vitest'
import {
    containsPattern,
    escapeLikePattern,
    hasSearchCriteria,
    parseMailSearchQuery,
    parseSearchDate,
} from '../mail-search-query'

describe('parseMailSearchQuery', () => {
    it('treats plain words as ANDed free-text terms', () => {
        const parsed = parseMailSearchQuery('dataforseo invoice')
        expect(parsed.terms).toEqual(['dataforseo', 'invoice'])
        expect(hasSearchCriteria(parsed)).toBe(true)
    })

    it('parses from/to/subject operators, case-insensitively', () => {
        const parsed = parseMailSearchQuery('FROM:ana@x.com to:bob@y.com Subject:orcamento relatorio')
        expect(parsed.from).toEqual(['ana@x.com'])
        expect(parsed.to).toEqual(['bob@y.com'])
        expect(parsed.subject).toEqual(['orcamento'])
        expect(parsed.terms).toEqual(['relatorio'])
    })

    it('supports quoted operator values and quoted phrases', () => {
        const parsed = parseMailSearchQuery('from:"Ana Souza" subject:"proposta final" "pagamento em aberto"')
        expect(parsed.from).toEqual(['Ana Souza'])
        expect(parsed.subject).toEqual(['proposta final'])
        expect(parsed.terms).toEqual(['pagamento em aberto'])
    })

    it('parses has:attachment, is:* and in:<folder>', () => {
        const parsed = parseMailSearchQuery('has:attachment is:unread is:starred in:Trash')
        expect(parsed.hasAttachment).toBe(true)
        expect(parsed.unread).toBe(true)
        expect(parsed.starred).toBe(true)
        expect(parsed.folders).toEqual(['trash'])
        expect(parseMailSearchQuery('is:read').unread).toBe(false)
    })

    it('parses before/after dates and rejects impossible ones', () => {
        const parsed = parseMailSearchQuery('after:2026-01-15 before:2026-02-01')
        expect(parsed.after?.toISOString()).toBe('2026-01-15T00:00:00.000Z')
        expect(parsed.before?.toISOString()).toBe('2026-02-01T00:00:00.000Z')
        expect(parseSearchDate('2026-02-31')).toBeNull()
        expect(parseSearchDate('15/01/2026')).toBeNull()
    })

    it('keeps an operator with an invalid value as free text instead of dropping it', () => {
        const parsed = parseMailSearchQuery('after:ontem has:foto is:archived')
        expect(parsed.after).toBeNull()
        expect(parsed.terms).toEqual(['after:ontem', 'has:foto', 'is:archived'])
    })

    it('leaves unknown prefixes and times as free text', () => {
        const parsed = parseMailSearchQuery('http://example.com reuniao 10:30')
        expect(parsed.terms).toEqual(['http://example.com', 'reuniao', '10:30'])
        expect(parsed.from).toEqual([])
    })

    it('ignores empty operators and reports no criteria for blank input', () => {
        expect(hasSearchCriteria(parseMailSearchQuery('from:'))).toBe(false)
        expect(hasSearchCriteria(parseMailSearchQuery('   '))).toBe(false)
    })

    it('accepts operator-only queries as valid criteria', () => {
        expect(hasSearchCriteria(parseMailSearchQuery('is:unread'))).toBe(true)
    })
})

describe('LIKE escaping', () => {
    it('escapes %, _ and backslash so user input matches literally', () => {
        expect(escapeLikePattern('100%_done\\ok')).toBe('100\\%\\_done\\\\ok')
        expect(containsPattern('a_b')).toBe('%a\\_b%')
    })
})
