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

import {
    useInfiniteQuery,
    useQuery,
    type UseInfiniteQueryResult,
    type InfiniteData,
} from '@tanstack/react-query'
import {
    getInboxConversation,
    getInboxUnreadCount,
    inboxKeys,
    listInboxAccountOptions,
    listInboxCampaignOptions,
    listInboxConversations,
    listInboxLabels,
    type InboxAccountOption,
    type InboxCampaignOption,
    type InboxConversationDetail,
    type InboxConversationListResponse,
    type InboxLabel,
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
