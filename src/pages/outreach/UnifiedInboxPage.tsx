import React from 'react'
import { useLocation, useSearch } from 'wouter'
import { AlertTriangle, ArrowLeft, Filter, Inbox as InboxIcon, Search, X } from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { InboxFilterRail } from '../../components/outreach/inbox/InboxFilterRail'
import { Skeleton } from '../../components/ui/Skeleton'
import { Button } from '../../components/ui/button'
import { useOrganization } from '../../hooks/useOrganization'
import {
    useInboxAccountOptions,
    useInboxCampaignOptions,
    useInboxConversation,
    useInboxConversations,
    useInboxLabels,
    useInboxUnreadCount,
} from '../../hooks/useUnifiedInbox'
import {
    buildInboxSearch,
    hasAnyFilter,
    mergeInboxState,
    parseInboxUrl,
    type InboxUrlState,
} from '../../lib/unified-inbox-url'
import type { InboxConversationListItem } from '../../lib/unified-inbox-api'
import { cn, formatRelativeDate, truncate } from '../../lib/utils'

const INBOX_PATH = '/outreach/unified-inbox'

function toUrl(state: InboxUrlState): string {
    const qs = buildInboxSearch(state)
    return qs ? `${INBOX_PATH}?${qs}` : INBOX_PATH
}

