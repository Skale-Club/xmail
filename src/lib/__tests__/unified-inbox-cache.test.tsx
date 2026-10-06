import { afterEach, describe, expect, it, vi } from 'vitest'
import { InfiniteQueryObserver, QueryClient, type InfiniteData } from '@tanstack/react-query'

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn(), apiRequest: vi.fn() }))
vi.mock('@/lib/api', () => ({ fetchWithAuth: vi.fn() }))

import { createRefreshCoalescer, refreshInboxLists, type PendingRefresh } from '../unified-inbox-cache'
import { inboxKeys, type InboxConversationListResponse } from '../unified-inbox-api'

const ORG = '11111111-1111-4111-8111-111111111111'

function page(ids: string[]): InboxConversationListResponse {
    return {
        conversations: ids.map((id) => ({ id }) as unknown as InboxConversationListResponse['conversations'][number]),
        nextCursor: 'next',
        hasMore: true,
        count: ids.length,
        syncStatus: [],
    }
}

function threePageData(): InfiniteData<InboxConversationListResponse> {
    return { pages: [page(['a']), page(['b']), page(['c'])], pageParams: [null, 'p2', 'p3'] }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('refreshInboxLists', () => {
    it('keeps every loaded page of the list a user is looking at (observed) and refetches it in place', async () => {
        const queryClient = new QueryClient()
        const key = inboxKeys.list(ORG, 'sig-observed')
        queryClient.setQueryData(key, threePageData())
        const queryFn = vi.fn(async () => page(['fresh']))
        const observer = new InfiniteQueryObserver(queryClient, {
            queryKey: key,
            queryFn,
            initialPageParam: null as string | null,
            getNextPageParam: () => undefined,
            staleTime: Infinity,
        })
        const unsubscribe = observer.subscribe(() => undefined)

        refreshInboxLists(queryClient, ORG)

        // Not truncated synchronously: the operator scrolled to page 3 and stays there.
        const data = queryClient.getQueryData<InfiniteData<InboxConversationListResponse>>(key)
        expect(data?.pages).toHaveLength(3)
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
        unsubscribe()
    })

    it('trims lists nobody is looking at to page one and only marks them stale (no request)', () => {
        const queryClient = new QueryClient()
        const key = inboxKeys.list(ORG, 'sig-unobserved')
        queryClient.setQueryData(key, threePageData())
        const fetchSpy = vi.spyOn(queryClient, 'fetchQuery')

        refreshInboxLists(queryClient, ORG)

        const data = queryClient.getQueryData<InfiniteData<InboxConversationListResponse>>(key)
        expect(data?.pages).toHaveLength(1)
        expect(data?.pageParams).toEqual([null])
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
        expect(queryClient.getQueryState(key)?.fetchStatus).toBe('idle')
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('never touches another organization or non-list queries', () => {
        const queryClient = new QueryClient()
        const otherOrg = inboxKeys.list('99999999-9999-4999-8999-999999999999', 'sig')
        queryClient.setQueryData(otherOrg, threePageData())
        const labels = inboxKeys.labels(ORG)
        queryClient.setQueryData(labels, [])

        refreshInboxLists(queryClient, ORG)

        expect(queryClient.getQueryData<InfiniteData<InboxConversationListResponse>>(otherOrg)?.pages).toHaveLength(3)
        expect(queryClient.getQueryState(otherOrg)?.isInvalidated).toBe(false)
        expect(queryClient.getQueryState(labels)?.isInvalidated).toBe(false)
    })
})

describe('createRefreshCoalescer', () => {
    it('flushes the first signal immediately and merges a burst into ONE trailing flush per window', () => {
        vi.useFakeTimers()
        const flushes: PendingRefresh[] = []
        const coalescer = createRefreshCoalescer((pending) => flushes.push(pending), 2_000)

        coalescer.push('conv-1', true) // leading edge
        expect(flushes).toHaveLength(1)
        expect([...flushes[0].conversationIds]).toEqual(['conv-1'])

        // A burst inside the window: nothing fires yet.
        coalescer.push('conv-2', true)
        coalescer.push('conv-3', true)
        coalescer.push(null, false)
        vi.advanceTimersByTime(1_999)
        expect(flushes).toHaveLength(1)

        vi.advanceTimersByTime(1)
        expect(flushes).toHaveLength(2)
        expect([...flushes[1].conversationIds].sort()).toEqual(['conv-2', 'conv-3'])
        expect(flushes[1].anyThread).toBe(false)

        // Quiet window passes with nothing pending: no extra flush, and the next signal leads again.
        vi.advanceTimersByTime(10_000)
        expect(flushes).toHaveLength(2)
        coalescer.push('conv-4', true)
        expect(flushes).toHaveLength(3)
        coalescer.dispose()
    })

    it('an org-wide thread signal marks anyThread; aggregate-only pushes never name a thread', () => {
        vi.useFakeTimers()
        const flushes: PendingRefresh[] = []
        const coalescer = createRefreshCoalescer((pending) => flushes.push(pending), 2_000)
        coalescer.push(null, false) // poll fallback
        expect(flushes[0].anyThread).toBe(false)
        expect(flushes[0].conversationIds.size).toBe(0)
        coalescer.push(null, true)
        vi.advanceTimersByTime(2_000)
        expect(flushes[1].anyThread).toBe(true)
        coalescer.dispose()
    })

    it('stops flushing after dispose', () => {
        vi.useFakeTimers()
        const flush = vi.fn()
        const coalescer = createRefreshCoalescer(flush, 2_000)
        coalescer.push('a', true)
        coalescer.push('b', true)
        coalescer.dispose()
        vi.advanceTimersByTime(10_000)
        expect(flush).toHaveBeenCalledTimes(1)
    })
})
