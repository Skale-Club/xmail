import { getOperationDomains } from './operation-domains'

/**
 * Pure sending-inbox guards shared by the human outreach routes and the agent gateway.
 *
 * They live here (not in routes/outreach/campaigns.ts) so a route that only needs the rule does
 * not have to load the whole campaigns router; campaigns.ts re-exports them, so existing imports
 * keep working. Regra das três caixas (CLAUDE.md): `info@` e as caixas de warm-up nunca são
 * remetente de campanha fria.
 */

export interface ProtectedSendingDomainViolation {
    code: 'protected_sending_domain'
    message: string
}

/**
 * P009 — reputation isolation: cold outreach must never send from the primary transactional
 * domain (mx.skale.club / MAIL_DOMAIN) nor from any of the operation's own domains
 * (OUTREACH_PROTECTED_DOMAINS), whose `info@` boxes are the company's working mailboxes.
 */
export function checkProtectedSendingDomains(
    accounts: Array<{ email: string }>,
): ProtectedSendingDomainViolation | null {
    const protectedDomains = getOperationDomains()
    if (protectedDomains.size === 0 || accounts.length === 0) return null
    const offending = accounts.filter((a) => {
        const domain = a.email.split('@')[1]?.toLowerCase()
        return domain != null && protectedDomains.has(domain)
    })
    if (offending.length === 0) return null
    return {
        code: 'protected_sending_domain',
        message: `Cold outreach cannot send from the primary domain (${offending.map((a) => a.email).join(', ')}). ` +
            'Assign a disposable/provider inbox instead.',
    }
}

/**
 * Can this inbox carry cold campaign traffic at all? Verified, not a warm-up-only seed, and not on
 * a protected company domain. Warm-up *incompleteness* is a separate, overridable activation gate
 * and is deliberately not folded in here.
 */
export function isCampaignSenderEligible(account: { email: string; status: string; warmupOnly: boolean | null }): boolean {
    if (account.status !== 'verified') return false
    if (account.warmupOnly) return false
    if (checkProtectedSendingDomains([{ email: account.email }])) return false
    return true
}
