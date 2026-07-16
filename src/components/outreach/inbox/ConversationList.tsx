import { AlertTriangle, Archive, CheckCircle2, CheckSquare, Inbox as InboxIcon, Mail, Search, Target } from 'lucide-react'
import type React from 'react'
import { Button } from '../../ui/button'
import { Skeleton } from '../../ui/Skeleton'
import { cn, formatRelativeDate, truncate } from '../../../lib/utils'
import type { InboxConversationListItem } from '../../../lib/unified-inbox-api'

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
    /** emailAccountId -> provider label, derived from the list response sync status. */
    providerByAccount: Record<string, string>
    /** campaignId -> human name, from the campaign index. */
    campaignNameById: Record<string, string>
    // --- Bulk selection (bounded to the loaded set) ---
    bulkMode?: boolean
    onEnterBulkMode?: () => void
    selectedIds?: Set<string>
    onToggleSelect?: (id: string) => void
    /** The bounded bulk toolbar, composed by the page and rendered above the rows in bulk mode. */
    bulkBar?: React.ReactNode
}

function ConversationRow({
    conversation,
    selected,
    onSelect,
    providerByAccount,
    campaignNameById,
    bulkMode,
    checked,
    onToggleSelect,
}: {
    conversation: InboxConversationListItem
    selected: boolean
    onSelect: (id: string) => void
    providerByAccount: Record<string, string>
    campaignNameById: Record<string, string>
    bulkMode?: boolean
    checked?: boolean
    onToggleSelect?: (id: string) => void
}) {
    const primary = conversation.participants.find((p) => p.role === 'from') ?? conversation.participants[0]
    const displayName = primary?.name || primary?.address || 'Unknown sender'
    const provider = providerByAccount[conversation.emailAccountId]
    const campaignName = conversation.campaignId ? campaignNameById[conversation.campaignId] : undefined
    const exactTime = conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString() : undefined

    return (
        <li className={cn(bulkMode && 'flex items-center gap-1 pl-2')}>
            {bulkMode && (
                <input
                    type="checkbox"
                    checked={Boolean(checked)}
                    onChange={() => onToggleSelect?.(conversation.id)}
                    // Checkbox labels name the conversation subject/lead — never "Select row".
                    aria-label={`Select conversation with ${displayName}: ${conversation.subject || 'No subject'}`}
                    className="h-5 w-5 shrink-0 rounded border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            )}
            <button
                type="button"
                onClick={() => onSelect(conversation.id)}
                aria-current={selected ? 'true' : undefined}
                aria-label={`Conversation with ${displayName}: ${conversation.subject || 'No subject'}${conversation.unread ? ', unread' : ''}`}
                className={cn(
                    'flex min-h-[4.5rem] w-full min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    selected ? 'bg-accent' : 'hover:bg-accent/50',
                )}
            >
                <div className="flex items-center gap-2">
                    <span
                        className={cn('h-2 w-2 shrink-0 rounded-full', conversation.unread ? 'bg-primary' : 'bg-transparent')}
                        aria-hidden="true"
                    />
                    <span className={cn('flex-1 truncate text-sm', conversation.unread ? 'font-semibold text-foreground' : 'text-foreground')}>
                        {displayName}
                    </span>
                    {conversation.lastMessageAt && (
                        <span className="shrink-0 text-xs text-muted-foreground" title={exactTime}>
                            {formatRelativeDate(conversation.lastMessageAt)}
                        </span>
                    )}
                </div>

                <span className={cn('truncate text-sm', conversation.unread ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {conversation.subject || '(No subject)'}
                </span>

                {conversation.preview && (
                    <span className="truncate text-xs text-muted-foreground">{truncate(conversation.preview, 140)}</span>
                )}

                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {campaignName && (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                            <Target className="h-3 w-3" aria-hidden="true" />
                            <span className="max-w-[8rem] truncate">{campaignName}</span>
                        </span>
                    )}
                    {provider && (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] capitalize text-muted-foreground">
                            <Mail className="h-3 w-3" aria-hidden="true" />
                            {provider}
                        </span>
                    )}
                    {conversation.labels.map((label) => (
                        <span key={label.id} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                            <span
                                className="h-2 w-2 rounded-full border border-border"
                                style={label.color ? { backgroundColor: label.color } : undefined}
                                aria-hidden="true"
                            />
                            {label.name}
                        </span>
                    ))}
                    {conversation.archived && (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                            <Archive className="h-3 w-3" aria-hidden="true" /> Archived
                        </span>
                    )}
                    {conversation.status === 'closed' && (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Closed
                        </span>
                    )}
                </div>
                {conversation.unread && <span className="sr-only">Unread</span>}
            </button>
        </li>
    )
}

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
        providerByAccount,
        campaignNameById,
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
                            type="search"
                            value={searchValue}
                            onChange={(event) => onSearchChange(event.target.value)}
                            placeholder="Search conversations…"
                            aria-label="Search conversations"
                            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
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
                                    onSelect={onSelect}
                                    providerByAccount={providerByAccount}
                                    campaignNameById={campaignNameById}
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
