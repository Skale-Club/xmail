import React from 'react'
import { useLocation, useSearch } from 'wouter'
import { Filter, X } from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { InboxFilterRail } from '../../components/outreach/inbox/InboxFilterRail'
import { ConversationList } from '../../components/outreach/inbox/ConversationList'
import { ConversationThread } from '../../components/outreach/inbox/ConversationThread'
import { ConversationComposer } from '../../components/outreach/inbox/ConversationComposer'
import { BulkActionsBar, ConversationActions } from '../../components/outreach/inbox/ConversationActions'
import { AiDraftAssistant } from '../../components/outreach/inbox/AiDraftAssistant'
import { AiAutomationHistory } from '../../components/outreach/inbox/AiAutomationHistory'
import { Button } from '../../components/ui/button'
import { useOrganization } from '../../hooks/useOrganization'
import {
    useCreateInboxLabel,
    useInboxAccountOptions,
    useInboxAiRuns,
    useInboxAiSettings,
    useInboxAiSuggestion,
    useInboxArchive,
    useInboxBulkAction,
    useInboxCampaignOptions,
    useInboxConversation,
    useInboxConversationReminders,
    useInboxConversations,
    useInboxLabelAttach,
    useInboxLabelDetach,
    useInboxLabels,
    useInboxComposer,
    useInboxReadState,
    useInboxReminderMutations,
    useInboxSnippets,
    useInboxStatus,
    useInboxSuppression,
    useInboxUnreadCount,
} from '../../hooks/useUnifiedInbox'
import { useInboxRealtimeStatus } from '../../hooks/useUnifiedInboxEvents'
import { INBOX_BULK_LIMIT, type InboxLabel } from '../../lib/unified-inbox-api'
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
    // are org-scoped so caches never bleed; we also drop the selected conversation + cursor AND
    // the campaign/account/label filter UUIDs (all belong to the previous tenant — querying org B
    // with org-A ids yields empty/400 results), plus the bulk selection (org-A conversation ids).
    // A ref avoids clearing a valid deep link on mount.
    const prevOrgRef = React.useRef<string | undefined>(organizationId)
    React.useEffect(() => {
        if (prevOrgRef.current !== undefined && prevOrgRef.current !== organizationId) {
            const current = stateRef.current
            if (current.conversation || current.cursor || current.campaign || current.account || current.labels.length > 0) {
                navigate(toUrl(mergeInboxState(current, {
                    conversation: undefined,
                    cursor: undefined,
                    campaign: undefined,
                    account: undefined,
                    labels: [],
                })), { replace: true })
            }
            // The bulk selection holds the previous org's conversation ids — clear it so a bulk
            // action can never POST org-A ids under organizationId=B (a stale, rejected no-op).
            setBulkMode(false)
            setSelectedIds(new Set())
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
    const remindersQuery = useInboxConversationReminders(organizationId, state.conversation)

    // --- Operator mutations (optimistic + rollback live inside the hooks) ---
    const readState = useInboxReadState(organizationId)
    const archive = useInboxArchive(organizationId)
    const statusMutation = useInboxStatus(organizationId)
    const labelAttach = useInboxLabelAttach(organizationId)
    const labelDetach = useInboxLabelDetach(organizationId)
    const createLabel = useCreateInboxLabel(organizationId)
    const bulk = useInboxBulkAction(organizationId)
    const reminderMutations = useInboxReminderMutations(organizationId, state.conversation)
    const suppression = useInboxSuppression(organizationId)
    const snippetsQuery = useInboxSnippets(organizationId)
    const composer = useInboxComposer(organizationId, state.conversation)

    // --- AI draft assistant (human-in-the-loop; never sends — locked #6) ---
    const aiSettings = useInboxAiSettings(organizationId)
    const aiRunsQuery = useInboxAiRuns(organizationId, state.conversation)
    const aiSuggestion = useInboxAiSuggestion(organizationId, state.conversation)
    const draftAssistanceEnabled = aiSettings.data?.draftAssistanceEnabled ?? false

    // Near-real-time status from the SINGLE SSE stream opened by OutreachLayout (locked #9).
    // The page consumes it read-only to surface the degraded-sync marker; it never opens a
    // second stream. When live, the badge/list/open-thread converge via cache invalidation
    // WITHOUT stealing focus or touching the composer (the composer holds its own local state).
    const realtime = useInboxRealtimeStatus()

    // --- Bulk selection: BOUNDED to the currently loaded set (never a filter-wide selector) ---
    const [bulkMode, setBulkMode] = React.useState(false)
    const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set())

    const toggleSelect = React.useCallback((id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else if (next.size < INBOX_BULK_LIMIT) next.add(id)
            return next
        })
    }, [])
    const exitBulk = React.useCallback(() => { setBulkMode(false); setSelectedIds(new Set()) }, [])
    const clearBulkSelection = React.useCallback(() => setSelectedIds(new Set()), [])

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

    // Select only the CURRENTLY LOADED rows, bounded to the server ceiling. There is no
    // "select all N matching" — the copy and the request only ever cover loaded, chosen rows.
    const selectAllLoaded = React.useCallback(() => {
        setSelectedIds(new Set(conversations.slice(0, INBOX_BULK_LIMIT).map((c) => c.id)))
    }, [conversations])

    const runBulk = React.useCallback((action: 'read' | 'unread' | 'archive' | 'add_label', label?: InboxLabel) => {
        const ids = Array.from(selectedIds)
        if (ids.length === 0 || ids.length > INBOX_BULK_LIMIT) return
        bulk.mutate(
            { conversationIds: ids, action, labelId: label?.id, label },
            { onSuccess: () => setSelectedIds(new Set()) },
        )
    }, [bulk, selectedIds])

    const labels = labelsQuery.data ?? []
    const detailConversation = detailQuery.data?.conversation
    const counterpartyEmail = React.useMemo(() => {
        const participants = detailQuery.data?.participants ?? []
        const from = participants.find((p) => p.role === 'from') ?? participants[0]
        return from?.address ?? null
    }, [detailQuery.data])
    const accountOptions = accountsQuery.data ?? []

    // DISPLAY-ONLY recipient/subject preview from the latest inbound message. The SERVER
    // re-derives and validates recipients + threading headers on send — this is never trusted.
    const composerPreview = React.useMemo(() => {
        const messages = detailQuery.data?.messages ?? []
        const selfEmail = accountOptions.find((a) => a.id === detailConversation?.emailAccountId)?.email?.toLowerCase() ?? ''
        const latestInbound = [...messages].reverse().find((m) => m.direction === 'inbound') ?? messages[messages.length - 1]
        const notSelf = (addr: string) => addr && addr.toLowerCase() !== selfEmail
        const replyTo = latestInbound?.fromAddress && notSelf(latestInbound.fromAddress) ? [latestInbound.fromAddress] : []
        const ccPool = [
            ...(latestInbound?.toAddresses ?? []).map((a) => a.address),
            ...(latestInbound?.ccAddresses ?? []).map((a) => a.address),
        ]
        const cc = Array.from(new Set(ccPool.map((a) => a.toLowerCase())))
            .filter((a) => notSelf(a) && !replyTo.map((r) => r.toLowerCase()).includes(a))
        const baseSubject = (detailConversation?.subject ?? '').replace(/^(re|fwd?|fw)\s*:\s*/i, '').trim()
        return {
            replyTo,
            cc,
            subject: `Re: ${baseSubject || '(no subject)'}`,
        }
    }, [detailQuery.data, accountOptions, detailConversation])

    const conversationComposer = detailConversation && accountOptions.length > 0 ? (
        <ConversationComposer
            key={detailConversation.id}
            accounts={accountOptions}
            defaultAccountId={detailConversation.emailAccountId}
            replyToPreview={composerPreview.replyTo}
            replyAllCcPreview={composerPreview.cc}
            subjectPreview={composerPreview.subject}
            snippets={snippetsQuery.data ?? []}
            onSend={composer.send}
            onUploadAttachment={composer.uploadAttachment}
            onRemoveAttachment={composer.removeAttachment}
            onCancelCommand={composer.cancel}
            polledCommand={composer.polledCommand}
            renderAiAssistant={(insertDraft) => (
                <AiDraftAssistant
                    enabled={draftAssistanceEnabled}
                    onRequest={(tone) => aiSuggestion.request(tone)}
                    onInsert={(draftBody) => insertDraft(draftBody)}
                    onAccept={(runId) => aiSuggestion.accept(runId)}
                    history={aiRunsQuery.data ?? []}
                />
            )}
        />
    ) : null

    const bulkBar = (
        <BulkActionsBar
            selectedCount={selectedIds.size}
            limit={INBOX_BULK_LIMIT}
            labels={labels}
            onBulkReadState={(read) => runBulk(read ? 'read' : 'unread')}
            onBulkArchive={() => runBulk('archive')}
            onBulkAddLabel={(label) => runBulk('add_label', label)}
            onSelectAllLoaded={selectAllLoaded}
            onClear={clearBulkSelection}
            onExit={exitBulk}
            busy={bulk.isPending}
        />
    )

    const conversationActions = detailConversation ? (
        <ConversationActions
            conversation={detailConversation}
            labels={labels}
            reminders={remindersQuery.data}
            counterpartyEmail={counterpartyEmail}
            suppression={suppression}
            onToggleRead={(read) => readState.mutate({ conversationId: detailConversation.id, read })}
            onToggleArchive={(archived) => archive.mutate({ conversationId: detailConversation.id, archived })}
            onSetStatus={(status) => statusMutation.mutate({ conversationId: detailConversation.id, status })}
            onAttachLabel={(label) => labelAttach.mutate({ conversationId: detailConversation.id, label })}
            onDetachLabel={(labelId) => labelDetach.mutate({ conversationId: detailConversation.id, labelId })}
            onCreateReminder={(remindAt, note) => reminderMutations.create.mutate({ remindAt, note })}
            // Label attach/detach share this gate with read/archive/status so single-conversation
            // optimistic mutations never overlap. Concurrent mutations snapshot the same org-wide
            // list, so one's rollback could otherwise revert another's applied optimistic patch.
            busy={readState.isPending || archive.isPending || statusMutation.isPending || labelAttach.isPending || labelDetach.isPending}
        />
    ) : null

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
        realtimeStatus: realtime.status,
        realtimeStale: realtime.isStale,
        onCreateLabel: (name: string) => createLabel.mutate({ name }),
        creatingLabel: createLabel.isPending,
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
                            bulkMode={bulkMode}
                            onEnterBulkMode={() => setBulkMode(true)}
                            selectedIds={selectedIds}
                            onToggleSelect={toggleSelect}
                            bulkBar={bulkBar}
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
                                actions={conversationActions}
                                composer={conversationComposer}
                                aiHistory={
                                    (aiRunsQuery.data?.length ?? 0) > 0
                                        ? <AiAutomationHistory runs={aiRunsQuery.data} />
                                        : undefined
                                }
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
