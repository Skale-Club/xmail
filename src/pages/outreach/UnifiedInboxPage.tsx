import React from 'react'
import { useLocation, useSearch } from 'wouter'
import { Filter, X } from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { InboxFilterRail } from '../../components/outreach/inbox/InboxFilterRail'
import { ConversationList } from '../../components/outreach/inbox/ConversationList'
import { ConversationThread } from '../../components/outreach/inbox/ConversationThread'
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
    activeFilterCount,
    buildInboxSearch,
    hasAnyFilter,
    mergeInboxState,
    parseInboxUrl,
    type InboxUrlState,
} from '../../lib/unified-inbox-url'
import { cn } from '../../lib/utils'

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
    // query never reaches the server. buildInboxSearch is a fixed point → converges in one.
    const cleaned = React.useMemo(() => buildInboxSearch(state), [state])
    React.useEffect(() => {
        if (search !== cleaned) {
            navigate(cleaned ? `${INBOX_PATH}?${cleaned}` : INBOX_PATH, { replace: true })
        }
    }, [search, cleaned, navigate])

    // --- Organization change: never render another tenant's selection/cursor. Query keys
    // are org-scoped so caches never bleed; we also drop the selected conversation + cursor
    // (they belong to the previous tenant). A ref avoids clearing a valid deep link on mount.
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

    const providerByAccount = React.useMemo(() => {
        const map: Record<string, string> = {}
        for (const account of syncStatus) map[account.emailAccountId] = account.provider
        return map
    }, [syncStatus])
    const campaignNameById = React.useMemo(() => {
        const map: Record<string, string> = {}
        for (const campaign of campaignsQuery.data ?? []) map[campaign.id] = campaign.name
        return map
    }, [campaignsQuery.data])

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
                    <Button variant="outline" size="sm" className="xl:hidden" onClick={() => setFiltersOpen(true)}>
                        <Filter className="mr-1.5 h-4 w-4" />
                        Filters
                        {hasAnyFilter(state) && (
                            <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary px-1 text-[0.6rem] font-semibold text-primary-foreground">
                                {activeFilterCount(state) + (state.status || state.unread || state.reminder || state.archived ? 1 : 0)}
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
                            'min-h-0 flex-col border-r border-border md:flex md:w-80 md:shrink-0 xl:w-[380px]',
                            selectedId ? 'hidden' : 'flex w-full',
                        )}
                    >
                        <ConversationList
                            conversations={conversations}
                            isLoading={listQuery.isLoading}
                            isError={listQuery.isError}
                            onRetry={() => listQuery.refetch()}
                            hasMore={Boolean(listQuery.hasNextPage)}
                            isFetchingNextPage={listQuery.isFetchingNextPage}
                            onLoadMore={() => listQuery.fetchNextPage()}
                            selectedId={selectedId}
                            onSelect={selectConversation}
                            hasFilters={hasAnyFilter(state)}
                            hasSearch={Boolean(state.q)}
                            searchTerm={state.q ?? ''}
                            onClearFilters={clearFilters}
                            searchValue={searchInput}
                            onSearchChange={setSearchInput}
                            providerByAccount={providerByAccount}
                            campaignNameById={campaignNameById}
                        />
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
                            <ConversationThread
                                detail={detailQuery.data}
                                isLoading={detailQuery.isLoading}
                                isError={detailQuery.isError}
                                onRetry={() => detailQuery.refetch()}
                                onBack={clearSelection}
                                onClose={clearSelection}
                                providerByAccount={providerByAccount}
                                campaignNameById={campaignNameById}
                            />
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

export default UnifiedInboxPage
