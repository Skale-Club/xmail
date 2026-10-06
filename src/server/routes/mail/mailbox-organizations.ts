import { emailDomain } from '../../lib/operation-domains'

/**
 * Pure helper behind GET /api/mail/mailboxes: classifies each mailbox as part of the
 * operation (shown by default in the webmail switcher) or as belonging to a client
 * organization (hidden behind a toggle, grouped by organization name).
 *
 * A mailbox is an "operation mailbox" when its email domain is one of the operation's own
 * domains (MAIL_DOMAIN + OUTREACH_PROTECTED_DOMAINS), or when it is the requester's own
 * mailbox. Membership of the requester is deliberately NOT used: the platform admin belongs
 * to no organization.
 *
 * `organizationName` is the first (alphabetical) organization of the mailbox owner, or null
 * when the owner belongs to none; the client then falls back to the email domain.
 */

export interface MailboxOwnerRow {
    id: string
    userId: string
    email: string
}

export interface MembershipRow {
    userId: string
    organizationName: string
}

export interface MailboxClassification {
    organizationName: string | null
    isOperationMailbox: boolean
}

export function classifyMailboxes(input: {
    requesterId: string
    mailboxes: MailboxOwnerRow[]
    memberships: MembershipRow[]
    operationDomains: Set<string>
}): Map<string, MailboxClassification> {
    const orgNamesByUser = new Map<string, string[]>()
    for (const row of input.memberships) {
        const names = orgNamesByUser.get(row.userId) ?? []
        if (!names.includes(row.organizationName)) names.push(row.organizationName)
        orgNamesByUser.set(row.userId, names)
    }

    const result = new Map<string, MailboxClassification>()
    for (const mailbox of input.mailboxes) {
        const names = [...(orgNamesByUser.get(mailbox.userId) ?? [])]
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        const domain = emailDomain(mailbox.email)
        result.set(mailbox.id, {
            organizationName: names[0] ?? null,
            isOperationMailbox:
                mailbox.userId === input.requesterId ||
                (domain !== '' && input.operationDomains.has(domain)),
        })
    }
    return result
}
