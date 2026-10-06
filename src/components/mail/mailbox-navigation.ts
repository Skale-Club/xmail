import type { Mailbox } from '../../hooks/useMailbox'

export interface MailboxGroup {
    domain: string
    mailboxes: Mailbox[]
}

/** Window event that asks the mailbox switcher to focus its search box (shortcut "g m"). */
export const FOCUS_MAILBOX_SEARCH_EVENT = 'xmail:focus-mailbox-search'

const PINNED_MAILBOXES_STORAGE_PREFIX = 'xmail:mail:pinned-mailboxes'
const SHOW_OTHER_ORGS_STORAGE_PREFIX = 'xmail:mail:show-other-orgs'

/** Switcher preferences are per user: two people sharing a browser must not share pins. */
export function pinnedMailboxesStorageKey(userId: string | null | undefined): string {
    return `${PINNED_MAILBOXES_STORAGE_PREFIX}:${userId || 'anonymous'}`
}

export function showOtherOrgsStorageKey(userId: string | null | undefined): string {
    return `${SHOW_OTHER_ORGS_STORAGE_PREFIX}:${userId || 'anonymous'}`
}

function searchableMailboxText(mailbox: Mailbox): string {
    return `${mailbox.displayName ?? ''} ${mailbox.email} ${mailbox.organizationName ?? ''}`.toLocaleLowerCase()
}

export function mailboxLocalPart(email: string): string {
    return email.split('@')[0] || email
}

export function mailboxDomain(email: string): string {
    return email.split('@')[1]?.toLocaleLowerCase() || 'Other'
}

/** Operation mailboxes (company domains or the user's own) show by default; the API says which. */
export function isOperationMailbox(mailbox: Mailbox): boolean {
    return mailbox.isOperationMailbox !== false
}

/** Heading for a client-organization group: the organization, or the email domain as a fallback. */
export function otherOrganizationLabel(mailbox: Mailbox): string {
    return mailbox.organizationName?.trim() || mailboxDomain(mailbox.email)
}

function mailboxLabel(mailbox: Mailbox): string {
    return mailbox.displayName || mailboxLocalPart(mailbox.email)
}

function compareMailboxes(a: Mailbox, b: Mailbox): number {
    return mailboxLabel(a).localeCompare(mailboxLabel(b), undefined, { sensitivity: 'base' })
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
        mailboxes: [...groupedMailboxes].sort(compareMailboxes),
    })).sort((a, b) => a.domain.localeCompare(b.domain, undefined, { sensitivity: 'base' }))
}

export interface MailboxSections {
    pinned: Mailbox[]
    operationGroups: MailboxGroup[]
    /** Client-organization mailboxes, grouped under the organization name (domain as fallback). */
    otherGroups: MailboxGroup[]
    /** Other-organization mailboxes currently hidden behind the toggle. */
    hiddenOtherCount: number
    /** All other-organization mailboxes, hidden or not. */
    otherCount: number
}

/**
 * Splits the mailbox list into what the switcher renders.
 *
 *  - Other-organization mailboxes are hidden unless `showOthers` is on or the user is searching
 *    (a search has to be able to find them); the selected mailbox is always kept visible.
 *  - Pinned mailboxes float to the top regardless of group.
 */
export function buildMailboxSections(
    mailboxes: Mailbox[],
    options: { query: string; pinnedIds: ReadonlySet<string>; selectedId: string | null; showOthers: boolean },
): MailboxSections {
    const normalizedQuery = options.query.trim().toLocaleLowerCase()
    const matching = normalizedQuery
        ? mailboxes.filter(mailbox => searchableMailboxText(mailbox).includes(normalizedQuery))
        : mailboxes

    const operation = matching.filter(isOperationMailbox)
    const others = matching.filter(mailbox => !isOperationMailbox(mailbox))
    const revealOthers = options.showOthers || normalizedQuery.length > 0
    const visibleOthers = revealOthers
        ? others
        : others.filter(mailbox => mailbox.id === options.selectedId)

    const isPinned = (mailbox: Mailbox) => options.pinnedIds.has(mailbox.id)
    const pinned = [...operation, ...visibleOthers].filter(isPinned).sort(compareMailboxes)

    const byOrganization = new Map<string, Mailbox[]>()
    for (const mailbox of visibleOthers.filter(item => !isPinned(item))) {
        const label = otherOrganizationLabel(mailbox)
        const current = byOrganization.get(label)
        if (current) current.push(mailbox)
        else byOrganization.set(label, [mailbox])
    }
    const otherGroups = Array.from(byOrganization, ([domain, grouped]) => ({
        domain,
        mailboxes: [...grouped].sort(compareMailboxes),
    })).sort((a, b) => a.domain.localeCompare(b.domain, undefined, { sensitivity: 'base' }))

    return {
        pinned,
        operationGroups: groupMailboxes(operation.filter(item => !isPinned(item)), ''),
        otherGroups,
        hiddenOtherCount: others.length - visibleOthers.length,
        otherCount: others.length,
    }
}

/** Reads the stored pinned ids; anything malformed means "no pins". */
export function parseStoredIds(raw: string | null | undefined): Set<string> {
    if (!raw) return new Set()
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((value): value is string => typeof value === 'string'))
    } catch {
        return new Set()
    }
}

export function togglePinned(ids: ReadonlySet<string>, id: string): Set<string> {
    const next = new Set(ids)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
}

/** Unread badge text: capped so a huge backlog does not break the row layout. */
export function formatUnreadBadge(count: number | undefined): string | null {
    if (!count || count <= 0) return null
    return count > 99 ? '99+' : String(count)
}
