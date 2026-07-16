import { describe, expect, it } from 'vitest'
import {
    bodyPreview,
    buildSourceKey,
    deriveThreadKey,
    generatedThreadKey,
    leadThreadKey,
    normalizeAddress,
    normalizeAddressEntry,
    normalizeAddressList,
    normalizeMessageId,
    normalizeReferences,
    normalizeSubject,
    normalizeSubjectRoot,
    rfcThreadKey,
    sanitizeHeaders,
} from '../normalize'

describe('unified-inbox normalize — addresses', () => {
    it('lower-cases, strips angle brackets, and trims a bare address', () => {
        expect(normalizeAddress('  <Foo.Bar@Example.COM> ')).toBe('foo.bar@example.com')
    })

    it('extracts the address out of a display-name form', () => {
        expect(normalizeAddress('"Ada Lovelace" <Ada@Example.com>')).toBe('ada@example.com')
    })

    it('returns null for blank or missing input', () => {
        expect(normalizeAddress('')).toBeNull()
        expect(normalizeAddress('   ')).toBeNull()
        expect(normalizeAddress(null)).toBeNull()
        expect(normalizeAddress(undefined)).toBeNull()
    })

    it('captures the display name alongside the normalized address', () => {
        expect(normalizeAddressEntry('"Ada Lovelace" <Ada@Example.com>')).toEqual({
            address: 'ada@example.com',
            name: 'Ada Lovelace',
        })
        expect(normalizeAddressEntry('<solo@x.test>')).toEqual({ address: 'solo@x.test', name: null })
        expect(normalizeAddressEntry('not-an-address')).toBeNull()
    })

    it('normalizes and de-duplicates an address list from a string or array', () => {
        expect(normalizeAddressList('a@x.test, "B" <B@X.test>')).toEqual([
            { address: 'a@x.test', name: null },
            { address: 'b@x.test', name: 'B' },
        ])
        // Same address twice collapses to one entry (first name wins).
        expect(normalizeAddressList(['A@x.test', '"Ann" <a@x.test>'])).toEqual([
            { address: 'a@x.test', name: null },
        ])
        expect(normalizeAddressList(null)).toEqual([])
    })
})

describe('unified-inbox normalize — message ids and references', () => {
    it('strips angle brackets and trims a Message-ID while preserving its case', () => {
        expect(normalizeMessageId('  <ABc@Mail.test>  ')).toBe('ABc@Mail.test')
        expect(normalizeMessageId('plain@mail.test')).toBe('plain@mail.test')
        expect(normalizeMessageId('')).toBeNull()
        expect(normalizeMessageId(null)).toBeNull()
    })

    it('tokenizes a multi-token References header on any whitespace', () => {
        expect(normalizeReferences('<root@x.test>\r\n <mid@x.test>\t<leaf@x.test>')).toEqual([
            'root@x.test',
            'mid@x.test',
            'leaf@x.test',
        ])
    })

    it('accepts an array, drops blanks, and de-duplicates preserving order', () => {
        expect(normalizeReferences(['<a@x.test>', '', '<b@x.test>', '<a@x.test>'])).toEqual([
            'a@x.test',
            'b@x.test',
        ])
        expect(normalizeReferences(null)).toEqual([])
        expect(normalizeReferences(undefined)).toEqual([])
    })
})

describe('unified-inbox normalize — subjects', () => {
    it('keeps a trimmed subject but caps its length', () => {
        expect(normalizeSubject('  Hello there  ')).toBe('Hello there')
        expect(normalizeSubject('')).toBeNull()
        expect(normalizeSubject(null)).toBeNull()
    })

    it('strips reply/forward prefixes and lower-cases for the thread root', () => {
        expect(normalizeSubjectRoot('Re: Fwd: Quarterly Numbers')).toBe('quarterly numbers')
        expect(normalizeSubjectRoot('RES: Fw: Olá')).toBe('olá')
        expect(normalizeSubjectRoot('   ')).toBeNull()
    })
})

describe('unified-inbox normalize — source keys and thread keys', () => {
    it('builds a deterministic per-provider source key', () => {
        expect(buildSourceKey('native', 'abc-uuid')).toBe('native:abc-uuid')
        expect(buildSourceKey('smtp', 'uid:1:99')).toBe('smtp:uid:1:99')
        expect(buildSourceKey('outlook', 'mid:x@y')).toBe('outlook:mid:x@y')
    })

    it('derives an rfc thread key from the reference root, lower-cased', () => {
        expect(rfcThreadKey('<Root@Mail.test>')).toBe('rfc:root@mail.test')
    })

    it('prefers the references root, then in-reply-to, then the message id', () => {
        expect(deriveThreadKey({
            references: ['root@x.test', 'leaf@x.test'],
            inReplyTo: 'leaf@x.test',
            internetMessageId: 'self@x.test',
        })).toBe('rfc:root@x.test')

        expect(deriveThreadKey({
            references: [],
            inReplyTo: '<Parent@x.test>',
            internetMessageId: 'self@x.test',
        })).toBe('rfc:parent@x.test')

        expect(deriveThreadKey({
            references: [],
            inReplyTo: null,
            internetMessageId: '<Self@x.test>',
        })).toBe('rfc:self@x.test')
    })

    it('generates a uuid-backed thread key when there is no threading information', () => {
        const key = deriveThreadKey({ references: [], inReplyTo: null, internetMessageId: null })
        expect(key.startsWith('gen:')).toBe(true)
        expect(key.length).toBeGreaterThan('gen:'.length + 10)
        // Two calls without any ids never collide.
        expect(deriveThreadKey({ references: [], inReplyTo: null, internetMessageId: null })).not.toBe(key)
    })

    it('offers a lead-scoped thread key for the address heuristic', () => {
        expect(leadThreadKey('lead-uuid')).toBe('lead:lead-uuid')
        expect(generatedThreadKey().startsWith('gen:')).toBe(true)
    })
})

describe('unified-inbox normalize — preview and safe headers', () => {
    it('prefers the text body, strips html, collapses whitespace and truncates', () => {
        expect(bodyPreview('  Hello   world\n\nfrom text  ', null, 200)).toBe('Hello world from text')
        expect(bodyPreview(null, '<p>Hello <b>bold</b></p><div>next</div>', 200)).toBe('Hello bold next')
        expect(bodyPreview('x'.repeat(50), null, 10)).toBe('xxxxxxxxxx')
        expect(bodyPreview(null, null, 200)).toBeNull()
    })

    it('keeps only a safe header allow-list and drops credential-bearing headers', () => {
        const safe = sanitizeHeaders({
            Subject: 'Hi',
            'Message-ID': '<m@x.test>',
            Authorization: 'Bearer secret-token',
            Cookie: 'session=abc',
            'X-Api-Key': 'nope',
            'Auto-Submitted': 'auto-replied',
        })
        expect(safe).toHaveProperty('subject', 'Hi')
        expect(safe).toHaveProperty('message-id', '<m@x.test>')
        expect(safe).toHaveProperty('auto-submitted', 'auto-replied')
        expect(safe).not.toHaveProperty('authorization')
        expect(safe).not.toHaveProperty('cookie')
        expect(safe).not.toHaveProperty('x-api-key')
    })
})
