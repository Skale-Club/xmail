/**
 * Pure helpers that build and edit the HTML body of the compose window.
 *
 * Rules these helpers exist to enforce:
 *  - the default signature goes ABOVE the quoted text of a reply/forward;
 *  - inserting a signature never removes anything the user already wrote or quoted;
 *  - reply-all keeps the original To recipients in To (minus ourselves).
 */

export interface ComposeParticipant {
    name?: string | null
    email: string
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/** Plain text to HTML, preserving line breaks. */
export function plainTextToHtml(text: string): string {
    return escapeHtml(text).replace(/\r?\n/g, '<br>')
}

/** Drops <head>, <style>, <script> and <title> blocks so only visible markup is quoted. */
export function sanitizeQuotedHtml(html: string): string {
    return html
        .replace(/<head[\s\S]*?<\/head>/gi, '')
        .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, '')
        .replace(/<\/?(html|body)[^>]*>/gi, '')
        .trim()
}

function formatParticipant(participant: ComposeParticipant): string {
    const name = participant.name?.trim()
    return name ? `${escapeHtml(name)} &lt;${escapeHtml(participant.email)}&gt;` : escapeHtml(participant.email)
}

export function formatQuoteDate(date: Date | string | number | null | undefined, locale = 'en-US'): string {
    if (date === null || date === undefined || date === '') return ''
    const parsed = date instanceof Date ? date : new Date(date)
    if (Number.isNaN(parsed.getTime())) return typeof date === 'string' ? date : ''
    return parsed.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

/** "On <date>, <sender> wrote:" line that precedes the quoted original. */
export function buildReplyAttribution(from: ComposeParticipant, date: Date | string | number | null | undefined, locale?: string): string {
    const when = formatQuoteDate(date, locale)
    const sender = formatParticipant(from)
    return when ? `On ${escapeHtml(when)}, ${sender} wrote:` : `${sender} wrote:`
}

export interface QuoteSource {
    html?: string | null
    plain?: string | null
}

export function quoteBodyHtml(source: QuoteSource): string {
    if (source.html && source.html.trim()) return sanitizeQuotedHtml(source.html)
    return plainTextToHtml(source.plain ?? '')
}

export function buildReplyQuote(args: {
    from: ComposeParticipant
    date: Date | string | number | null | undefined
    source: QuoteSource
    locale?: string
}): string {
    return `<p>${buildReplyAttribution(args.from, args.date, args.locale)}</p><blockquote>${quoteBodyHtml(args.source)}</blockquote>`
}

export function buildForwardQuote(args: {
    from: ComposeParticipant
    date: Date | string | number | null | undefined
    subject: string
    to: ComposeParticipant[]
    source: QuoteSource
    locale?: string
}): string {
    const lines = [
        '---------- Forwarded message ----------',
        `From: ${formatParticipant(args.from)}`,
        `Date: ${escapeHtml(formatQuoteDate(args.date, args.locale))}`,
        `Subject: ${escapeHtml(args.subject)}`,
        args.to.length > 0 ? `To: ${args.to.map(formatParticipant).join(', ')}` : '',
    ].filter(Boolean)
    return `<p>${lines.join('<br>')}</p><blockquote>${quoteBodyHtml(args.source)}</blockquote>`
}

const BLANK_LINE = '<p><br></p>'
const QUOTE_INTRO_RE = /wrote:|Forwarded message/i

/**
 * Initial body of a new message / reply / forward: an empty line for the cursor, then the
 * default signature (if any), then the quoted text. The signature sits ABOVE the quote.
 */
export function buildInitialBody(args: { signatureHtml?: string | null; quoteHtml?: string | null }): string {
    const parts = [BLANK_LINE]
    if (args.signatureHtml && args.signatureHtml.trim()) {
        parts.push(args.signatureHtml)
    }
    if (args.quoteHtml && args.quoteHtml.trim()) {
        parts.push(BLANK_LINE, args.quoteHtml)
    }
    return parts.join('')
}

/**
 * Inserts `signatureHtml` into an existing body WITHOUT removing anything: right above the
 * quoted text when there is one (including its "On ..., X wrote:" line), otherwise at the end.
 */
export function insertSignature(body: string, signatureHtml: string): string {
    const signature = signatureHtml.trim()
    if (!signature) return body

    const quoteIndex = body.search(/<blockquote[\s>]/i)
    if (quoteIndex < 0) {
        return `${body}${body.trim() ? BLANK_LINE : ''}${signature}`
    }

    let insertAt = quoteIndex
    const before = body.slice(0, quoteIndex)
    const lastParagraph = before.lastIndexOf('<p')
    if (lastParagraph >= 0) {
        const paragraphHtml = before.slice(lastParagraph)
        const text = paragraphHtml.replace(/<[^>]*>/g, ' ')
        if (QUOTE_INTRO_RE.test(text)) insertAt = lastParagraph
    }

    return `${body.slice(0, insertAt)}${signature}${BLANK_LINE}${body.slice(insertAt)}`
}

/** True when the body holds nothing but whitespace / empty paragraphs (e.g. only an empty editor). */
export function isBodyEmpty(html: string): boolean {
    const withoutMarkup = html
        .replace(/<img\b[^>]*>/gi, 'x')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim()
    return withoutMarkup === ''
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
}

export interface ReplyRecipients {
    to: ComposeParticipant[]
    cc: ComposeParticipant[]
}

/**
 * Who a reply goes to. Plain reply: the sender (or, when we are the sender, the original To).
 * Reply-all: sender + original To stay in To and the original Cc stays in Cc, always minus
 * ourselves and without duplicates.
 */
export function buildReplyRecipients(args: {
    from: ComposeParticipant
    to?: ComposeParticipant[]
    cc?: ComposeParticipant[]
    selfEmails: string[]
    replyAll: boolean
}): ReplyRecipients {
    const self = new Set(args.selfEmails.map(normalizeEmail))
    const seen = new Set<string>()

    const take = (list: ComposeParticipant[]): ComposeParticipant[] => {
        const out: ComposeParticipant[] = []
        for (const participant of list) {
            const key = normalizeEmail(participant.email)
            if (!key || self.has(key) || seen.has(key)) continue
            seen.add(key)
            out.push(participant)
        }
        return out
    }

    const original = args.to ?? []
    const senderIsSelf = self.has(normalizeEmail(args.from.email))

    if (!args.replyAll) {
        // Replying to something we sent goes to the people we sent it to.
        return { to: take(senderIsSelf ? original : [args.from]), cc: [] }
    }

    const to = take([...(senderIsSelf ? [] : [args.from]), ...original])
    const cc = take(args.cc ?? [])
    return { to, cc }
}

export function recipientsToString(list: ComposeParticipant[]): string {
    return list.map(participant => participant.email).join(', ')
}

export function prefixSubject(subject: string, kind: 'reply' | 'forward'): string {
    const trimmed = subject.trim()
    if (kind === 'reply') return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`.trim()
    return /^(fwd?|enc):/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trim()
}
