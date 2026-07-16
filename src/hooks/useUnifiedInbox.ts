// ============================================================
// Unified Inbox — organization-keyed TanStack Query hooks (Phase 22 UIX-01/02)
// ============================================================
// The list is a cursor-paginated `useInfiniteQuery`: the SERVER owns pagination via its
// opaque `(lastMessageAt,id)` keyset cursor, prior pages are retained in-session, and a
// filter change starts a brand-new query (its key includes the filter signature) rather
// than filtering a downloaded mailbox in memory.
//
// Every key is scoped by `organizationId`, so switching organizations yields fresh keys
// (no cross-tenant list/thread/count reuse) and disables fetching when no org is selected.

import { useCallback, useEffect, useState } from 'react'
import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
    type QueryClient,
    type UseInfiniteQueryResult,
    type InfiniteData,
} from '@tanstack/react-query'
import {
    applyInboxSuppression,
    attachInboxLabel,
    bulkUpdateInboxConversations,
    cancelInboxSendCommand,
    createInboxLabel,
    createInboxReminder,
    createInboxSendCommand,
    deleteInboxAttachment,
    deleteInboxReminder,
    detachInboxLabel,
    getInboxConversation,
    getInboxSendCommand,
    getInboxUnreadCount,
    inboxKeys,
    isInboxListQueryKey,
    listConversationReminders,
    listInboxAccountOptions,
    listInboxCampaignOptions,
    listInboxConversations,
    listInboxLabels,
    listInboxSnippets,
    previewInboxSuppression,
    setInboxArchived,
    setInboxReadState,
    setInboxStatus,
    updateInboxReminder,
    uploadInboxAttachment,
    type BulkInboxAction,
    type BulkInboxInput,
    type BulkInboxResult,
    type CreateSendCommandInput,
    type InboxAccountOption,
    type InboxCampaignOption,
    type InboxConversationDetail,
    type InboxConversationListItem,
    type InboxConversationListResponse,
    type InboxConversationState,
    type InboxConversationSummary,
    type InboxLabel,
    type InboxReminder,
    type InboxReminderStatus,
    type InboxSendCommand,
    type InboxSnippet,
    type SuppressionScope,
} from '../lib/unified-inbox-api'
import { listFilterSignature, type InboxUrlState } from '../lib/unified-inbox-url'

const LIST_PAGE_SIZE = 25

/**
 * Cursor-paginated conversation list for the selected organization + filter set.
 * A shared deep-link cursor (state.cursor) seeds the first page; `fetchNextPage` walks
 * the server keyset. Retained pages are keyed by (org, filter signature) only — never by
 * cursor or the selected conversation — so load-more accumulates and a filter change resets.
 */
export function useInboxConversations(
    organizationId: string | undefined,
    state: InboxUrlState,
): UseInfiniteQueryResult<InfiniteData<InboxConversationListResponse>, Error> {
    const signature = listFilterSignature(state)
    return useInfiniteQuery({
        queryKey: inboxKeys.list(organizationId, signature),
        enabled: !!organizationId,
        initialPageParam: state.cursor ?? null,
        queryFn: ({ pageParam }) =>
            listInboxConversations(organizationId as string, state, LIST_PAGE_SIZE, pageParam as string | null),
        getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    })
}

/** Full normalized thread for one conversation, org-scoped and disabled without a selection. */
export function useInboxConversation(
    organizationId: string | undefined,
    conversationId: string | undefined,
) {
    return useQuery<InboxConversationDetail, Error>({
        queryKey: inboxKeys.detail(organizationId, conversationId ?? '__none__'),
        enabled: !!organizationId && !!conversationId,
        queryFn: () => getInboxConversation(organizationId as string, conversationId as string),
    })
}

/** Org-scoped unread aggregate for the navigation badge. Bounded polling (SSE is a later plan). */
export function useInboxUnreadCount(organizationId: string | undefined) {
    return useQuery<number, Error>({
        queryKey: inboxKeys.unread(organizationId),
        enabled: !!organizationId,
        queryFn: () => getInboxUnreadCount(organizationId as string),
        refetchInterval: 120_000,
        staleTime: 60_000,
    })
}

export function useInboxLabels(organizationId: string | undefined) {
    return useQuery<InboxLabel[], Error>({
        queryKey: inboxKeys.labels(organizationId),
        enabled: !!organizationId,
        queryFn: () => listInboxLabels(organizationId as string),
    })
}

export function useInboxCampaignOptions(organizationId: string | undefined) {
    return useQuery<InboxCampaignOption[], Error>({
        queryKey: inboxKeys.campaigns(organizationId),
        enabled: !!organizationId,
        queryFn: () => listInboxCampaignOptions(organizationId as string),
        staleTime: 5 * 60_000,
    })
}

