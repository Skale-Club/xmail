import React from 'react'
import {
    AlertTriangle,
    Archive,
    ArchiveRestore,
    BellRing,
    CheckCircle2,
    CheckSquare,
    Inbox as InboxIcon,
    Mail,
    MailOpen,
    MailX,
    Search,
    Target,
    X,
    Zap,
} from 'lucide-react'
import { Button } from '../../ui/button'
import { Skeleton } from '../../ui/Skeleton'
import { cn, truncate } from '../../../lib/utils'
import { formatDateTime, formatRelativeShort } from '../../../lib/inbox-relative-time'
import type { InboxConversationListItem, InboxMessageClassification } from '../../../lib/unified-inbox-api'

// TODO(contract): the list DTO does not carry these yet. When the backend adds them, drop this
// local extension and read them straight off InboxConversationListItem. Until then the badges only
// render if the field happens to be present, and the reminder indicator also lights up for every
// row while the Reminders view is active (see `remindersView`).
export type InboxListItemExt = InboxConversationListItem & {
    /** Classification of the last inbound message (bounce / auto_reply drive a badge). */
    lastInboundClassification?: InboxMessageClassification | null
    /** A reminder on this conversation is due. */
    reminderDue?: boolean
}

export interface ConversationListProps {
    conversations: InboxConversationListItem[]
    isLoading: boolean
    isError: boolean
    onRetry: () => void
    hasMore: boolean
    isFetchingNextPage: boolean
    onLoadMore: () => void
    selectedId: string | null
    onSelect: (id: string) => void
    hasFilters: boolean
    hasSearch: boolean
    searchTerm: string
    onClearFilters: () => void
    searchValue: string
    onSearchChange: (value: string) => void
    /** Lets the page focus the search box (the "/" shortcut). */
    searchInputRef?: React.Ref<HTMLInputElement>
    /** emailAccountId -> receiving account email, from the account options. */
    accountEmailById?: Record<string, string>
    /** campaignId -> human name, from the campaign index. */
    campaignNameById: Record<string, string>
    /** Keyboard cursor (j / k), distinct from the opened conversation. */
    cursorId?: string | null
    /** The Reminders view is active: every row is there because of a reminder. */
    remindersView?: boolean
    /** Hover quick actions. Omit to hide them. */
    onToggleArchive?: (id: string, archived: boolean) => void
    onToggleRead?: (id: string, read: boolean) => void
    // --- Bulk selection (bounded to the loaded set) ---
    bulkMode?: boolean
    onEnterBulkMode?: () => void
    selectedIds?: Set<string>
    onToggleSelect?: (id: string) => void
    /** The bounded bulk toolbar, composed by the page and rendered above the rows in bulk mode. */
    bulkBar?: React.ReactNode
}

const BADGE = 'inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground'
const QUICK_BTN =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** Needs a reply from us: open, the lead wrote last (or we never wrote). */
function waitingSince(conversation: InboxConversationListItem): string | null {
    if (conversation.status !== 'open' || conversation.archived || !conversation.lastInboundAt) return null
    if (conversation.lastOutboundAt && conversation.lastOutboundAt >= conversation.lastInboundAt) return null
    return conversation.lastInboundAt
}

interface ConversationRowProps {
    conversation: InboxListItemExt
    selected: boolean
    cursor: boolean
    onSelect: (id: string) => void
    accountEmail?: string
    campaignName?: string
    remindersView?: boolean
    onToggleArchive?: (id: string, archived: boolean) => void
    onToggleRead?: (id: string, read: boolean) => void
    bulkMode?: boolean
    checked?: boolean
    onToggleSelect?: (id: string) => void
}

