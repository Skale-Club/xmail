// ============================================================
// Unified Inbox - shared query-cache refresh helpers
// ============================================================
// Used by both the mutation hooks (useUnifiedInbox) and the SSE channel (useUnifiedInboxEvents).
// Kept in lib/ so neither hook module has to import the other.

import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { isInboxListQueryKey, type InboxConversationListResponse } from './unified-inbox-api'

/**
 * Refresh every cached conversation list, without throwing away what the operator is looking at.
 *
 * TanStack refetches EVERY loaded page of an infinite query, so a signal used to cost N requests
 * per list (N pages x every cached filter set), and an earlier version "fixed" that by truncating
 * every list to page one, which threw a user scrolled to page three back to the top on each
 * signal. The two cases are different and are treated differently:
 *
 *  - OBSERVED lists (a mounted component is showing them): invalidated normally. They keep every
 *    page the operator loaded and refetch in place, so scroll position and loaded rows survive.
 *    There is at most one such list per tab, and callers debounce, so the cost is bounded.
 *  - UNOBSERVED lists (a filter/view the operator left): trimmed to page one and only marked
 *    stale, with no request now. Nobody sees them; when one is opened again it refetches a single
 *    page instead of N.
 */
export function refreshInboxLists(queryClient: QueryClient, organizationId: string | undefined): void {
    const queries = queryClient.getQueryCache().findAll({
        predicate: (query) => isInboxListQueryKey(query.queryKey, organizationId),
    })
    for (const query of queries) {
        if (query.getObserversCount() > 0) {
            void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
            continue
        }
        const data = query.state.data as InfiniteData<InboxConversationListResponse> | undefined
        if (data && data.pages.length > 1) {
            queryClient.setQueryData<InfiniteData<InboxConversationListResponse>>(query.queryKey, {
                pages: data.pages.slice(0, 1),
                pageParams: data.pageParams.slice(0, 1),
            })
        }
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, refetchType: 'none' })
    }
}

export interface PendingRefresh {
    /** Conversations whose open thread should converge; `null` means "any thread" (org-wide signal). */
    conversationIds: Set<string>
    anyThread: boolean
}

/**
 * Leading + trailing coalescer: runs `flush` immediately on the first call, then at most once per
 * `windowMs` with everything that arrived in between merged into one pending refresh.
 */
export function createRefreshCoalescer(
    flush: (pending: PendingRefresh) => void,
    windowMs: number,
): { push: (conversationId: string | null, includeDetail: boolean) => void; dispose: () => void } {
    let pending: PendingRefresh = { conversationIds: new Set(), anyThread: false }
    let hasPending = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const take = (): PendingRefresh => {
        const taken = pending
        pending = { conversationIds: new Set(), anyThread: false }
        hasPending = false
        return taken
    }
    const arm = () => {
        timer = setTimeout(() => {
            timer = null
            if (!hasPending) return
            flush(take())
            arm() // a flush opens a new quiet window
        }, windowMs)
    }

    return {
        push(conversationId, includeDetail) {
            if (includeDetail) {
                if (conversationId) pending.conversationIds.add(conversationId)
                else pending.anyThread = true
            }
            if (timer === null) {
                flush(take()) // leading edge: this push is flushed now, later ones coalesce
                arm()
                return
            }
            hasPending = true
        },
        dispose() {
            if (timer) clearTimeout(timer)
            timer = null
        },
    }
}

/** @deprecated Name from before observed lists were kept intact; use {@link refreshInboxLists}. */
export const refreshInboxListsFirstPage = refreshInboxLists