export function useInboxAccountOptions(organizationId: string | undefined) {
    return useQuery<InboxAccountOption[], Error>({
        queryKey: inboxKeys.accounts(organizationId),
        enabled: !!organizationId,
        queryFn: () => listInboxAccountOptions(organizationId as string),
        staleTime: 5 * 60_000,
    })
}

// ============================================================
// Operator mutations — optimistic UI WITH snapshot rollback (locked decision #4)
// ============================================================
// Every mutation carries organizationId, patches ONLY deterministic fields on both the list
// and thread caches, snapshots the exact prior state, and restores it byte-for-byte on any
// 4xx/5xx. On success it reconciles from the server's returned conversation/version, then
// invalidates the org's list + unread aggregate so the server has the final word on ordering
// and membership (an archived row leaves a non-archived view only when the server re-filters).

type ListSnapshot = Array<[readonly unknown[], unknown]>

type ConversationItemUpdater = (item: InboxConversationListItem) => InboxConversationListItem | null

function isOrgListQuery(organizationId: string | undefined) {
    return (query: { queryKey: readonly unknown[] }) => isInboxListQueryKey(query.queryKey, organizationId)
}

function mapListData(
    data: InfiniteData<InboxConversationListResponse> | undefined,
    updater: ConversationItemUpdater,
): InfiniteData<InboxConversationListResponse> | undefined {
    if (!data) return data
    return {
        ...data,
        pages: data.pages.map((page) => {
            const conversations = page.conversations
                .map(updater)
                .filter((c): c is InboxConversationListItem => c !== null)
            return { ...page, conversations, count: conversations.length }
        }),
    }
}

function snapshotInboxLists(queryClient: QueryClient, organizationId: string | undefined): ListSnapshot {
    return queryClient.getQueriesData({ predicate: isOrgListQuery(organizationId) })
}

function restoreInboxLists(queryClient: QueryClient, snapshots: ListSnapshot): void {
    for (const [queryKey, data] of snapshots) queryClient.setQueryData(queryKey, data)
}

function patchInboxLists(
    queryClient: QueryClient,
    organizationId: string | undefined,
    updater: ConversationItemUpdater,
): void {
    queryClient.setQueriesData(
        { predicate: isOrgListQuery(organizationId) },
        (data) => mapListData(data as InfiniteData<InboxConversationListResponse> | undefined, updater),
    )
}

function patchInboxDetail(
    queryClient: QueryClient,
    organizationId: string | undefined,
    conversationId: string,
    updater: (summary: InboxConversationSummary) => InboxConversationSummary,
): void {
    const key = inboxKeys.detail(organizationId, conversationId)
    queryClient.setQueryData<InboxConversationDetail>(key, (detail) =>
        detail ? { ...detail, conversation: updater(detail.conversation) } : detail,
    )
}

interface OptimisticContext {
    listSnapshots: ListSnapshot
    detailKey: readonly unknown[]
    detailSnapshot: InboxConversationDetail | undefined
}

/**
 * Shared engine for a single-conversation optimistic mutation. It snapshots every affected
 * list + the detail, patches the target conversation in place, rolls back on error, reconciles
 * from the server response on success, and invalidates the unread + list caches on settle.
 */
function useOptimisticConversationMutation<TVars extends { conversationId: string }, TData>(
    organizationId: string | undefined,
    mutationFn: (vars: TVars) => Promise<TData>,
    patchItem: (item: InboxConversationListItem, vars: TVars) => InboxConversationListItem | null,
    patchSummary: (summary: InboxConversationSummary, vars: TVars) => InboxConversationSummary,
    reconcile?: (queryClient: QueryClient, data: TData, vars: TVars) => void,
) {
    const queryClient = useQueryClient()
    return useMutation<TData, Error, TVars, OptimisticContext>({
        mutationFn,
        onMutate: async (vars) => {
            const detailKey = inboxKeys.detail(organizationId, vars.conversationId)
            await queryClient.cancelQueries({ predicate: isOrgListQuery(organizationId) })
            await queryClient.cancelQueries({ queryKey: detailKey })
            const listSnapshots = snapshotInboxLists(queryClient, organizationId)
            const detailSnapshot = queryClient.getQueryData<InboxConversationDetail>(detailKey)
            patchInboxLists(queryClient, organizationId, (item) =>
                item.id === vars.conversationId ? patchItem(item, vars) : item,
            )
            patchInboxDetail(queryClient, organizationId, vars.conversationId, (s) => patchSummary(s, vars))
            return { listSnapshots, detailKey, detailSnapshot }
        },
        onError: (_error, _vars, context) => {
            if (!context) return
            restoreInboxLists(queryClient, context.listSnapshots)
            queryClient.setQueryData(context.detailKey, context.detailSnapshot)
        },
        onSuccess: (data, vars) => {
            reconcile?.(queryClient, data, vars)
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: inboxKeys.unread(organizationId) })
            queryClient.invalidateQueries({ predicate: isOrgListQuery(organizationId) })
        },
    })
}

