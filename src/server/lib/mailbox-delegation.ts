/**
 * Pure access decision for a webmail mailbox, including delegation.
 *
 * A delegate is a user explicitly listed in `mailbox_delegates` for a native mailbox owned by
 * someone else (the microsite info@ mailboxes). Delegates get webmail access (read, send, move,
 * delete messages) but never the mailbox settings (rename, deactivate, delete) and never the
 * owner's credentials: the mailbox user has no password, so SMTP/IMAP stay closed to everyone.
 */

export interface AccessRequester { id: string; isAdmin: boolean }
export interface AccessMailbox { userId: string; email: string; isNative: boolean }
export interface AccessOwner { email: string }

export type MailboxAccessKind = 'admin' | 'owner' | 'delegate' | null

export function evaluateMailboxAccess(input: {
    requester: AccessRequester
    mailbox: AccessMailbox
    owner: AccessOwner | null
    isDelegate: boolean
    /** True for operations that change the mailbox itself rather than its messages. */
    ownerOnly?: boolean
}): MailboxAccessKind {
    const { requester, mailbox, owner, isDelegate, ownerOnly } = input
    if (requester.isAdmin) return 'admin'

    const nativeMatches = !mailbox.isNative
        || (owner !== null && mailbox.email.toLowerCase() === owner.email.toLowerCase())

    if (mailbox.userId === requester.id) return nativeMatches ? 'owner' : null
    if (isDelegate && !ownerOnly && nativeMatches) return 'delegate'
    return null
}
