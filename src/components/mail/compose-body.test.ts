import { describe, expect, it } from 'vitest'
import {
    buildForwardQuote,
    buildInitialBody,
    buildReplyAttribution,
    buildReplyQuote,
    buildReplyRecipients,
    insertSignature,
    isBodyEmpty,
    plainTextToHtml,
    prefixSubject,
    sanitizeQuotedHtml,
} from './compose-body'

const sender = { name: 'Ana Souza', email: 'ana@client.com' }
const date = new Date('2026-10-06T14:32:00Z')

describe('reply and forward bodies', () => {
    it('puts the signature above the quote in a reply', () => {
        const quote = buildReplyQuote({ from: sender, date, source: { html: '<p>Original text</p>' } })
        const body = buildInitialBody({ signatureHtml: '<p>-- Bia</p>', quoteHtml: quote })

        expect(body.indexOf('-- Bia')).toBeGreaterThan(-1)
        expect(body.indexOf('-- Bia')).toBeLessThan(body.indexOf('wrote:'))
        expect(body.indexOf('wrote:')).toBeLessThan(body.indexOf('<blockquote>'))
        expect(body).toContain('Original text')
    })

    it('adds an "On <date>, <sender> wrote:" line', () => {
        const line = buildReplyAttribution(sender, date)
        expect(line).toMatch(/^On .+, Ana Souza &lt;ana@client\.com&gt; wrote:$/)
    })

    it('escapes plain-text originals instead of injecting them as HTML', () => {
        const quote = buildReplyQuote({ from: sender, date, source: { plain: 'a <b> & c\nline 2' } })
        expect(quote).toContain('a &lt;b&gt; &amp; c<br>line 2')
        expect(plainTextToHtml('<x>')).toBe('&lt;x&gt;')
    })

    it('strips styles and scripts from quoted html', () => {
        const cleaned = sanitizeQuotedHtml('<html><head><style>p{}</style></head><body><p>Hi</p><script>x()</script></body></html>')
        expect(cleaned).toBe('<p>Hi</p>')
    })

    it('builds a forward header with from, date, subject and to', () => {
        const quote = buildForwardQuote({
            from: sender,
            date,
            subject: 'Proposal',
            to: [{ email: 'me@skale.club' }],
            source: { plain: 'hello' },
        })
        expect(quote).toContain('---------- Forwarded message ----------')
        expect(quote).toContain('Subject: Proposal')
        expect(quote).toContain('To: me@skale.club')
    })
})

describe('insertSignature', () => {
    it('inserts above the quote and its attribution line without removing anything', () => {
        const quote = buildReplyQuote({ from: sender, date, source: { html: '<p>Original</p>' } })
        const body = `<p>My answer</p><p><br></p>${quote}`
        const result = insertSignature(body, '<p>-- Bia</p>')

        expect(result).toContain('My answer')
        expect(result).toContain('Original')
        expect(result.indexOf('-- Bia')).toBeGreaterThan(result.indexOf('My answer'))
        expect(result.indexOf('-- Bia')).toBeLessThan(result.indexOf('wrote:'))
        // Every character of the previous body is still there, in order.
        expect(result.replace('<p>-- Bia</p><p><br></p>', '')).toBe(body)
    })

    it('does not cut the text that follows the first double line break (the old regex bug)', () => {
        const body = '<p>Hello</p><br/><br/><p>Second block</p><blockquote>quoted</blockquote>'
        const result = insertSignature(body, '<p>-- Bia</p>')
        expect(result).toContain('Second block')
        expect(result).toContain('quoted')
    })

    it('appends at the end when there is no quote', () => {
        expect(insertSignature('<p>Hi</p>', '<p>-- Bia</p>')).toBe('<p>Hi</p><p><br></p><p>-- Bia</p>')
        expect(insertSignature('', '<p>-- Bia</p>')).toBe('<p>-- Bia</p>')
    })

    it('ignores an empty signature', () => {
        expect(insertSignature('<p>Hi</p>', '  ')).toBe('<p>Hi</p>')
    })
})

describe('buildReplyRecipients', () => {
    const base = {
        from: sender,
        to: [{ email: 'me@skale.club' }, { email: 'bob@client.com' }],
        cc: [{ email: 'carol@client.com' }, { email: 'me@skale.club' }],
        selfEmails: ['me@skale.club'],
    }

    it('plain reply goes only to the sender', () => {
        const result = buildReplyRecipients({ ...base, replyAll: false })
        expect(result.to.map(r => r.email)).toEqual(['ana@client.com'])
        expect(result.cc).toEqual([])
    })

    it('reply-all keeps the original To in To and the original Cc in Cc, minus ourselves', () => {
        const result = buildReplyRecipients({ ...base, replyAll: true })
        expect(result.to.map(r => r.email)).toEqual(['ana@client.com', 'bob@client.com'])
        expect(result.cc.map(r => r.email)).toEqual(['carol@client.com'])
    })

    it('replying to our own sent message goes to the original recipients', () => {
        const result = buildReplyRecipients({
            from: { email: 'ME@skale.club' },
            to: [{ email: 'ana@client.com' }],
            cc: [],
            selfEmails: ['me@skale.club'],
            replyAll: false,
        })
        expect(result.to.map(r => r.email)).toEqual(['ana@client.com'])
    })

    it('drops duplicates across To and Cc', () => {
        const result = buildReplyRecipients({
            from: sender,
            to: [{ email: 'bob@client.com' }],
            cc: [{ email: 'BOB@client.com' }, { email: 'ana@client.com' }],
            selfEmails: [],
            replyAll: true,
        })
        expect(result.to.map(r => r.email)).toEqual(['ana@client.com', 'bob@client.com'])
        expect(result.cc).toEqual([])
    })
})

describe('misc', () => {
    it('prefixes subjects once', () => {
        expect(prefixSubject('Hello', 'reply')).toBe('Re: Hello')
        expect(prefixSubject('RE: Hello', 'reply')).toBe('RE: Hello')
        expect(prefixSubject('Hello', 'forward')).toBe('Fwd: Hello')
        expect(prefixSubject('Fwd: Hello', 'forward')).toBe('Fwd: Hello')
    })

    it('detects an effectively empty editor body', () => {
        expect(isBodyEmpty('<p><br></p><p> </p>')).toBe(true)
        expect(isBodyEmpty('<p>text</p>')).toBe(false)
        expect(isBodyEmpty('<p><img src="a.png"></p>')).toBe(false)
    })
})