/** Toggle explicit per-user read/unread. Optimistically flips `unread`, reconciles to server truth. */
export function useInboxReadState(organizationId: string | undefined) {
    return useOptimisticConversationMutation<{ conversationId: string; read: boolean }, { conversationId: string; read: boolean; unread: boolean }>(
        organizationId,
        ({ conversationId, read }) => setInboxReadState(organizationId as string, conversationId, read),
        (item, { read }) => ({ ...item, unread: !read }),
        (summary, { read }) => ({ ...summary, unread: !read }),
        (queryClient, data, vars) => {
            patchInboxLists(queryClient, organizationId, (item) =>
                item.id === vars.conversationId ? { ...item, unread: data.unread } : item,
            )
            patchInboxDetail(queryClient, organizationId, vars.conversationId, (s) => ({ ...s, unread: data.unread }))
        },
    )
}

/** Archive / restore a conversation. Reconciles `archived` from the returned server state. */
export function useInboxArchive(organizationId: string | undefined) {
    return useOptimisticConversationMutation<{ conversationId: string; archived: boolean }, InboxConversationState>(
        organizationId,
        ({ conversationId, archived }) => setInboxArchived(organizationId as string, conversationId, archived),
        (item, { archived }) => ({ ...item, archived }),
        (summary, { archived }) => ({ ...summary, archived }),
        (queryClient, data, vars) => {
            patchInboxLists(queryClient, organizationId, (item) =>
                item.id === vars.conversationId ? { ...item, archived: data.archived, status: data.status } : item,
            )
            patchInboxDetail(queryClient, organizationId, vars.conversationId, (s) => ({ ...s, archived: data.archived, status: data.status }))
        },
    )
}

/** Open / close a conversation's status. */
export function useInboxStatus(organizationId: string | undefined) {
    return useOptimisticConversationMutation<{ conversationId: string; status: InboxConversationState['status'] }, InboxConversationState>(
        organizationId,
        ({ conversationId, status }) => setInboxStatus(organizationId as string, conversationId, status),
        (item, { status }) => ({ ...item, status }),
        (summary, { status }) => ({ ...summary, status }),
        (queryClient, data, vars) => {
            patchInboxLists(queryClient, organizationId, (item) =>
                item.id === vars.conversationId ? { ...item, status: data.status, archived: data.archived } : item,
            )
            patchInboxDetail(queryClient, organizationId, vars.conversationId, (s) => ({ ...s, status: data.status, archived: data.archived }))
        },
    )
}

function addLabel(labels: InboxLabel[], label: InboxLabel): InboxLabel[] {
    return labels.some((l) => l.id === label.id) ? labels : [...labels, label]
}

/** Attach a label to a conversation (optimistically adds it to both caches). */
export function useInboxLabelAttach(organizationId: string | undefined) {
    return useOptimisticConversationMutation<{ conversationId: string; label: InboxLabel }, void>(
        organizationId,
        ({ conversationId, label }) => attachInboxLabel(organizationId as string, conversationId, label.id),
        (item, { label }) => ({ ...item, labels: addLabel(item.labels, label) }),
        (summary, { label }) => ({ ...summary, labels: addLabel(summary.labels, label) }),
    )
}

/** Detach a label from a conversation (optimistically removes it from both caches). */
export function useInboxLabelDetach(organizationId: string | undefined) {
    return useOptimisticConversationMutation<{ conversationId: string; labelId: string }, void>(
        organizationId,
        ({ conversationId, labelId }) => detachInboxLabel(organizationId as string, conversationId, labelId),
        (item, { labelId }) => ({ ...item, labels: item.labels.filter((l) => l.id !== labelId) }),
        (summary, { labelId }) => ({ ...summary, labels: summary.labels.filter((l) => l.id !== labelId) }),
    )
}

/** Create a named label (non-optimistic; invalidates the org label list on success). */
export function useCreateInboxLabel(organizationId: string | undefined) {
    const queryClient = useQueryClient()
    return useMutation<InboxLabel, Error, { name: string; color?: string | null }>({
        mutationFn: ({ name, color }) => createInboxLabel(organizationId as string, name, color),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: inboxKeys.labels(organizationId) })
        },
    })
}

