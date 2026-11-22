/**
 * Domains of provisioned owned-microsite mailboxes (info@<domain>).
 *
 * These addresses are work mail: never warm-up, never cold outreach (the three-box rule in
 * CLAUDE.md). OUTREACH_PROTECTED_DOMAINS is an env list that has to be edited by hand for every
 * new domain; a microsite domain appears at runtime, so it is tracked here instead. The set is
 * in memory so the (synchronous) sending guards can read it: the provisioning API adds to it the
 * moment a domain is provisioned and the process reloads it from `microsite_mail_domains` at
 * boot and periodically (see lib/microsite-provisioning-store.ts).
 */

let micrositeDomains: ReadonlySet<string> = new Set()

export function setMicrositeProtectedDomains(domains: Iterable<string>): void {
    micrositeDomains = new Set([...domains].map((d) => d.trim().toLowerCase()).filter(Boolean))
}

export function addMicrositeProtectedDomain(domain: string): void {
    const normalized = domain.trim().toLowerCase()
    if (!normalized) return
    micrositeDomains = new Set([...micrositeDomains, normalized])
}

export function getMicrositeProtectedDomains(): ReadonlySet<string> {
    return micrositeDomains
}

/** True when the address belongs to a provisioned microsite domain. */
export function isMicrositeMailAddress(email: string): boolean {
    const domain = email.split('@')[1]?.trim().toLowerCase()
    return !!domain && micrositeDomains.has(domain)
}
