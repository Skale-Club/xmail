/**
 * DOM processing for message HTML shown in EmailHtmlViewer: remote-content blocking and
 * quoted-text detection. Runs once per message on a detached document (never attached to the
 * page), and the result is rendered in a sandboxed iframe.
 */

// 1x1 transparent GIF — stands in for any blocked remote image so the layout
// doesn't jump when a message is first rendered with images off.
export const BLOCKED_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// http(s) and protocol-relative URLs: both fetch from the network.
const REMOTE_URL_RE = /^\s*(https?:)?\/\//i
const CSS_URL_RE = /url\(\s*(['"]?)\s*((?:https?:)?\/\/[^'")]+)\1\s*\)/gi
const CSS_IMPORT_STRING_RE = /@import\s+(['"])\s*(?:https?:)?\/\/[^'"]+\1[^;]*;?/gi

export const QUOTE_ATTRIBUTE = 'data-xmail-quote'

export interface ProcessedEmailHtml {
    /** Head styles + body markup, ready to drop into the iframe document. */
    html: string
    /** True when something remote was neutralized (drives the "Show images" bar). */
    hadRemoteContent: boolean
    /** True when at least one quoted block was marked with `data-xmail-quote`. */
    hasQuotedText: boolean
}

function isRemote(url: string | null | undefined): boolean {
    return !!url && REMOTE_URL_RE.test(url)
}

function rewriteCss(css: string): { css: string; changed: boolean } {
    const rewritten = css
        .replace(CSS_IMPORT_STRING_RE, '')
        // Global regexes carry mutable lastIndex state, so each use goes through replace().
        .replace(CSS_URL_RE, `url($1${BLOCKED_IMAGE_PLACEHOLDER}$1)`)
    return { css: rewritten, changed: rewritten !== css }
}

function blockRemoteContent(doc: Document): boolean {
    let blocked = false

    doc.querySelectorAll('img, input[type="image"]').forEach((el) => {
        const src = el.getAttribute('src')
        if (isRemote(src)) {
            blocked = true
            el.setAttribute('src', BLOCKED_IMAGE_PLACEHOLDER)
        }
    })

    // <img srcset> and <picture><source srcset>.
    doc.querySelectorAll('img[srcset], source[srcset]').forEach((el) => {
        const srcset = el.getAttribute('srcset') || ''
        const rewritten = srcset
            .split(',')
            .map((candidate) => {
                const [url, descriptor] = candidate.trim().split(/\s+/, 2)
                if (isRemote(url)) {
                    blocked = true
                    return [BLOCKED_IMAGE_PLACEHOLDER, descriptor].filter(Boolean).join(' ')
                }
                return candidate.trim()
            })
            .join(', ')
        el.setAttribute('srcset', rewritten)
    })

    // Legacy `background="..."` on table/td/body, <video poster>, <video|audio|source src>.
    doc.querySelectorAll('[background]').forEach((el) => {
        if (isRemote(el.getAttribute('background'))) {
            blocked = true
            el.removeAttribute('background')
        }
    })
    doc.querySelectorAll('video[poster]').forEach((el) => {
        if (isRemote(el.getAttribute('poster'))) {
            blocked = true
            el.setAttribute('poster', BLOCKED_IMAGE_PLACEHOLDER)
        }
    })
    doc.querySelectorAll('video[src], audio[src], source[src], track[src]').forEach((el) => {
        if (isRemote(el.getAttribute('src'))) {
            blocked = true
            el.removeAttribute('src')
        }
    })

    // SVG <image href> / xlink:href.
    doc.querySelectorAll('image').forEach((el) => {
        for (const name of ['href', 'xlink:href']) {
            if (isRemote(el.getAttribute(name))) {
                blocked = true
                el.removeAttribute(name)
            }
        }
    })

    // External stylesheets, frames and plugins all fetch from the network.
    doc.querySelectorAll('link').forEach((el) => {
        if (isRemote(el.getAttribute('href'))) {
            blocked = true
            el.remove()
        }
    })
    doc.querySelectorAll('iframe, object, embed, frame').forEach((el) => {
        blocked = true
        el.remove()
    })
    doc.querySelectorAll('meta[http-equiv]').forEach((el) => {
        if ((el.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') el.remove()
    })

    // Inline style="...url(...)" and <style> blocks (backgrounds, @import, @font-face).
    doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
        const { css, changed } = rewriteCss(el.getAttribute('style') || '')
        if (changed) {
            blocked = true
            el.setAttribute('style', css)
        }
    })
    doc.querySelectorAll('style').forEach((styleTag) => {
        const { css, changed } = rewriteCss(styleTag.textContent || '')
        if (changed) {
            blocked = true
            styleTag.textContent = css
        }
    })

    return blocked
}

const QUOTE_SELECTOR = [
    'blockquote',
    '.gmail_quote',
    '.yahoo_quoted',
    '.moz-cite-prefix',
    '#divRplyFwdMsg',
    '#appendonsend',
].join(', ')

const ATTRIBUTION_RE = /(wrote|escreveu|a écrit|schrieb|escribió)\s*:\s*$/i
const FORWARD_MARKER_RE = /forwarded message|begin forwarded|mensagem encaminhada/i

function textBefore(doc: Document, node: Element): string {
    try {
        const range = doc.createRange()
        range.setStart(doc.body, 0)
        range.setEndBefore(node)
        return range.toString()
    } catch {
        return ''
    }
}

/**
 * Marks quoted-reply blocks with `data-xmail-quote` so the viewer can hide them behind a
 * "Show quoted text" toggle. A message that is nothing but a quote (or a forward) is left alone:
 * hiding the whole body would hide the content the user came to read.
 */
function markQuotedText(doc: Document): boolean {
    if (!doc.body) return false
    let marked = false

    const candidates = Array.from(doc.body.querySelectorAll(QUOTE_SELECTOR))
    for (const candidate of candidates) {
        if (candidate.closest(`[${QUOTE_ATTRIBUTE}]`)) continue // nested inside an already-marked quote

        const before = textBefore(doc, candidate)
        if (before.trim().length === 0) continue // quote is the first thing: nothing to collapse behind
        if (FORWARD_MARKER_RE.test(before.slice(-400))) continue // forwarded content is the point of the message

        candidate.setAttribute(QUOTE_ATTRIBUTE, '1')
        marked = true

        // Outlook puts the header block and the original body as following siblings.
        if (candidate.id === 'divRplyFwdMsg' || candidate.id === 'appendonsend') {
            let sibling = candidate.nextElementSibling
            while (sibling) {
                sibling.setAttribute(QUOTE_ATTRIBUTE, '1')
                sibling = sibling.nextElementSibling
            }
        }

        // "On <date>, <name> wrote:" line right before a bare blockquote.
        const previous = candidate.previousElementSibling
        if (
            candidate.tagName === 'BLOCKQUOTE'
            && previous
            && !previous.hasAttribute(QUOTE_ATTRIBUTE)
            && ATTRIBUTION_RE.test((previous.textContent || '').trim())
        ) {
            previous.setAttribute(QUOTE_ATTRIBUTE, '1')
        }
    }

    return marked
}

export function processEmailHtml(html: string, options: { blockRemote: boolean }): ProcessedEmailHtml {
    if (typeof DOMParser === 'undefined') {
        return { html, hadRemoteContent: false, hasQuotedText: false }
    }

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const hadRemoteContent = options.blockRemote ? blockRemoteContent(doc) : false

    const hasQuotedText = markQuotedText(doc)

    doc.querySelectorAll('title').forEach((el) => el.remove())
    return {
        html: `${doc.head ? doc.head.innerHTML : ''}${doc.body ? doc.body.innerHTML : ''}`,
        hadRemoteContent,
        hasQuotedText,
    }
}