const ConversationRow = React.memo(function ConversationRow({
    conversation,
    selected,
    cursor,
    onSelect,
    accountEmail,
    campaignName,
    remindersView,
    onToggleArchive,
    onToggleRead,
    bulkMode,
    checked,
    onToggleSelect,
}: ConversationRowProps) {
    const primary = conversation.participants.find((p) => p.role === 'from') ?? conversation.participants[0]
    const displayName = primary?.name || primary?.address || 'Unknown sender'
    const exactTime = conversation.lastMessageAt ? formatDateTime(conversation.lastMessageAt) : undefined
    const waiting = waitingSince(conversation)
    const classification = conversation.lastInboundClassification
    const reminderDue = Boolean(conversation.reminderDue) || Boolean(remindersView)
    const visibleLabels = conversation.labels.slice(0, 2)
    const hiddenLabelCount = conversation.labels.length - visibleLabels.length

    return (
        <li className={cn('group relative', bulkMode && 'flex items-center gap-1 pl-2')}>
            {bulkMode && (
                <input
                    type="checkbox"
                    checked={Boolean(checked)}
                    onChange={() => onToggleSelect?.(conversation.id)}
                    // Checkbox labels name the conversation subject/lead, never "Select row".
                    aria-label={`Select conversation with ${displayName}: ${conversation.subject || 'No subject'}`}
                    className="h-5 w-5 shrink-0 rounded border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            )}
            <button
                type="button"
                data-conversation-id={conversation.id}
                data-cursor={cursor ? 'true' : undefined}
                onClick={() => onSelect(conversation.id)}
                aria-current={selected ? 'true' : undefined}
                aria-label={`Conversation with ${displayName}: ${conversation.subject || 'No subject'}${conversation.unread ? ', unread' : ''}`}
                className={cn(
                    'flex w-full min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    selected ? 'bg-accent' : 'hover:bg-accent/50',
                    cursor && !selected && 'ring-2 ring-inset ring-primary/60',
                )}
            >
                {/* Line 1: sender + time */}
                <div className="flex items-center gap-2">
                    <span
                        className={cn('h-2 w-2 shrink-0 rounded-full', conversation.unread ? 'bg-primary' : 'bg-transparent')}
                        aria-hidden="true"
                    />
                    <span className={cn('flex-1 truncate text-sm', conversation.unread ? 'font-semibold text-foreground' : 'text-foreground')}>
                        {displayName}
                    </span>
                    {reminderDue && (
                        <span className="shrink-0 text-amber-600 dark:text-amber-400" title="Reminder due">
                            <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
                            <span className="sr-only">Reminder due</span>
                        </span>
                    )}
                    {conversation.lastMessageAt && (
                        <span className="shrink-0 text-xs text-muted-foreground group-hover:invisible group-focus-within:invisible" title={exactTime}>
                            {formatRelativeShort(conversation.lastMessageAt)}
                        </span>
                    )}
                </div>

                {/* Line 2: subject, with the preview trailing it */}
                <span className="truncate text-sm">
                    <span className={conversation.unread ? 'font-medium text-foreground' : 'text-foreground'}>
                        {conversation.subject || '(No subject)'}
                    </span>
                    {conversation.preview && (
                        <span className="text-muted-foreground">{' — '}{truncate(conversation.preview, 100)}</span>
                    )}
                </span>

                {/* Line 3: state badges, receiving account, campaign, labels */}
                <div className="flex flex-nowrap items-center gap-1.5 overflow-hidden">
                    {waiting && (
                        <span className={cn(BADGE, 'shrink-0 bg-amber-500/15 text-amber-800 dark:text-amber-300')} title="Waiting for your reply">
                            Waiting {formatRelativeShort(waiting)}
                        </span>
                    )}
                    {classification === 'bounce' && (
                        <span className={cn(BADGE, 'shrink-0 bg-red-500/15 text-red-700 dark:text-red-300')}>
                            <MailX className="h-3 w-3" aria-hidden="true" /> Bounce
                        </span>
                    )}
                    {classification === 'auto_reply' && (
                        <span className={cn(BADGE, 'shrink-0')}>
                            <Zap className="h-3 w-3" aria-hidden="true" /> Auto reply
                        </span>
                    )}
                    {accountEmail && (
                        <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={`Received on ${accountEmail}`}>
                            <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="max-w-[9rem] truncate">{accountEmail}</span>
                        </span>
                    )}
                    {campaignName && (
                        <span className={cn(BADGE, 'min-w-0 shrink')}>
                            <Target className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="max-w-[7rem] truncate">{campaignName}</span>
                        </span>
                    )}
                    {visibleLabels.map((label) => (
                        <span key={label.id} className={cn(BADGE, 'shrink-0')}>
                            <span
                                className="h-2 w-2 rounded-full border border-border"
                                style={label.color ? { backgroundColor: label.color } : undefined}
                                aria-hidden="true"
                            />
                            {label.name}
                        </span>
                    ))}
                    {hiddenLabelCount > 0 && <span className={cn(BADGE, 'shrink-0')}>+{hiddenLabelCount}</span>}
                    {conversation.archived && (
                        <span className={cn(BADGE, 'shrink-0')}>
                            <Archive className="h-3 w-3" aria-hidden="true" /> Archived
                        </span>
                    )}
                    {conversation.status === 'closed' && (
                        <span className={cn(BADGE, 'shrink-0')}>
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Closed
                        </span>
                    )}
                </div>
                {conversation.unread && <span className="sr-only">Unread</span>}
            </button>

            {/* Hover / focus quick actions (siblings of the row button, never nested in it). */}
            {!bulkMode && (onToggleArchive || onToggleRead) && (
                <div className="absolute right-2 top-1.5 flex items-center gap-1 opacity-0 focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
                    {onToggleRead && (
                        <button
                            type="button"
                            className={QUICK_BTN}
                            onClick={() => onToggleRead(conversation.id, conversation.unread)}
                            aria-label={`${conversation.unread ? 'Mark as read' : 'Mark as unread'}: ${displayName}`}
                            title={conversation.unread ? 'Mark as read' : 'Mark as unread'}
                        >
                            {conversation.unread ? <MailOpen className="h-3.5 w-3.5" aria-hidden="true" /> : <Mail className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                    )}
                    {onToggleArchive && (
                        <button
                            type="button"
                            className={QUICK_BTN}
                            onClick={() => onToggleArchive(conversation.id, !conversation.archived)}
                            aria-label={`${conversation.archived ? 'Restore' : 'Archive'}: ${displayName}`}
                            title={conversation.archived ? 'Restore' : 'Archive'}
                        >
                            {conversation.archived ? <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" /> : <Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                    )}
                </div>
            )}
        </li>
    )
})

export function ConversationList(props: ConversationListProps) {
    const {
        conversations,
        isLoading,
        isError,
        onRetry,
        hasMore,
        isFetchingNextPage,
        onLoadMore,
        selectedId,
        onSelect,
        hasFilters,
        hasSearch,
        searchTerm,
        onClearFilters,
        searchValue,
        onSearchChange,
        searchInputRef,
        accountEmailById,
        campaignNameById,
        cursorId,
        remindersView,
        onToggleArchive,
        onToggleRead,
        bulkMode,
        onEnterBulkMode,
        selectedIds,
        onToggleSelect,
        bulkBar,
    } = props

    return (
        <div className="flex h-full flex-col">
            {/* Sticky search + bulk-mode entry */}
            <div className="border-b border-border p-3">
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                        <input
                            ref={searchInputRef}
                            type="text"
                            role="searchbox"
                            value={searchValue}
                            onChange={(event) => onSearchChange(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape' && searchValue) {
                                    event.preventDefault()
                                    onSearchChange('')
                                }
                            }}
                            placeholder="Search conversations…"
                            aria-label="Search conversations"
                            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-8 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        {searchValue && (
                            <button
                                type="button"
                                onClick={() => onSearchChange('')}
                                aria-label="Clear search"
                                className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                    {onEnterBulkMode && !bulkMode && (
                        <button
                            type="button"
                            onClick={onEnterBulkMode}
                            aria-label="Select conversations for bulk actions"
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <CheckSquare className="h-4 w-4" aria-hidden="true" /> Select
                        </button>
                    )}
                </div>
            </div>

            {bulkMode && bulkBar}

            <div className="min-h-0 flex-1 overflow-y-auto">
                <p className="sr-only" role="status" aria-live="polite">
                    {isLoading
                        ? 'Loading conversations'
                        : isError && conversations.length === 0
                            ? 'Failed to load conversations'
                            : isError
                                ? 'Couldn’t refresh conversations; showing the last loaded list'
                                : `${conversations.length} conversations loaded`}
                </p>

                {isLoading ? (
                    <ul className="divide-y divide-border" aria-hidden="true">
                        {Array.from({ length: 8 }).map((_, index) => (
                            <li key={index} className="space-y-2 p-3">
                                <Skeleton className="h-4 w-2/3" />
                                <Skeleton className="h-3 w-1/2" />
                                <Skeleton className="h-3 w-11/12" />
                            </li>
                        ))}
                    </ul>
                ) : isError && conversations.length === 0 ? (
                    // Only blank to the error card when there is NO cached data to fall back to.
                    <div className="p-6 text-center">
                        <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                        <p className="mb-3 text-sm text-muted-foreground">Couldn’t load conversations.</p>
                        <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
                    </div>
                ) : conversations.length === 0 ? (
                    <div className="p-8 text-center">
                        {hasSearch ? (
                            <>
                                <p className="mb-1 text-sm font-medium text-foreground">
                                    No conversations match “{truncate(searchTerm, 40)}”
                                </p>
                                <Button variant="outline" size="sm" onClick={onClearFilters}>Clear filters</Button>
                            </>
                        ) : hasFilters ? (
                            <>
                                <p className="mb-2 text-sm font-medium text-foreground">No conversations match these filters</p>
                                <Button variant="outline" size="sm" onClick={onClearFilters}>Clear filters</Button>
                            </>
                        ) : (
                            <>
                                <InboxIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" aria-hidden="true" />
                                <p className="text-sm font-medium text-foreground">No outreach replies yet</p>
                                <p className="mt-1 text-sm text-muted-foreground">Replies to your campaigns will appear here.</p>
                            </>
                        )}
                    </div>
                ) : (
                    <>
                        {isError && (
                            // Background refetch failed but the loaded pages are still cached: keep
                            // the rows and surface a non-destructive refresh-failed indicator.
                            <div
                                role="status"
                                className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
                            >
                                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="flex-1">Couldn’t refresh — showing the last loaded list.</span>
                                <button
                                    type="button"
                                    onClick={onRetry}
                                    className="shrink-0 font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    Retry
                                </button>
                            </div>
                        )}
                        <ul className="divide-y divide-border">
                            {conversations.map((conversation) => (
                                <ConversationRow
                                    key={conversation.id}
                                    conversation={conversation}
                                    selected={conversation.id === selectedId}
                                    cursor={conversation.id === cursorId}
                                    onSelect={onSelect}
                                    accountEmail={accountEmailById?.[conversation.emailAccountId]}
                                    campaignName={conversation.campaignId ? campaignNameById[conversation.campaignId] : undefined}
                                    remindersView={remindersView}
                                    onToggleArchive={onToggleArchive}
                                    onToggleRead={onToggleRead}
                                    bulkMode={bulkMode}
                                    checked={selectedIds?.has(conversation.id)}
                                    onToggleSelect={onToggleSelect}
                                />
                            ))}
                        </ul>
                        {hasMore && (
                            <div className="p-3">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full"
                                    disabled={isFetchingNextPage}
                                    onClick={onLoadMore}
                                >
                                    <span aria-live="polite">{isFetchingNextPage ? 'Loading…' : 'Load more'}</span>
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

export default ConversationList