/**
 * Bounded bulk action over the CURRENTLY LOADED, explicitly-selected set only (never a
 * filter-wide "select all N matching"). Snapshots + patches every affected list, rolls back on
 * error, and reconciles from the server's matched/updated/skipped accounting on settle.
 */
export function useInboxBulkAction(organizationId: string | undefined) {
    const queryClient = useQueryClient()
    return useMutation<BulkInboxResult, Error, BulkInboxInput & { label?: InboxLabel }, { listSnapshots: ListSnapshot }>({
        mutationFn: ({ label: _label, ...input }) => bulkUpdateInboxConversations(organizationId as string, input),
        onMutate: async (vars) => {
            await queryClient.cancelQueries({ predicate: isOrgListQuery(organizationId) })
            const listSnapshots = snapshotInboxLists(queryClient, organizationId)
            const ids = new Set(vars.conversationIds)
            patchInboxLists(queryClient, organizationId, (item) => {
                if (!ids.has(item.id)) return item
                return applyBulkOptimistic(item, vars)
            })
            for (const id of vars.conversationIds) {
                patchInboxDetail(queryClient, organizationId, id, (s) => applyBulkSummaryOptimistic(s, vars))
            }
            return { listSnapshots }
        },
        onError: (_error, _vars, context) => {
            if (context) restoreInboxLists(queryClient, context.listSnapshots)
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: inboxKeys.unread(organizationId) })
            queryClient.invalidateQueries({ predicate: isOrgListQuery(organizationId) })
        },
    })
}

function applyBulkOptimistic(
    item: InboxConversationListItem,
    vars: BulkInboxInput & { label?: InboxLabel },
): InboxConversationListItem {
    switch (vars.action) {
        case 'read':
            return { ...item, unread: false }
        case 'unread':
            return { ...item, unread: true }
        case 'status':
            return vars.status ? { ...item, status: vars.status } : item
        case 'archive':
            return { ...item, archived: true }
        case 'unarchive':
            return { ...item, archived: false }
        case 'add_label':
            return vars.label ? { ...item, labels: addLabel(item.labels, vars.label) } : item
        case 'remove_label':
            return vars.labelId ? { ...item, labels: item.labels.filter((l) => l.id !== vars.labelId) } : item
        default:
            return item
    }
}

function applyBulkSummaryOptimistic(
    summary: InboxConversationSummary,
    vars: BulkInboxInput & { label?: InboxLabel },
): InboxConversationSummary {
    switch (vars.action) {
        case 'read':
            return { ...summary, unread: false }
        case 'unread':
            return { ...summary, unread: true }
        case 'status':
            return vars.status ? { ...summary, status: vars.status } : summary
        case 'archive':
            return { ...summary, archived: true }
        case 'unarchive':
            return { ...summary, archived: false }
        case 'add_label':
            return vars.label ? { ...summary, labels: addLabel(summary.labels, vars.label) } : summary
        case 'remove_label':
            return vars.labelId ? { ...summary, labels: summary.labels.filter((l) => l.id !== vars.labelId) } : summary
        default:
            return summary
    }
}

// Re-export the action type so callers building bulk requests don't import from two modules.
export type { BulkInboxAction }

// --- Reminders -----------------------------------------------

export function useInboxConversationReminders(
    organizationId: string | undefined,
    conversationId: string | undefined,
) {
    return useQuery<InboxReminder[], Error>({
        queryKey: inboxKeys.reminders(organizationId, conversationId ?? '__none__'),
        enabled: !!organizationId && !!conversationId,
        queryFn: () => listConversationReminders(organizationId as string, conversationId as string),
    })
}

/** Create / reschedule / cancel a durable reminder. Invalidates the conversation's reminders + list. */
export function useInboxReminderMutations(organizationId: string | undefined, conversationId: string | undefined) {
    const queryClient = useQueryClient()
    const invalidate = () => {
        if (conversationId) {
            queryClient.invalidateQueries({ queryKey: inboxKeys.reminders(organizationId, conversationId) })
        }
        queryClient.invalidateQueries({ predicate: isOrgListQuery(organizationId) })
    }

    const create = useMutation<InboxReminder, Error, { remindAt: string; note?: string | null }>({
        mutationFn: ({ remindAt, note }) => createInboxReminder(organizationId as string, conversationId as string, remindAt, note),
        onSuccess: invalidate,
    })
    const update = useMutation<InboxReminder, Error, { reminderId: string; remindAt?: string; note?: string | null; status?: InboxReminderStatus }>({
        mutationFn: ({ reminderId, ...patch }) => updateInboxReminder(organizationId as string, reminderId, patch),
        onSuccess: invalidate,
    })
    const remove = useMutation<void, Error, { reminderId: string }>({
        mutationFn: ({ reminderId }) => deleteInboxReminder(organizationId as string, reminderId),
        onSuccess: invalidate,
    })
    return { create, update, remove }
}

