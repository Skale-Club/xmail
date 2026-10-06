/**
 * DOM processing for message HTML shown in EmailHtmlViewer: remote-content blocking and
 * quoted-text detection. Runs once per message on a detached document (never attached to the
 * page), and the result is rendered in a sandboxed iframe.
 */

// 1x1 transparent GIF — stands in for any blocked remote image so the layout
// doesn't jump when a message is first rendered with images off.
export const BLOCKED_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export const QUOTE_ATTRIBUTE = 'data-xmail-quote'

export interface ProcessedEmailHtml {
    /** Head styles + body markup, ready to drop into the iframe document. */
    html: string
    /** True when something remote was neutralized (drives the "Show images" bar). */
    hadRemoteContent: boolean
    /** True when at least one quoted block was marked with `data-xmail-quote`. */
    hasQuotedText: boolean
}

function baseUrl(): string {
    try {
        return window.location.href
    } catch {
        return 'https://xmail.invalid/'
    }
}

/**
 * Decides by what the browser would actually request, not by how the attribute is spelled:
 * the value is resolved with the URL parser, which already handles backslashes
 * (`\\tracker`, `https:\\x`), tabs/newlines inside the scheme, protocol-relative URLs and
 * relative paths. Anything that resolves to http(s) is remote. `cid:`, `data:`, `blob:` and
 * same-document `#fragment` references never leave the sandbox.
 */
export function isRemoteUrl(value: string | null | undefined): boolean {
    if (!value) return false
    const trimmed = value.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    try {
        const resolved = new URL(trimmed, baseUrl())
        return resolved.protocol === 'http:' || resolved.protocol === 'https:'
    } catch {
        return false
    }
}

/** Resolves CSS escapes (`\75rl(`, `\68ttp`) so detection sees what the CSS parser will see. */
export function unescapeCss(css: string): string {
    return css
        .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_, hex: string) => {
            const code = parseInt(hex, 16)
            if (!code || code > 0x10ffff) return '�'
            return String.fromCodePoint(code)
        })
        .replace(/\\([^0-9a-fA-F\n\r\f])/g, '$1')
}

const CSS_URL_FN_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi
const CSS_IMPORT_RE = /@import\b[^;{]*(?:;|$)/gi

/** Rewrites remote references inside the argument of every `image-set(` call. */
function blockImageSets(css: string, onBlocked: () => void): string {
    const re = /(?:-webkit-)?image-set\(/gi
    let out = ''
    let last = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(css)) !== null) {
        const start = match.index + match[0].length
        let depth = 1
        let index = start
        while (index < css.length && depth > 0) {
            if (css[index] === '(') depth += 1
            else if (css[index] === ')') depth -= 1
            index += 1
        }
        const inner = css.slice(start, depth === 0 ? index - 1 : index)
        const rewritten = inner.replace(/"([^"]*)"|'([^']*)'/g, (whole, dq: string | undefined, sq: string | undefined) => {
            const url = dq ?? sq ?? ''
            if (!isRemoteUrl(url)) return whole
            onBlocked()
            return `"${BLOCKED_IMAGE_PLACEHOLDER}"`
        })
        out += css.slice(last, start) + rewritten
        last = depth === 0 ? index - 1 : index
        re.lastIndex = last
    }
    return out + css.slice(last)
}

function rewriteCss(original: string): { css: string; changed: boolean } {
    // Detect on the unescaped text; only adopt it as output when something was blocked, so
    // untouched stylesheets keep their exact original bytes.
    const normalized = unescapeCss(original)
    let changed = false
    const mark = () => { changed = true }

    let css = normalized.replace(CSS_IMPORT_RE, () => { mark(); return '' })
    css = css.replace(CSS_URL_FN_RE, (whole, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
        const url = (dq ?? sq ?? bare ?? '').trim()
        if (!isRemoteUrl(url)) return whole
        mark()
        return `url("${BLOCKED_IMAGE_PLACEHOLDER}")`
    })
    css = blockImageSets(css, mark)

    return changed ? { css, changed: true } : { css: original, changed: false }
}

// Attributes that make the browser fetch something, on any element except links (links only
// load on click, and they must keep working).
const FETCHING_ATTRIBUTES = ['src', 'poster', 'background', 'data', 'href', 'xlink:href', 'lowsrc', 'dynsrc']
const LINK_LIKE = new Set(['A', 'AREA'])

