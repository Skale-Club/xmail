import type { Mailbox } from '../../hooks/useMailbox'

export interface MailboxGroup {
    domain: string
    mailboxes: Mailbox[]
}

function searchableMailboxText(mailbox: Mailbox): string {
    return `${mailbox.displayName ?? ''} ${mailbox.email}`.toLocaleLowerCase()
}

export function mailboxLocalPart(email: string): string {
    return email.split('@')[0] || email
}

export function mailboxDomain(email: string): string {
    return email.split('@')[1]?.toLocaleLowerCase() || 'Other'
}

/**
 * Filters first so a search never leaves empty domain headings, then groups and
 * sorts deterministically. Admins can have dozens of native mailboxes, so the
 * API's creation-date order is not a useful navigation structure.
 */
export function groupMailboxes(mailboxes: Mailbox[], query: string): MailboxGroup[] {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const byDomain = new Map<string, Mailbox[]>()

    for (const mailbox of mailboxes) {
        if (normalizedQuery && !searchableMailboxText(mailbox).includes(normalizedQuery)) {
            continue
        }

        const domain = mailboxDomain(mailbox.email)
        const current = byDomain.get(domain)
        if (current) {
            current.push(mailbox)
        } else {
            byDomain.set(domain, [mailbox])
        }
    }

    return Array.from(byDomain, ([domain, groupedMailboxes]) => ({
        domain,
        mailboxes: [...groupedMailboxes].sort((a, b) => {
            const aLabel = a.displayName || mailboxLocalPart(a.email)
            const bLabel = b.displayName || mailboxLocalPart(b.email)
            return aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' })
        }),
    })).sort((a, b) => a.domain.localeCompare(b.domain, undefined, { sensitivity: 'base' }))
}
