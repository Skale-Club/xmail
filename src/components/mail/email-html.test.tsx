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

describe('processEmailHtml blocking bypasses', () => {
    it('normalizes backslash, tab and newline tricks before deciding', () => {
        const result = blocked(String.raw`<img src="\\t.example/a.gif"><img src="https:\\t.example/b.gif"><img src="ht&#9;tp://t.example/c.gif"><img src="  HTTPS://t.example/d.gif">`)
        expect(result.html).not.toContain('t.example')
        expect(result.hadRemoteContent).toBe(true)
    })

    it('blocks relative image paths (they would hit our own origin)', () => {
        expect(blocked('<img src="/t/open/abc.gif">').hadRemoteContent).toBe(true)
    })

    it('blocks image-set() without url(), including bare strings', () => {
        const result = blocked(`<div style="background:image-set('https://t.example/a.png' 1x, 'https://t.example/b.png' 2x)"></div><style>.x{background-image:-webkit-image-set("//t.example/c.png" 1x)}</style>`)
        expect(result.html).not.toContain('t.example')
    })

    it('sees through css escapes in url() and the function name', () => {
        const result = blocked(String.raw`<div style="background:\75rl(\68ttps://t.example/a.png)"></div><div style="background:url(h\74tps://t.example/b.png)"></div>`)
        expect(result.html).not.toContain('t.example')
        expect(result.hadRemoteContent).toBe(true)
    })

    it('blocks svg image, feImage and use references but keeps same-document use', () => {
        const result = blocked('<svg><image href="https://t.example/a.png"/><filter><feImage href="https://t.example/b.png"/></filter><use xlink:href="https://t.example/c.svg#x"/><use href="#local"/></svg>')
        expect(result.html).not.toContain('t.example')
        expect(result.html).toContain('#local')
    })

    it('keeps plain links clickable', () => {
        expect(blocked('<a href="https://example.com/page">x</a>').html).toContain('https://example.com/page')
    })
})

describe('processEmailHtml quoted text', () => {
    it('never collapses a blockquote in the middle of a message', () => {
        const result = blocked('<p>Intro</p><blockquote>a pull quote</blockquote><p>More text after it</p>')
        expect(result.hasQuotedText).toBe(false)
    })

    it('collapses an Outlook reply header and what follows it', () => {
        const result = blocked('<p>My answer</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Ana</div><div>old body</div>')
        expect(result.hasQuotedText).toBe(true)
        expect(result.html).toContain(QUOTE_ATTRIBUTE)
    })

    it('collapses an Original Message block', () => {
        const result = blocked('<p>My answer</p><p>-----Original Message-----</p><p>From: Ana</p><p>old</p>')
        expect(result.hasQuotedText).toBe(true)
    })

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

    it('keeps "+" in addresses (RFC 6068 only percent-decodes)', () => {
        expect(parseMailtoUrl('mailto:john+tag@x.com?subject=a+b')).toEqual({
            address: 'john+tag@x.com',
            cc: undefined,
            subject: 'a+b',
            body: undefined,
        })
    })

    it('handles multiple recipients and ignores other schemes', () => {
        expect(parseMailtoUrl('mailto:a@x.com,b@x.com')?.address).toBe('a@x.com, b@x.com')
        expect(parseMailtoUrl('https://x.com')).toBeNull()
    })
})

describe('processEmailHtml own-color detection', () => {
    const colors = (html: string) => processEmailHtml(html, { blockRemote: true }).hasOwnColors

    it('treats plain HTML with no colors as theme-able', () => {
        // The MSHTML body that rendered black-on-dark: fonts only, no colors.
        expect(colors('<HTML><HEAD><META name=GENERATOR content="MSHTML 11.00"></HEAD><BODY><P><FONT face="Georgia">Hey there,</FONT></P></BODY></HTML>')).toBe(false)
        expect(colors('<div dir="ltr">Hi<br><blockquote class="gmail_quote">old</blockquote></div>')).toBe(false)
    })

    it('ignores declarations that paint nothing', () => {
        expect(colors('<p style="color: inherit; background: transparent; border-color: red">x</p>')).toBe(false)
        expect(colors('<style>p { background-color: none !important }</style><p>x</p>')).toBe(false)
    })

    it('detects colors set by attributes, inline styles and <style> blocks', () => {
        expect(colors('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true)
        expect(colors('<font color="#333">x</font>')).toBe(true)
        expect(colors('<body text="#000000">x</body>')).toBe(true)
        expect(colors('<span style="color:#000000">x</span>')).toBe(true)
        expect(colors('<div style="background: #f4f4f4">x</div>')).toBe(true)
        expect(colors('<style>.wrap{background-color:#fff}</style><div class="wrap">x</div>')).toBe(true)
    })

    it('still sees a remote background attribute that blocking removes', () => {
        expect(colors('<table background="https://t.example/bg.png"><tr><td>x</td></tr></table>')).toBe(true)
    })
})
