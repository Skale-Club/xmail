import React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useLocation, useSearch } from 'wouter'
import { Filter, X } from 'lucide-react'
import { InboxFilterRail } from '../../components/outreach/inbox/InboxFilterRail'
import { ConversationList } from '../../components/outreach/inbox/ConversationList'
import { ConversationThread } from '../../components/outreach/inbox/ConversationThread'
import {
    ComposerUnavailable,
    ConversationComposer,
    type ComposerOpenRequest,
} from '../../components/outreach/inbox/ConversationComposer'
import { BulkActionsBar, ConversationActions } from '../../components/outreach/inbox/ConversationActions'
import { AiDraftAssistant } from '../../components/outreach/inbox/AiDraftAssistant'
import { AiAutomationHistory } from '../../components/outreach/inbox/AiAutomationHistory'
import { AiAutomationChip } from '../../components/outreach/inbox/AiAutomationChip'
import { ShortcutsHelp } from '../../components/outreach/inbox/ShortcutsHelp'
import { useInboxShortcuts } from '../../components/outreach/inbox/useInboxShortcuts'
import { useOrgAiAutomation } from '../../components/outreach/inbox/useOrgAiAutomation'
import { Button } from '../../components/ui/button'
import { useAuth } from '../../hooks/useAuth'
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
    useInboxCounts,
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

const INBOX_PATH = '/outreach/unified-inbox'
const RAIL_COLLAPSED_KEY = 'xmail:inbox-rail-collapsed'
const DESKTOP_QUERY = '(min-width: 1280px)'
const MD_QUERY = '(min-width: 768px)'

function toUrl(state: InboxUrlState): string {
    const qs = buildInboxSearch(state)
    return qs ? `${INBOX_PATH}?${qs}` : INBOX_PATH
}

/** Live media query. jsdom has no matchMedia: report a match (desktop). */
function useMediaQuery(queryText: string): boolean {
    const [matches, setMatches] = React.useState(() =>
        typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : window.matchMedia(queryText).matches,
    )
    React.useEffect(() => {
        if (typeof window.matchMedia !== 'function') return
        const query = window.matchMedia(queryText)
        const onChange = () => setMatches(query.matches)
        onChange()
        query.addEventListener('change', onChange)
        return () => query.removeEventListener('change', onChange)
    }, [queryText])
    return matches
}