export function UnifiedInboxPage() {
    const { currentOrganization } = useOrganization()
    const organizationId = currentOrganization?.id
    const [, navigate] = useLocation()
    const search = useSearch()
    const state = React.useMemo(() => parseInboxUrl(search), [search])
    const stateRef = React.useRef(state)
    stateRef.current = state

    const [filtersOpen, setFiltersOpen] = React.useState(false)

    // --- URL hygiene: discard unknown/invalid params with replaceState so a poisoned
    // query never reaches the server. buildInboxSearch is a fixed point, so this
    // converges in one replace.
    const cleaned = React.useMemo(() => buildInboxSearch(state), [state])
    React.useEffect(() => {
        if (search !== cleaned) {
            navigate(cleaned ? `${INBOX_PATH}?${cleaned}` : INBOX_PATH, { replace: true })
        }
    }, [search, cleaned, navigate])

    // --- Organization change: never render another tenant's selection/cursor. Query keys
    // are org-scoped so caches don't bleed; we also drop the selected conversation + cursor
    // from the URL (they belong to the previous tenant). A ref avoids clearing a valid
    // deep-link selection on first mount.
    const prevOrgRef = React.useRef<string | undefined>(organizationId)
    React.useEffect(() => {
        if (prevOrgRef.current !== undefined && prevOrgRef.current !== organizationId) {
            const current = stateRef.current
            if (current.conversation || current.cursor) {
                navigate(toUrl(mergeInboxState(current, { conversation: undefined, cursor: undefined })), { replace: true })
            }
            setFiltersOpen(false)
        }
        prevOrgRef.current = organizationId
    }, [organizationId, navigate])

    const applyPatch = React.useCallback((patch: Partial<InboxUrlState>) => {
        navigate(toUrl(mergeInboxState(stateRef.current, patch)))
    }, [navigate])

    const selectConversation = React.useCallback((conversationId: string) => {
        applyPatch({ conversation: conversationId })
        setFiltersOpen(false)
    }, [applyPatch])

    const clearSelection = React.useCallback(() => {
        applyPatch({ conversation: undefined })
    }, [applyPatch])

    const clearFilters = React.useCallback(() => {
        navigate(toUrl({ labels: [], conversation: stateRef.current.conversation }))
        setFiltersOpen(false)
    }, [navigate])

    // --- Data (all org-scoped; disabled without an organization) ---
    const listQuery = useInboxConversations(organizationId, state)
    const labelsQuery = useInboxLabels(organizationId)
    const campaignsQuery = useInboxCampaignOptions(organizationId)
    const accountsQuery = useInboxAccountOptions(organizationId)
    const unreadQuery = useInboxUnreadCount(organizationId)
    const detailQuery = useInboxConversation(organizationId, state.conversation)

    const conversations = React.useMemo(
        () => listQuery.data?.pages.flatMap((page) => page.conversations) ?? [],
        [listQuery.data],
    )
    const syncStatus = listQuery.data?.pages[0]?.syncStatus ?? []
    const lastUpdatedAt = listQuery.dataUpdatedAt ? new Date(listQuery.dataUpdatedAt) : null

    // --- Search box (debounced; the URL remains authoritative) ---
    const [searchInput, setSearchInput] = React.useState(state.q ?? '')
    React.useEffect(() => { setSearchInput(state.q ?? '') }, [state.q])
    React.useEffect(() => {
        const trimmed = searchInput.trim()
        if (trimmed === (stateRef.current.q ?? '')) return
        const timer = setTimeout(() => applyPatch({ q: trimmed || undefined }), 300)
        return () => clearTimeout(timer)
    }, [searchInput, applyPatch])

    if (!organizationId) {
        return (
            <OutreachLayout>
                <div className="flex h-64 items-center justify-center">
                    <p className="text-muted-foreground">Select an organization to open the inbox</p>
                </div>
            </OutreachLayout>
        )
    }

    const selectedId = state.conversation ?? null
    const filterRailProps = {
        state,
        onPatch: applyPatch,
        onClearFilters: clearFilters,
        unreadCount: unreadQuery.data,
        labels: labelsQuery.data ?? [],
        labelsLoading: labelsQuery.isLoading,
        campaigns: campaignsQuery.data ?? [],
        accounts: accountsQuery.data ?? [],
        syncStatus,
        lastUpdatedAt,
        syncError: listQuery.isError,
        syncFetching: listQuery.isFetching,
    }

    return (
        <OutreachLayout>
            <div className="-m-4 flex h-[calc(100vh-4rem)] flex-col lg:-m-6">
                {/* Workspace header */}
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                    <h1 className="text-lg font-semibold text-foreground">Unified Inbox</h1>
                    <Button
                        variant="outline"
                        size="sm"
                        className="xl:hidden"
                        onClick={() => setFiltersOpen(true)}
                    >
                        <Filter className="mr-1.5 h-4 w-4" />
                        Filters
                        {hasAnyFilter(state) && (
                            <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[0.6rem] font-semibold text-primary-foreground">
                                {(state.labels.length) + (state.q ? 1 : 0) + (state.campaign ? 1 : 0) + (state.account ? 1 : 0)}
                            </span>
                        )}
                    </Button>
                </div>

                <div className="flex min-h-0 flex-1">
                    {/* Desktop filter rail (>=1280px) */}
                    <div className="hidden shrink-0 xl:flex">
                        <InboxFilterRail {...filterRailProps} variant="rail" />
                    </div>

                    {/* Conversation list — the default mobile stage */}
                    <section
                        aria-label="Conversations"
                        className={cn(
                            'min-h-0 flex-col border-r border-border md:w-80 md:shrink-0 xl:w-[380px]',
                            selectedId ? 'hidden md:flex' : 'flex w-full',
                        )}
                    >
                        {/* Sticky search */}
                        <div className="border-b border-border p-3">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                                <input
                                    type="search"
                                    value={searchInput}
                                    onChange={(event) => setSearchInput(event.target.value)}
                                    placeholder="Search conversations…"
                                    aria-label="Search conversations"
                                    className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto">
                            <p className="sr-only" role="status" aria-live="polite">
                                {listQuery.isLoading ? 'Loading conversations' : `${conversations.length} conversations loaded`}
                            </p>

                            {listQuery.isLoading ? (
                                <ul className="divide-y divide-border">
                                    {Array.from({ length: 8 }).map((_, index) => (
                                        <li key={index} className="space-y-2 p-3">
                                            <Skeleton className="h-4 w-2/3" />
                                            <Skeleton className="h-3 w-1/2" />
                                            <Skeleton className="h-3 w-11/12" />
                                        </li>
                                    ))}
                                </ul>
                            ) : listQuery.isError ? (
                                <div className="p-6 text-center">
                                    <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600 dark:text-amber-400" />
                                    <p className="mb-3 text-sm text-muted-foreground">Couldn’t load conversations.</p>
                                    <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>Retry</Button>
                                </div>
                            ) : conversations.length === 0 ? (
                                <div className="p-8 text-center">
                                    {hasAnyFilter(state) ? (
                                        <>
                                            <p className="mb-2 text-sm font-medium text-foreground">No conversations match these filters</p>
                                            <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
                                        </>
                                    ) : (
                                        <>
                                            <InboxIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                                            <p className="text-sm font-medium text-foreground">No outreach replies yet</p>
                                            <p className="mt-1 text-sm text-muted-foreground">Replies to your campaigns will appear here.</p>
                                        </>
                                    )}
                                </div>
                            ) : (
                                <>
                                    <ul className="divide-y divide-border">
                                        {conversations.map((conversation) => (
                                            <ListRowPreview
                                                key={conversation.id}
                                                conversation={conversation}
                                                selected={conversation.id === selectedId}
                                                onSelect={selectConversation}
                                            />
                                        ))}
                                    </ul>
                                    {listQuery.hasNextPage && (
                                        <div className="p-3">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="w-full"
                                                disabled={listQuery.isFetchingNextPage}
                                                onClick={() => listQuery.fetchNextPage()}
                                            >
                                                {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
                                            </Button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </section>

                    {/* Thread pane */}
                    <section
                        aria-label="Conversation thread"
                        className={cn('min-h-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden md:flex')}
                    >
                        {!selectedId ? (
                            <div className="flex h-full items-center justify-center p-8 text-center">
                                <p className="text-sm text-muted-foreground">Select a conversation to read the thread</p>
                            </div>
                        ) : (
                            <div className="flex h-full flex-col">
                                <div className="flex items-center gap-2 border-b border-border p-3">
                                    <button
                                        type="button"
                                        onClick={clearSelection}
                                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                                    >
                                        <ArrowLeft className="h-4 w-4" /> Back
                                    </button>
                                    <h2 className="truncate text-base font-semibold text-foreground">
                                        {detailQuery.data?.conversation.subject || '(No subject)'}
                                    </h2>
                                    <button
                                        type="button"
                                        onClick={clearSelection}
                                        aria-label="Close thread"
                                        className="ml-auto hidden rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                                    {detailQuery.isLoading ? (
                                        <div className="space-y-3">
                                            <Skeleton className="h-4 w-1/2" />
                                            <Skeleton className="h-24 w-full" />
                                            <Skeleton className="h-24 w-full" />
                                        </div>
                                    ) : detailQuery.isError ? (
                                        <div className="p-6 text-center">
                                            <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600 dark:text-amber-400" />
                                            <p className="mb-3 text-sm text-muted-foreground">Couldn’t load this conversation.</p>
                                            <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()}>Retry</Button>
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">
                                            {detailQuery.data?.messages.length ?? 0} messages
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </section>
                </div>

                {/* Tablet/mobile filter overlay (<1280px) */}
                {filtersOpen && (
                    <div className="fixed inset-0 z-50 flex xl:hidden">
                        <div className="absolute inset-0 bg-black/50" onClick={() => setFiltersOpen(false)} aria-hidden="true" />
                        <div className="relative ml-auto flex h-full w-72 max-w-[85vw] flex-col bg-card shadow-xl">
                            <div className="flex items-center justify-between border-b border-border p-3">
                                <span className="text-sm font-semibold">Filters</span>
                                <button
                                    type="button"
                                    onClick={() => setFiltersOpen(false)}
                                    aria-label="Close filters"
                                    className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto">
                                <InboxFilterRail {...filterRailProps} variant="overlay" />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </OutreachLayout>
    )
}

/** Temporary lightweight list row for the shell. Task 3 replaces this with the full
 *  ConversationList (attribution badges, attachment/reminder cues, keyboard semantics). */
function ListRowPreview({
    conversation,
    selected,
    onSelect,
}: {
    conversation: InboxConversationListItem
    selected: boolean
    onSelect: (id: string) => void
}) {
    const primary = conversation.participants.find((p) => p.role === 'from') ?? conversation.participants[0]
    const displayName = primary?.name || primary?.address || 'Unknown sender'

    return (
        <li>
            <button
                type="button"
                onClick={() => onSelect(conversation.id)}
                aria-current={selected ? 'true' : undefined}
                className={cn(
                    'flex w-full flex-col gap-1 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    selected ? 'bg-accent' : 'hover:bg-accent/50',
                )}
            >
                <div className="flex items-center gap-2">
                    {conversation.unread && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    )}
                    <span className={cn('flex-1 truncate text-sm', conversation.unread ? 'font-semibold text-foreground' : 'text-foreground')}>
                        {displayName}
                    </span>
                    {conversation.lastMessageAt && (
                        <span className="shrink-0 text-xs text-muted-foreground" title={conversation.lastMessageAt}>
                            {formatRelativeDate(conversation.lastMessageAt)}
                        </span>
                    )}
                </div>
                <span className="truncate text-sm text-muted-foreground">{conversation.subject || '(No subject)'}</span>
                {conversation.preview && (
                    <span className="truncate text-xs text-muted-foreground">{truncate(conversation.preview, 120)}</span>
                )}
                {conversation.unread && <span className="sr-only">Unread</span>}
            </button>
        </li>
    )
}

export default UnifiedInboxPage
