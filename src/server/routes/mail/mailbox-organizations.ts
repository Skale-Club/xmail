/**
 * Pure helper behind GET /api/mail/mailboxes: decides, for each mailbox, which
 * organizations its owner belongs to and whether the mailbox is "mine".
 *
 * A mailbox is `inMyOrganizations` when it is the requester's own, or when its
 * owner shares at least one organization with the requester. The webmail
 * switcher hides every other mailbox by default (admins can still open them).
 *
 * `organizations` lists ALL organizations of the owner, sorted by name, so the
 * client can group foreign mailboxes under `organizations[0]` and still show
 * the full list on hover. A user with no membership gets an empty list.
 */

export interface OrganizationRef {
    id: string
    name: string
}

export interface MailboxOrganizationInfo {
    organizations: OrganizationRef[]
    inMyOrganizations: boolean
}

export interface MailboxOwnerRow {
    id: string
    userId: string
}

export interface MembershipRow {
    userId: string
    organizationId: string
    organizationName: string
}

export function computeMailboxOrganizationInfo(input: {
    requesterId: string
    mailboxes: MailboxOwnerRow[]
    memberships: MembershipRow[]
}): Map<string, MailboxOrganizationInfo> {
    const orgsByUser = new Map<string, OrganizationRef[]>()
    for (const row of input.memberships) {
        const list = orgsByUser.get(row.userId) ?? []
        if (!list.some(org => org.id === row.organizationId)) {
            list.push({ id: row.organizationId, name: row.organizationName })
        }
        orgsByUser.set(row.userId, list)
    }

    const myOrgIds = new Set((orgsByUser.get(input.requesterId) ?? []).map(org => org.id))
    const result = new Map<string, MailboxOrganizationInfo>()

    for (const mailbox of input.mailboxes) {
        const organizations = [...(orgsByUser.get(mailbox.userId) ?? [])]
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
        const inMyOrganizations =
            mailbox.userId === input.requesterId ||
            organizations.some(org => myOrgIds.has(org.id))
        result.set(mailbox.id, { organizations, inMyOrganizations })
    }

    return result
}
