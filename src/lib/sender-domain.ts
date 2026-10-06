import { getDomain } from 'tldts'

// Strict enough to reject anything that is not a plain hostname: no scheme, path, port, '@',
// whitespace, underscores or empty labels. Length is checked separately (253 is the DNS limit).
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Reduces a hostname to its registrable domain (public-suffix aware), lowercased.
 * `account.dataforseo.com` -> `dataforseo.com`, `montecarlopostos.com.br` stays as is.
 * Returns null for IP addresses, bare suffixes, single labels (`localhost`) and anything that
 * is not a plain hostname.
 */
export function normalizeTrustedDomain(input: string | null | undefined): string | null {
    if (typeof input !== 'string') return null
    const host = input.trim().toLowerCase().replace(/\.$/, '')
    if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return null
    const domain = getDomain(host)
    return domain && HOSTNAME_RE.test(domain) ? domain : null
}

/**
 * Registrable domain of an email address (`hello@account.dataforseo.com` -> `dataforseo.com`).
 * Accepts a bare address or a `Name <addr>` string. Returns null when there is no usable domain.
 */
export function senderRegistrableDomain(email: string | null | undefined): string | null {
    if (typeof email !== 'string') return null
    const bracketed = email.match(/<([^<>]+)>/)
    const address = (bracketed ? bracketed[1] : email).trim()
    const at = address.lastIndexOf('@')
    if (at < 1) return null
    return normalizeTrustedDomain(address.slice(at + 1))
}