/** Remembered rail state. Every storage access is guarded (private mode, blocked storage). */
function useRailCollapsed(): [boolean, () => void] {
    const [collapsed, setCollapsed] = React.useState(() => {
        try {
            return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1'
        } catch {
            return false
        }
    })
    const toggle = React.useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev
            try {
                window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0')
            } catch {
                /* storage unavailable: the preference just won't persist */
            }
            return next
        })
    }, [])
    return [collapsed, toggle]
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
    const [railCollapsed, toggleRailCollapsed] = useRailCollapsed()
    const isDesktop = useMediaQuery(DESKTOP_QUERY)
    // md and up shows the list next to the thread; below it the list is hidden while a thread is open.
    const isMdUp = useMediaQuery(MD_QUERY)
    const { user } = useAuth()
    const [helpOpen, setHelpOpen] = React.useState(false)
    const [cursorId, setCursorId] = React.useState<string | null>(null)
    // A shortcut-driven composer request is tied to the conversation it was made for, so it is
    // applied once by that conversation's composer and never replayed on another one.
    const [composerRequest, setComposerRequest] = React.useState<{ conversationId: string; request: ComposerOpenRequest } | null>(null)
    const composerNonceRef = React.useRef(0)
    const searchInputRef = React.useRef<HTMLInputElement | null>(null)
    const restoreFocusIdRef = React.useRef<string | null>(null)

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
            setCursorId(null)
        }
        prevOrgRef.current = organizationId
    }, [organizationId, navigate])

    const applyPatch = React.useCallback((patch: Partial<InboxUrlState>) => {
        navigate(toUrl(mergeInboxState(stateRef.current, patch)))
    }, [navigate])

    const selectConversation = React.useCallback((conversationId: string) => {
        setCursorId(conversationId)
        applyPatch({ conversation: conversationId })
        setFiltersOpen(false)
    }, [applyPatch])

    // Back / Close from the thread: remember which row was open so focus can return to it.
    const clearSelection = React.useCallback(() => {
        restoreFocusIdRef.current = stateRef.current.conversation ?? null
        applyPatch({ conversation: undefined })
    }, [applyPatch])

    React.useEffect(() => {
        if (state.conversation || !restoreFocusIdRef.current) return
        const id = restoreFocusIdRef.current
        restoreFocusIdRef.current = null
        document.querySelector<HTMLElement>(`[data-conversation-id="${id}"]`)?.focus()
    }, [state.conversation])

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
    const countsQuery = useInboxCounts(organizationId)
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

    // --- Auto mark-as-read: once the opened conversation's detail resolves unread, mark it read.
    // Bounded to once per conversation id AND last message via a ref (not state): it never re-fires
    // on a background refetch of the same state, never fights the manual "Mark unread" toggle, and
    // still marks a conversation read again when it is reopened after a new reply arrived.
    const autoReadMarkedRef = React.useRef<Set<string>>(new Set())
    React.useEffect(() => {
        const conversation = detailQuery.data?.conversation
        if (!conversation || !conversation.unread) return
        const markKey = `${conversation.id}:${conversation.lastMessageAt ?? ''}`
        if (autoReadMarkedRef.current.has(markKey)) return
        autoReadMarkedRef.current.add(markKey)
        // `upTo` is the last message the operator actually rendered: a message that lands between
        // the fetch and this call must stay unread.
        readState.mutate({ conversationId: conversation.id, read: true, upTo: conversation.lastMessageAt })
    }, [detailQuery.data, readState])

    // --- AI draft assistant (human-in-the-loop; never sends — locked #6) ---
    const aiSettings = useInboxAiSettings(organizationId)
    const aiRunsQuery = useInboxAiRuns(organizationId, state.conversation)
    const aiSuggestion = useInboxAiSuggestion(organizationId, state.conversation)
    const draftAssistanceEnabled = aiSettings.data?.draftAssistanceEnabled ?? false
    // Org AI automation status chip (shares its cache + actions with the Settings page).
    const orgAi = useOrgAiAutomation(organizationId)
    const canManageAi = currentOrganization?.role === 'admin' || currentOrganization?.role === 'member'

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

    const accountOptions = React.useMemo(() => accountsQuery.data ?? [], [accountsQuery.data])
    const accountEmailById = React.useMemo(() => {
        const map: Record<string, string> = {}
        for (const account of accountOptions) map[account.id] = account.email
        return map
    }, [accountOptions])
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

    // Hover quick actions on list rows. Stable callbacks keep the memoized rows from re-rendering.
    const archiveMutate = archive.mutate
    const readMutate = readState.mutate
    const rowToggleArchive = React.useCallback(
        (conversationId: string, archived: boolean) => archiveMutate({ conversationId, archived }),
        [archiveMutate],
    )
    const rowToggleRead = React.useCallback(
        (conversationId: string, unread: boolean) => readMutate({ conversationId, read: unread }),
        [readMutate],
    )

    const labels = labelsQuery.data ?? []
    const detailConversation = detailQuery.data?.conversation
    const counterpartyEmail = React.useMemo(() => {
        const participants = detailQuery.data?.participants ?? []
        const from = participants.find((p) => p.role === 'from') ?? participants[0]
        return from?.address ?? null
    }, [detailQuery.data])

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

    // The composer is never hidden silently: while accounts load or when there are none, an
    // explanation takes its place. Replies always leave from the conversation's own account.
    let conversationComposer: React.ReactNode = null
    if (detailConversation) {
        if (accountsQuery.isLoading) {
            conversationComposer = <ComposerUnavailable reason="loading" />
        } else if (accountOptions.length === 0) {
            conversationComposer = <ComposerUnavailable reason="no_accounts" />
        } else {
            conversationComposer = (
                <ConversationComposer
                    key={detailConversation.id}
                    conversationId={detailConversation.id}
                    draftUserId={user?.id}
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
                    openRequest={composerRequest?.conversationId === detailConversation.id ? composerRequest.request : null}
                    onOpenRequestHandled={() => setComposerRequest(null)}
                    onUncertainSend={() => detailQuery.refetch()}
                    renderAiAssistant={(insertDraft) => (
                        <AiDraftAssistant
                            enabled={draftAssistanceEnabled}
                            onRequest={(tone) => aiSuggestion.request(tone)}
                            onInsert={(draftBody) => insertDraft(draftBody)}
                            onAccept={(runId) => aiSuggestion.accept(runId)}
                        />
                    )}
                />
            )
        }
    }

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

    const conversationBusy = readState.isPending || archive.isPending || statusMutation.isPending || labelAttach.isPending || labelDetach.isPending

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
            busy={conversationBusy}
        />
    ) : null

    // --- Search box (debounced; the URL remains authoritative) ---
    // The input is only re-synced from the URL when the URL changes for a reason OTHER than our own
    // debounced write (clear filters, org switch, browser back). Syncing our own write back used to
    // re-apply the trimmed value and eat a trailing space while the operator was still typing.
    const [searchInput, setSearchInput] = React.useState(state.q ?? '')
    const lastUrlQueryRef = React.useRef<string | undefined>(state.q)
    React.useEffect(() => {
        if (state.q === lastUrlQueryRef.current) return
        lastUrlQueryRef.current = state.q
        setSearchInput(state.q ?? '')
    }, [state.q])
    React.useEffect(() => {
        const trimmed = searchInput.trim()
        if (trimmed === (stateRef.current.q ?? '')) return
        const timer = setTimeout(() => {
            lastUrlQueryRef.current = trimmed || undefined
            applyPatch({ q: trimmed || undefined })
        }, 300)
        return () => clearTimeout(timer)
    }, [searchInput, applyPatch])

    // --- Keyboard shortcuts (ignored while typing or with a dialog/menu open) ---
    const moveCursor = React.useCallback((delta: 1 | -1) => {
        if (conversations.length === 0) return
        const from = cursorId ?? stateRef.current.conversation ?? null
        const index = from ? conversations.findIndex((c) => c.id === from) : -1
        const nextIndex = index === -1
            ? (delta === 1 ? 0 : conversations.length - 1)
            : Math.min(conversations.length - 1, Math.max(0, index + delta))
        setCursorId(conversations[nextIndex].id)
    }, [conversations, cursorId])

    React.useEffect(() => {
        if (!cursorId) return
        document.querySelector<HTMLElement>(`[data-conversation-id="${cursorId}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }, [cursorId])

    // Drop a pending request when the operator moves to another conversation.
    React.useEffect(() => {
        setComposerRequest((prev) => (prev && prev.conversationId !== state.conversation ? null : prev))
    }, [state.conversation])

    const requestComposer = React.useCallback((mode: ComposerOpenRequest['mode']) => {
        const conversationId = stateRef.current.conversation
        if (!conversationId) return
        composerNonceRef.current += 1
        setComposerRequest({ conversationId, request: { mode, nonce: composerNonceRef.current } })
    }, [])

    // e / u act on the row under the j/k cursor when it differs from the open conversation AND the
    // list is actually on screen (md and up, or mobile with no thread open); otherwise on the open one.
    const shortcutTarget = React.useMemo(() => {
        const listOnScreen = isMdUp || !state.conversation
        const cursorRow = cursorId && cursorId !== state.conversation && listOnScreen
            ? conversations.find((c) => c.id === cursorId)
            : undefined
        const source = cursorRow ?? detailConversation
        return source ? { id: source.id, archived: source.archived, unread: source.unread } : null
    }, [isMdUp, state.conversation, cursorId, conversations, detailConversation])

    useInboxShortcuts({
        next: () => moveCursor(1),
        prev: () => moveCursor(-1),
        open: () => { if (cursorId) selectConversation(cursorId) },
        reply: () => requestComposer('reply'),
        replyAll: () => requestComposer('reply_all'),
        forward: () => requestComposer('forward'),
        archive: () => {
            if (!shortcutTarget || conversationBusy) return
            archive.mutate({ conversationId: shortcutTarget.id, archived: !shortcutTarget.archived })
        },
        toggleUnread: () => {
            if (!shortcutTarget || conversationBusy) return
            readState.mutate({ conversationId: shortcutTarget.id, read: shortcutTarget.unread })
        },
        focusSearch: () => searchInputRef.current?.focus(),
        toggleHelp: () => setHelpOpen((prev) => !prev),
    }, Boolean(organizationId))

    if (!organizationId) {
        return (
                <div className="flex h-64 items-center justify-center">
                    <p className="text-muted-foreground">Select an organization to open the inbox</p>
                </div>
        )
    }

    const selectedId = state.conversation ?? null
    const filterRailProps = {
        state,
        onPatch: applyPatch,
        onClearFilters: clearFilters,
        unreadCount: unreadQuery.data,
        counts: countsQuery.data,
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

    const renderAiChip = (compact: boolean) => (
        <AiAutomationChip
            settings={orgAi.settings}
            isLoading={orgAi.isLoading}
            canManage={canManageAi}
            onPause={orgAi.pause}
            onResume={orgAi.resume}
            pending={orgAi.pending}
            error={orgAi.error}
            compact={compact}
        />
    )
    const helpButton = <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />

    const filterBadgeCount = activeFilterCount(state) + (state.view || state.status ? 1 : 0)

    return (
            <div className="-m-4 flex h-[calc(100dvh-4rem)] flex-col lg:-m-6">
                {/* Below xl there is no rail: a slim bar holds the Filters sheet trigger and the tools.
                    At xl and up the page has no header row at all, so the thread gets the height. */}
                {!isDesktop && (
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                        <DialogPrimitive.Root open={filtersOpen} onOpenChange={setFiltersOpen}>
                            <DialogPrimitive.Trigger asChild>
                                <Button variant="outline" size="sm">
                                    <Filter className="mr-1.5 h-4 w-4" />
                                    Filters
                                    {hasAnyFilter(state) && (
                                        <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
                                            {filterBadgeCount}
                                        </span>
                                    )}
                                </Button>
                            </DialogPrimitive.Trigger>
                            {/* Radix gives the sheet role="dialog", a focus trap, Escape to close and
                                focus restoration to the Filters button. */}
                            <DialogPrimitive.Portal>
                                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
                                <DialogPrimitive.Content
                                    aria-modal="true"
                                    aria-describedby={undefined}
                                    className="fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col bg-card shadow-xl focus-visible:outline-none"
                                >
                                    <div className="flex items-center justify-between border-b border-border p-3">
                                        <DialogPrimitive.Title className="text-sm font-semibold">Filters</DialogPrimitive.Title>
                                        <DialogPrimitive.Close
                                            aria-label="Close filters"
                                            className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            <X className="h-4 w-4" />
                                        </DialogPrimitive.Close>
                                    </div>
                                    <div className="min-h-0 flex-1 overflow-y-auto">
                                        <InboxFilterRail {...filterRailProps} variant="overlay" />
                                    </div>
                                </DialogPrimitive.Content>
                            </DialogPrimitive.Portal>
                        </DialogPrimitive.Root>
                        <div className="ml-auto flex items-center gap-1.5">
                            {renderAiChip(false)}
                            {helpButton}
                        </div>
                    </div>
                )}

                <div className="flex min-h-0 flex-1">
                    {/* Desktop filter rail (>=1280px), collapsible and remembered */}
                    {isDesktop && (
                        <div className="flex shrink-0">
                            <InboxFilterRail
                                {...filterRailProps}
                                variant="rail"
                                collapsed={railCollapsed}
                                onToggleCollapsed={toggleRailCollapsed}
                                toolbar={<>{renderAiChip(false)}{helpButton}</>}
                                collapsedToolbar={<>{renderAiChip(true)}{helpButton}</>}
                            />
                        </div>
                    )}

                    {/* Conversation list — the default mobile stage */}
                    <section
                        aria-label="Conversations"
                        className={
                            selectedId
                                ? 'hidden min-h-0 flex-col border-r border-border md:flex md:w-80 md:shrink-0 xl:w-[340px] 2xl:w-[380px]'
                                : 'flex min-h-0 w-full flex-col border-r border-border md:w-80 md:shrink-0 xl:w-[340px] 2xl:w-[380px]'
                        }
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
                            searchInputRef={searchInputRef}
                            accountEmailById={accountEmailById}
                            campaignNameById={campaignNameById}
                            cursorId={cursorId}
                            actionsBusy={conversationBusy}
                            onToggleArchive={rowToggleArchive}
                            onToggleRead={rowToggleRead}
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
                        className={selectedId ? 'flex min-h-0 flex-1 flex-col' : 'hidden min-h-0 flex-1 flex-col md:flex'}
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
                                accountEmailById={accountEmailById}
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
            </div>
    )
}

export default UnifiedInboxPage