function blockRemoteContent(doc: Document): boolean {
    let blocked = false

    // <link> (stylesheets, preloads, icons), frames and plugins all fetch from the network.
    doc.querySelectorAll('link').forEach((el) => {
        if (isRemoteUrl(el.getAttribute('href'))) blocked = true
        el.remove()
    })
    doc.querySelectorAll('iframe, object, embed, frame, frameset, applet').forEach((el) => {
        blocked = true
        el.remove()
    })
    doc.querySelectorAll('meta[http-equiv]').forEach((el) => {
        if ((el.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') el.remove()
    })

    // srcset on <img> and <picture><source>.
    doc.querySelectorAll('[srcset]').forEach((el) => {
        const srcset = el.getAttribute('srcset') || ''
        const rewritten = srcset
            .split(',')
            .map((candidate) => {
                const [url, descriptor] = candidate.trim().split(/\s+/, 2)
                if (isRemoteUrl(url)) {
                    blocked = true
                    return [BLOCKED_IMAGE_PLACEHOLDER, descriptor].filter(Boolean).join(' ')
                }
                return candidate.trim()
            })
            .join(', ')
        el.setAttribute('srcset', rewritten)
    })

    // Every other URL-bearing attribute, SVG included (<image>, <feImage>, <use>).
    doc.querySelectorAll('*').forEach((el) => {
        if (LINK_LIKE.has(el.tagName)) return
        for (const name of FETCHING_ATTRIBUTES) {
            const value = el.getAttribute(name)
            if (!isRemoteUrl(value)) continue
            blocked = true
            const tag = el.tagName.toLowerCase()
            if ((tag === 'img' || tag === 'input' || tag === 'video') && (name === 'src' || name === 'poster')) {
                el.setAttribute(name, BLOCKED_IMAGE_PLACEHOLDER)
            } else {
                el.removeAttribute(name)
            }
        }
    })

    // Inline style="...url(...)" and <style> blocks (backgrounds, @import, @font-face, image-set).
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

// Only these are ever treated as a quoted reply. A <blockquote> in the middle of a message is
// content (a pull quote, a cited paragraph) and must stay visible.
const QUOTE_SELECTOR = [
    'blockquote',
    '.gmail_quote',
    '.yahoo_quoted',
    '#divRplyFwdMsg',
    '#appendonsend',
].join(', ')

const ATTRIBUTION_RE = /(wrote|escreveu|a écrit|schrieb|escribió)\s*:\s*$/i
const FORWARD_MARKER_RE = /forwarded message|begin forwarded|mensagem encaminhada/i
const ORIGINAL_MESSAGE_RE = /^[-_\s]*(original message|mensagem original|ursprüngliche nachricht)[-_\s]*$/i

function textAfter(doc: Document, node: Element): string {
    try {
        const range = doc.createRange()
        range.setStartAfter(node)
        range.setEndAfter(doc.body.lastChild ?? doc.body)
        return range.toString()
    } catch {
        return 'x'
    }
}

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

function markWithFollowingSiblings(element: Element) {
    let sibling: Element | null = element
    while (sibling) {
        sibling.setAttribute(QUOTE_ATTRIBUTE, '1')
        sibling = sibling.nextElementSibling
    }
}

/**
 * Marks the TRAILING quoted-reply block with `data-xmail-quote` so the viewer can hide it behind
 * a "Show quoted text" toggle. Only blocks that end the message qualify (nothing but whitespace
 * after them); a message that is nothing but a quote, or a forward, is left alone.
 */
function markQuotedText(doc: Document): boolean {
    if (!doc.body) return false
    let marked = false

    // Outlook "-----Original Message-----" lines: that line and everything after it is the quote.
    doc.body.querySelectorAll('p, div, span, font, b').forEach((el) => {
        if (el.closest(`[${QUOTE_ATTRIBUTE}]`)) return
        if (!ORIGINAL_MESSAGE_RE.test((el.textContent || '').trim())) return
        if (el.children.length > 0 && el.querySelector('p, div')) return
        if (textBefore(doc, el).trim().length === 0) return
        markWithFollowingSiblings(el)
        marked = true
    })

    const candidates = Array.from(doc.body.querySelectorAll(QUOTE_SELECTOR))
    for (const candidate of candidates) {
        if (candidate.closest(`[${QUOTE_ATTRIBUTE}]`)) continue // nested inside an already-marked quote

        const isOutlookHeader = candidate.id === 'divRplyFwdMsg' || candidate.id === 'appendonsend'
        // Outlook's reply header always introduces a quote that runs to the end; other quotes
        // only count when nothing but whitespace follows them.
        if (!isOutlookHeader && textAfter(doc, candidate).trim().length > 0) continue

        const before = textBefore(doc, candidate)
        if (before.trim().length === 0) continue // quote is the first thing: nothing to collapse behind
        if (FORWARD_MARKER_RE.test(before.slice(-400))) continue // forwarded content is the point of the message
        if (FORWARD_MARKER_RE.test((candidate.textContent || '').slice(0, 300))) continue

        if (isOutlookHeader) {
            markWithFollowingSiblings(candidate)
        } else {
            candidate.setAttribute(QUOTE_ATTRIBUTE, '1')
        }
        marked = true

        // "On <date>, <name> wrote:" line (or Thunderbird's cite prefix) right before the quote.
        const previous = candidate.previousElementSibling
        if (
            previous
            && !previous.hasAttribute(QUOTE_ATTRIBUTE)
            && (previous.classList.contains('moz-cite-prefix') || ATTRIBUTION_RE.test((previous.textContent || '').trim()))
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
