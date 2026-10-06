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

    const decode = (value: string) => {
        try {
            return decodeURIComponent(value.replace(/\+/g, ' '))
        } catch {
            return value
        }
    }

    const params = new URLSearchParams(query)
    const address = decode(rawAddress).split(',').map(part => part.trim()).filter(Boolean).join(', ')
    const cc = params.get('cc') || undefined
    const subject = params.get('subject') || undefined
    const body = params.get('body') || undefined

    // `to=` can add recipients on top of the path part.
    const extraTo = params.get('to')
    const allTo = [address, extraTo].filter(Boolean).join(', ')

    return { address: allTo, cc, subject, body }
}
