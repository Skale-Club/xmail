/**
 * Search-box syntax for the native webmail (GET /api/mail/mailboxes/:id/search).
 *
 * Supported operators (case-insensitive keys, values may be "quoted"):
 *   from:<text>        sender name or address contains <text>
 *   to:<text>          any To recipient contains <text>
 *   subject:<text>     subject contains <text>
 *   has:attachment     message has at least one attachment (also "has:attachments")
 *   before:YYYY-MM-DD  received strictly before that day (UTC)
 *   after:YYYY-MM-DD   received on or after that day (UTC)
 *   is:unread | is:read | is:starred
 *   in:<folder>        folder type (inbox, sent, drafts, trash, spam, archive) or folder name
 *
 * Everything else is free text. Free-text terms (and "quoted phrases") are
 * ANDed together and each one must appear in the subject, sender, recipients
 * or body. An operator with a value we cannot understand (for example
 * `after:ontem`) is kept as free text instead of silently dropped, so what the
 * user typed is never ignored.
 */

export interface ParsedMailSearch {
    terms: string[]
    from: string[]
    to: string[]
    subject: string[]
    hasAttachment: boolean | null
    /** Exclusive upper bound. */
    before: Date | null
    /** Inclusive lower bound. */
    after: Date | null
    unread: boolean | null
    starred: boolean | null
    folders: string[]
}

interface Token {
    /** Raw operator key when the token looked like `key:value`, lowercased. */
    key: string | null
    value: string
    /** True when the value (or whole token) was wrapped in quotes. */
    quoted: boolean
    /** Original text, used to fall back to free text. */
    raw: string
}

const OPERATOR_KEYS = new Set(['from', 'to', 'subject', 'has', 'before', 'after', 'is', 'in'])
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseSearchDate(value: string): Date | null {
    const match = DATE_RE.exec(value.trim())
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    // Reject 2026-02-31 style overflow: Date.UTC would roll it into March.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null
    }
    return date
}

function tokenize(input: string): Token[] {
    const tokens: Token[] = []
    const length = input.length
    let index = 0

    while (index < length) {
        while (index < length && /\s/.test(input[index])) index += 1
        if (index >= length) break

        const start = index
        let key: string | null = null

        // Operator prefix: letters followed by ":" with no whitespace before the colon.
        const prefix = /^([A-Za-z]+):/.exec(input.slice(index))
        if (prefix && OPERATOR_KEYS.has(prefix[1].toLowerCase())) {
            key = prefix[1].toLowerCase()
            index += prefix[0].length
        }

        let value = ''
        let quoted = false

        if (input[index] === '"') {
            quoted = true
            index += 1
            while (index < length && input[index] !== '"') {
                value += input[index]
                index += 1
            }
            if (index < length) index += 1 // closing quote
        } else {
            while (index < length && !/\s/.test(input[index])) {
                value += input[index]
                index += 1
            }
        }

        tokens.push({ key, value: value.trim(), quoted, raw: input.slice(start, index) })
    }

    return tokens
}

export function parseMailSearchQuery(input: string): ParsedMailSearch {
    const parsed: ParsedMailSearch = {
        terms: [],
        from: [],
        to: [],
        subject: [],
        hasAttachment: null,
        before: null,
        after: null,
        unread: null,
        starred: null,
        folders: [],
    }

    for (const token of tokenize(input)) {
        const { key, value } = token

        if (!key) {
            if (value) parsed.terms.push(value)
            continue
        }

        // `from:` with nothing after it carries no meaning; skip rather than match everything.
        if (!value) continue

        const lower = value.toLowerCase()
        let handled = true

        switch (key) {
            case 'from':
                parsed.from.push(value)
                break
            case 'to':
                parsed.to.push(value)
                break
            case 'subject':
                parsed.subject.push(value)
                break
            case 'has':
                if (lower === 'attachment' || lower === 'attachments') parsed.hasAttachment = true
                else handled = false
                break
            case 'is':
                if (lower === 'unread') parsed.unread = true
                else if (lower === 'read') parsed.unread = false
                else if (lower === 'starred') parsed.starred = true
                else handled = false
                break
            case 'before': {
                const date = parseSearchDate(value)
                if (date) parsed.before = date
                else handled = false
                break
            }
            case 'after': {
                const date = parseSearchDate(value)
                if (date) parsed.after = date
                else handled = false
                break
            }
            case 'in':
                parsed.folders.push(lower)
                break
            default:
                handled = false
        }

        if (!handled) parsed.terms.push(token.raw)
    }

    return parsed
}

/** True when the parsed query has anything to filter on at all. */
export function hasSearchCriteria(parsed: ParsedMailSearch): boolean {
    return (
        parsed.terms.length > 0 ||
        parsed.from.length > 0 ||
        parsed.to.length > 0 ||
        parsed.subject.length > 0 ||
        parsed.hasAttachment !== null ||
        parsed.before !== null ||
        parsed.after !== null ||
        parsed.unread !== null ||
        parsed.starred !== null ||
        parsed.folders.length > 0
    )
}

/**
 * Escapes the LIKE/ILIKE wildcards so user input is matched literally.
 * Postgres' default escape character is the backslash.
 */
export function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function containsPattern(value: string): string {
    return `%${escapeLikePattern(value)}%`
}

const FOLDER_ALIASES: Record<string, string> = {
    entrada: 'inbox',
    'caixa-de-entrada': 'inbox',
    enviados: 'sent',
    enviadas: 'sent',
    rascunhos: 'drafts',
    rascunho: 'drafts',
    lixeira: 'trash',
    lixo: 'spam',
    arquivo: 'archive',
    arquivados: 'archive',
    arquivadas: 'archive',
}

/** Maps friendly (pt-BR) folder words used in `in:` onto folder types; others pass through. */
export function normalizeFolderAlias(value: string): string {
    const lower = value.trim().toLowerCase()
    return FOLDER_ALIASES[lower] ?? lower
}