// --- Snippets --------------------------------------------------

export function useInboxSnippets(organizationId: string | undefined) {
    return useQuery<InboxSnippet[], Error>({
        queryKey: inboxKeys.snippets(organizationId),
        enabled: !!organizationId,
        queryFn: () => listInboxSnippets(organizationId as string),
        staleTime: 5 * 60_000,
    })
}

// --- Reply composer: durable send commands + attachments (locked #5/#6/#7) ---
// Replies are never sent from React: `send` POSTs a durable command the server resolves +
// dispatches through the policy gate. We then POLL the command's durable state (scheduled →
// queued → sent, or a policy-denial code) and, on a confirmed send, refresh the thread + list.

const TERMINAL_COMMAND_STATUSES = new Set(['sent', 'failed', 'cancelled', 'held'])

export function useInboxComposer(organizationId: string | undefined, conversationId: string | undefined) {
    const queryClient = useQueryClient()
    const [activeCommandId, setActiveCommandId] = useState<string | null>(null)

    const commandQuery = useQuery<InboxSendCommand, Error>({
        queryKey: inboxKeys.sendCommand(organizationId, activeCommandId ?? '__none__'),
        enabled: !!organizationId && !!activeCommandId,
        queryFn: () => getInboxSendCommand(organizationId as string, activeCommandId as string),
        refetchInterval: (query) => {
            const status = query.state.data?.status
            if (status && TERMINAL_COMMAND_STATUSES.has(status)) return false
            return 3000
        },
    })

    // On a confirmed send, the thread has a new outbound message and list ordering changes.
    const settledStatus = commandQuery.data?.status
    useEffect(() => {
        if (settledStatus === 'sent') {
            if (conversationId) queryClient.invalidateQueries({ queryKey: inboxKeys.detail(organizationId, conversationId) })
            queryClient.invalidateQueries({ predicate: isOrgListQuery(organizationId) })
            queryClient.invalidateQueries({ queryKey: inboxKeys.unread(organizationId) })
        }
    }, [settledStatus, organizationId, conversationId, queryClient])

    const send = useCallback(async (input: CreateSendCommandInput): Promise<InboxSendCommand> => {
        const command = await createInboxSendCommand(organizationId as string, conversationId as string, input)
        setActiveCommandId(command.id)
        return command
    }, [organizationId, conversationId])

    const cancel = useCallback((commandId: string) => {
        cancelInboxSendCommand(organizationId as string, commandId)
            .then(() => commandQuery.refetch())
            .catch(() => undefined)
    }, [organizationId, commandQuery])

    const uploadAttachment = useCallback(
        (file: File) => uploadInboxAttachment(organizationId as string, conversationId as string, file),
        [organizationId, conversationId],
    )
    const removeAttachment = useCallback(
        (attachmentId: string) => deleteInboxAttachment(organizationId as string, attachmentId),
        [organizationId],
    )

    return {
        send,
        cancel,
        uploadAttachment,
        removeAttachment,
        polledCommand: commandQuery.data ?? null,
        reset: () => setActiveCommandId(null),
    }
}

// --- Suppression (destructive; server-authoritative) ----------

/**
 * Suppression controller. `preview` classifies the target server-side (public-domain,
 * already-suppressed, warnings) BEFORE any confirmation; `apply` executes the block and, on
 * success, invalidates the org's conversations/unread so a now-suppressed sender reflects
 * everywhere. A public-domain block at domain scope is rejected by the server (400).
 */
export function useInboxSuppression(organizationId: string | undefined) {
    const queryClient = useQueryClient()
    const applyMutation = useMutation({
        mutationFn: ({ email, scope }: { email: string; scope: SuppressionScope }) =>
            applyInboxSuppression(organizationId as string, email, scope),
        onSuccess: () => {
            queryClient.invalidateQueries({ predicate: isOrgListQuery(organizationId) })
            queryClient.invalidateQueries({ queryKey: inboxKeys.unread(organizationId) })
        },
    })
    return {
        preview: (email: string, scope: SuppressionScope) => previewInboxSuppression(organizationId as string, email, scope),
        apply: (email: string, scope: SuppressionScope) => applyMutation.mutateAsync({ email, scope }),
        isApplying: applyMutation.isPending,
    }
}
