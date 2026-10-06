/** Target of a clicked `mailto:` link. */
export interface MailtoTarget {
    address: string
    cc?: string
    subject?: string
    body?: string
}

/** Parses a `mailto:` URL into compose fields. Returns null for anything else. */
export function parseMailtoUrl(href: string): MailtoTarget | null {
    const trimmed = href.trim()
    if (!/^mailto:/i.test(trimmed)) return null

    const withoutScheme = trimmed.slice('mailto:'.length)
    const queryStart = withoutScheme.indexOf('?')
    const rawAddress = queryStart >= 0 ? withoutScheme.slice(0, queryStart) : withoutScheme
    const query = queryStart >= 0 ? withoutScheme.slice(queryStart + 1) : ''

    // RFC 6068: only percent-decoding applies. "+" stays a plus (john+tag@x.com is a valid
    // address); URLSearchParams would turn it into a space, so the query is split by hand.
    const decode = (value: string) => {
        try {
            return decodeURIComponent(value)
        } catch {
            return value
        }
    }

    const params = new Map<string, string>()
    for (const pair of query.split('&')) {
        if (!pair) continue
        const equals = pair.indexOf('=')
        const key = decode(equals >= 0 ? pair.slice(0, equals) : pair).toLowerCase()
        if (!params.has(key)) params.set(key, decode(equals >= 0 ? pair.slice(equals + 1) : ''))
    }
    const address = decode(rawAddress).split(',').map(part => part.trim()).filter(Boolean).join(', ')
    const cc = params.get('cc') || undefined
    const subject = params.get('subject') || undefined
    const body = params.get('body') || undefined

    // `to=` can add recipients on top of the path part.
    const extraTo = params.get('to')
    const allTo = [address, extraTo].filter(Boolean).join(', ')

    return { address: allTo, cc, subject, body }
}
