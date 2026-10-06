/**
 * The operation's own domains: MAIL_DOMAIN plus the comma-separated
 * OUTREACH_PROTECTED_DOMAINS list (the eight company domains in production).
 *
 * One source of truth for two questions:
 *  - which domains cold outreach must never send from (campaigns.ts), and
 *  - which mailboxes belong to the operation rather than to a client organization
 *    (the webmail mailbox switcher).
 */
export function getOperationDomains(env: Record<string, string | undefined> = process.env): Set<string> {
    const raw = [env.MAIL_DOMAIN, env.OUTREACH_PROTECTED_DOMAINS]
        .filter((value): value is string => Boolean(value))
        .join(',')
    return new Set(
        raw.split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean),
    )
}

export function emailDomain(email: string): string {
    return email.split('@')[1]?.trim().toLowerCase() ?? ''
}

export function isOperationEmail(email: string, domains: Set<string> = getOperationDomains()): boolean {
    const domain = emailDomain(email)
    return domain !== '' && domains.has(domain)
}
