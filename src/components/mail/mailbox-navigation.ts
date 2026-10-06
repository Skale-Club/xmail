import type { Mailbox } from '../../hooks/useMailbox'

/** Window event that asks the mailbox switcher to focus its search box (shortcut "g m"). */
export const FOCUS_MAILBOX_SEARCH_EVENT = 'xmail:focus-mailbox-search'

const PINNED_MAILBOXES_STORAGE_PREFIX = 'xmail:mail:pinned-mailboxes'
const SHOW_OTHER_ORGS_STORAGE_PREFIX = 'xmail:mail:show-other-orgs'
const WARMUP_EXPANDED_STORAGE_PREFIX = 'xmail:mail:warmup-expanded'

/** Switcher preferences are per user: two people sharing a browser must not share pins. */
export function pinnedMailboxesStorageKey(userId: string | null | undefined): string {
    return `${PINNED_MAILBOXES_STORAGE_PREFIX}:${userId || 'anonymous'}`
}

export function showOtherOrgsStorageKey(userId: string | null | undefined): string {
    return `${SHOW_OTHER_ORGS_STORAGE_PREFIX}:${userId || 'anonymous'}`
}

export function warmupExpandedStorageKey(userId: string | null | undefined): string {
    return `${WARMUP_EXPANDED_STORAGE_PREFIX}:${userId || 'anonymous'}`
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

export type MailboxRole = 'work' | 'warmup' | 'other'

/** The switcher section a mailbox belongs to. Older APIs without `role` fall back to the operation flag. */
export function mailboxRole(mailbox: Mailbox): MailboxRole {
    if (mailbox.role) return mailbox.role
    return isOperationMailbox(mailbox) ? 'work' : 'other'
}

/** Most unread first, then by name, so the boxes that need attention sit at the top of a section. */
function compareMailboxes(a: Mailbox, b: Mailbox): number {
    const unreadDiff = (b.unreadCount ?? 0) - (a.unreadCount ?? 0)
    if (unreadDiff !== 0) return unreadDiff
    const labelA = a.displayName || mailboxLocalPart(a.email)
    const labelB = b.displayName || mailboxLocalPart(b.email)
    const byLabel = labelA.localeCompare(labelB, undefined, { sensitivity: 'base' })
    return byLabel !== 0 ? byLabel : a.email.localeCompare(b.email, undefined, { sensitivity: 'base' })
}

export interface MailboxSections {
    pinned: Mailbox[]
    work: Mailbox[]
    warmup: Mailbox[]
    other: Mailbox[]
    /** Whether the warm-up section's rows should be rendered (toggle on, or a search is running). */
    warmupOpen: boolean
    /** Whether the other-organizations section's rows should be rendered. */
    otherOpen: boolean
    /** Matching mailboxes per collapsible section, shown in the "show (N)" toggle. */
    warmupCount: number
    otherCount: number
}

/**
 * Splits the mailbox list into what the switcher renders: pinned / work / warm-up / other.
 *
 *  - Pinned mailboxes float to the top whatever their role and leave their own section.
 *  - Every section is sorted by unread count (desc), then name.
 *  - Search spans all sections. Collapsed sections (warm-up, other organizations) open by
 *    themselves while a search runs, so a match is never hidden behind a toggle.
 *  - Without a search, the rows of a collapsed section are the caller's to hide (`warmupOpen`
 *    / `otherOpen` say whether to render them); the counts are always the matching totals.
 */
export function buildMailboxSections(
    mailboxes: Mailbox[],
    options: { query: string; pinnedIds: ReadonlySet<string>; showWarmup: boolean; showOthers: boolean },
): MailboxSections {
    const normalizedQuery = options.query.trim().toLocaleLowerCase()
    const searching = normalizedQuery.length > 0
    const matching = searching
        ? mailboxes.filter(mailbox => searchableMailboxText(mailbox).includes(normalizedQuery))
        : mailboxes

    const sorted = [...matching].sort(compareMailboxes)
    const isPinned = (mailbox: Mailbox) => options.pinnedIds.has(mailbox.id)
    const unpinned = sorted.filter(mailbox => !isPinned(mailbox))
    const inRole = (role: MailboxRole) => unpinned.filter(mailbox => mailboxRole(mailbox) === role)

    const warmup = inRole('warmup')
    const other = inRole('other')

    return {
        pinned: sorted.filter(isPinned),
        work: inRole('work'),
        warmup,
        other,
        warmupOpen: options.showWarmup || searching,
        otherOpen: options.showOthers || searching,
        warmupCount: warmup.length,
        otherCount: other.length,
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
