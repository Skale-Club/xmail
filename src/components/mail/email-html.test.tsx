import { describe, expect, it } from 'vitest'
import { parseMailtoUrl } from '../../lib/mailto'
import { BLOCKED_IMAGE_PLACEHOLDER, processEmailHtml, QUOTE_ATTRIBUTE } from './email-html'

const blocked = (html: string) => processEmailHtml(html, { blockRemote: true })

describe('processEmailHtml remote content blocking', () => {
    it('keeps <head><style> rules when images are blocked', () => {
        const result = blocked('<html><head><style>.hero{color:red}</style></head><body><p class="hero">Hi</p></body></html>')
        expect(result.html).toContain('.hero{color:red}')
        expect(result.html).toContain('<p class="hero">Hi</p>')
    })

    it('blocks img src, protocol-relative urls and srcset', () => {
        const result = blocked('<img src="https://t.example/p.gif"><img src="//t.example/q.gif"><img srcset="https://t.example/a.png 2x, local.png 1x">')
        expect(result.hadRemoteContent).toBe(true)
        expect(result.html).not.toContain('t.example')
        expect(result.html).toContain(BLOCKED_IMAGE_PLACEHOLDER)
    })

    it('blocks background attributes, picture sources and video posters', () => {
        const result = blocked('<table background="https://t.example/bg.png"></table><picture><source srcset="https://t.example/s.webp"><img src="data:image/gif;base64,AAAA"></picture><video poster="https://t.example/poster.jpg"></video>')
        expect(result.html).not.toContain('t.example')
        expect(result.hadRemoteContent).toBe(true)
    })

    it('blocks css url() and @import in <style> and inline styles', () => {
        const result = blocked('<style>@import url("https://t.example/a.css"); @import "https://t.example/b.css"; .x{background:url(https://t.example/c.png)}</style><div style="background-image:url(\'https://t.example/d.png\')"></div>')
        expect(result.html).not.toContain('t.example')
        expect(result.hadRemoteContent).toBe(true)
    })

    it('removes external stylesheets, frames and embeds', () => {
        const result = blocked('<link rel="stylesheet" href="https://t.example/s.css"><iframe src="https://t.example/f"></iframe><embed src="https://t.example/e">text')
        expect(result.html).not.toContain('t.example')
        expect(result.html).toContain('text')
    })

    it('leaves cid: and data: images alone and reports nothing blocked', () => {
        const result = blocked('<img src="cid:logo"><img src="data:image/png;base64,AAAA">')
        expect(result.hadRemoteContent).toBe(false)
        expect(result.html).toContain('cid:logo')
    })

    it('does not touch remote content when blocking is off', () => {
        const result = processEmailHtml('<img src="https://t.example/p.gif">', { blockRemote: false })
        expect(result.html).toContain('https://t.example/p.gif')
        expect(result.hadRemoteContent).toBe(false)
    })
})

describe('processEmailHtml quoted text', () => {
    it('marks a reply blockquote and its "wrote:" line', () => {
        const result = blocked('<p>My reply</p><p>On Mon, Ana wrote:</p><blockquote>old text</blockquote>')
        expect(result.hasQuotedText).toBe(true)
        expect((result.html.match(new RegExp(QUOTE_ATTRIBUTE, 'g')) || []).length).toBe(2)
    })

    it('marks gmail_quote blocks', () => {
        const result = blocked('<div>Thanks!</div><div class="gmail_quote">older</div>')
        expect(result.hasQuotedText).toBe(true)
    })

    it('does not collapse a message that is only a quote', () => {
        expect(blocked('<blockquote>everything is quoted</blockquote>').hasQuotedText).toBe(false)
    })

    it('does not collapse forwarded content', () => {
        const result = blocked('<p>FYI</p><p>---------- Forwarded message ----------</p><blockquote>forwarded body</blockquote>')
        expect(result.hasQuotedText).toBe(false)
    })

    it('reports no quote for plain messages', () => {
        expect(blocked('<p>Just text</p>').hasQuotedText).toBe(false)
    })
})

describe('parseMailtoUrl', () => {
    it('parses address, subject, cc and body', () => {
        expect(parseMailtoUrl('mailto:ana@x.com?subject=Hello%20there&cc=bob@x.com&body=Hi%0AAll')).toEqual({
            address: 'ana@x.com',
            cc: 'bob@x.com',
            subject: 'Hello there',
            body: 'Hi\nAll',
        })
    })

    it('handles multiple recipients and ignores other schemes', () => {
        expect(parseMailtoUrl('mailto:a@x.com,b@x.com')?.address).toBe('a@x.com, b@x.com')
        expect(parseMailtoUrl('https://x.com')).toBeNull()
    })
})
