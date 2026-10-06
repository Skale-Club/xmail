import type { Mailbox } from '../../hooks/useMailbox'

/**
 * Mailboxes offered in the compose "From" select: active ones that belong to the operation
 * (or have no classification yet) plus the one currently chosen, so a reply from a client
 * organization's mailbox still shows its own sender. Sorted by address. The API only returns
 * mailboxes the user may open (owner, or any for platform admins), and the send route checks
 * the same rule again on the server.
 */
export function sendableMailboxes(mailboxes: Mailbox[], currentId: string | null): Mailbox[] {
    return mailboxes
        .filter(mailbox => mailbox.id === currentId || (mailbox.isActive && mailbox.isOperationMailbox !== false))
        .sort((a, b) => a.email.localeCompare(b.email, undefined, { sensitivity: 'base' }))
}

export function mailboxOptionLabel(mailbox: Pick<Mailbox, 'email' | 'displayName'>): string {
    const name = mailbox.displayName?.trim()
    return name ? `${name} <${mailbox.email}>` : mailbox.email
}
