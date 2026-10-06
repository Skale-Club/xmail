// ============================================================
// Unified Inbox - shared query-cache refresh helpers
// ============================================================
// Used by both the mutation hooks (useUnifiedInbox) and the SSE channel (useUnifiedInboxEvents).
// Kept in lib/ so neither hook module has to import the other.

import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { isInboxListQueryKey, type InboxConversationListResponse } from './unified-inbox-api'

function isOrgListQuery(organizationId: string | undefined) {
    return (query: { queryKey: readonly unknown[] }) => isInboxListQueryKey(query.queryKey, organizationId)
}

/**
 * Refresh every loaded conversation list by refetching ONLY its first page. TanStack refetches
 * every loaded page of an infinite query sequentially, so a mutation or SSE signal used to cost
 * N requests per list (N pages x every cached filter set). Trimming to page one first makes the
 * refetch one request per active list; lists that are not mounted are just marked stale. Deeper
 * pages are re-fetched on demand when the operator scrolls again, which is also the only moment
 * their keyset cursors are guaranteed consistent with a list that just reordered.
 */
export function refreshInboxListsFirstPage(queryClient: QueryClient, organizationId: string | undefined): void {
    queryClient.setQueriesData<InfiniteData<InboxConversationListResponse>>(
        { predicate: isOrgListQuery(organizationId) },
        (data) => (data && data.pages.length > 1
            ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
            : data),
    )
    void queryClient.invalidateQueries({ predicate: isOrgListQuery(organizationId) })
}
