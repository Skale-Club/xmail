import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MailboxChangeBatch, MailboxRealtimeStatus } from './useMailboxEvents'

/**
 * useInfiniteMessages + the live stream, with the stream replaced by a controllable fake: a
 * pushed 'message.new' for the OPEN folder runs the first-page check at once (and refetches the
 * list when it changed); other folders do not; and the polling interval relaxes only while live.
 */

const getMessages = vi.hoisted(() => vi.fn())
const getFolders = vi.hoisted(() => vi.fn())
const stream = vi.hoisted(() => ({
    status: 'live' as 'live' | 'connecting' | 'offline',
    onBatch: null as ((batch: unknown) => void) | null,
}))

vi.mock('../lib/mail-api', () => ({ mailApi: { getMessages, getFolders } }))
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('./useMailbox', () => {
    const mailbox = { id: 'box-1' }
    return { useMailbox: () => ({ selectedMailbox: mailbox }) }
})
vi.mock('./useMailboxEvents', () => ({
    useMailboxEvents: (_id: string | undefined, onBatch?: (batch: unknown) => void) => {
        stream.onBatch = onBatch ?? null
        return { status: stream.status }
    },
}))

import { MAIL_POLL_INTERVAL_MS, MAIL_POLL_LIVE_INTERVAL_MS, pushImpact, useInfiniteMessages } from './useMail'

function message(id: string) {
    return {
        id,
        mailboxId: 'box-1',
        folder: 'inbox',
        messageId: id,
        from: { name: '', email: 'a@b.c' },
        to: [],
        subject: id,
        read: false,
        starred: false,
        createdAt: '2026-10-06T00:00:00.000Z',
    }
}
const pageOf = (...ids: string[]) => ({ messages: ids.map(message), total: ids.length, hasMore: false })

function batch(partial: Partial<{ newFolders: Array<string | null>; updatedFolders: Array<string | null>; counts: boolean; resync: boolean }>): MailboxChangeBatch {
    return {
        newFolders: new Set(partial.newFolders ?? []),
        updatedFolders: new Set(partial.updatedFolders ?? []),
        counts: partial.counts ?? true,
        resync: partial.resync ?? false,
    }
}

function wrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
}

beforeEach(() => {
    getMessages.mockReset()
    getFolders.mockReset()
    getFolders.mockResolvedValue({
        folders: [
            { id: 'f-inbox', name: 'Inbox', type: 'inbox', count: 1, unread: 1 },
            { id: 'f-sent', name: 'Sent', type: 'sent', count: 0, unread: 0 },
        ],
    })
    getMessages.mockResolvedValue(pageOf('m1'))
    stream.status = 'live'
    stream.onBatch = null
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => {
    vi.useRealTimers()
})

describe('pushImpact', () => {
    it('treats arrivals and resyncs as immediate, flag changes as throttled, others as nothing', () => {
        expect(pushImpact(batch({ newFolders: ['f-inbox'] }), 'f-inbox')).toBe('arrival')
        expect(pushImpact(batch({ newFolders: [null] }), 'f-inbox')).toBe('arrival')
        expect(pushImpact(batch({ resync: true }), 'f-inbox')).toBe('arrival')
        expect(pushImpact(batch({ updatedFolders: ['f-inbox'] }), 'f-inbox')).toBe('update')
        expect(pushImpact(batch({ newFolders: ['f-sent'], updatedFolders: ['f-sent'] }), 'f-inbox')).toBe('none')
        expect(pushImpact(batch({ counts: true }), 'f-inbox')).toBe('none')
    })

    it('for the cross-folder Starred view only flag changes matter', () => {
        expect(pushImpact(batch({ newFolders: ['f-inbox'] }), undefined)).toBe('none')
        expect(pushImpact(batch({ updatedFolders: ['f-inbox'] }), undefined)).toBe('update')
        expect(pushImpact(batch({ resync: true }), undefined)).toBe('arrival')
    })
})

describe('useInfiniteMessages with the live stream', () => {
    it('runs the first-page check at once on message.new for the open folder, and shows the new mail', async () => {
        const { result } = renderHook(() => useInfiniteMessages('inbox', 30), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.data?.pages[0].messages).toHaveLength(1))
        expect(result.current.realtimeStatus).toBe('live')
        expect(stream.onBatch).toBeTypeOf('function')

        getMessages.mockClear()
        getMessages.mockResolvedValue(pageOf('m2', 'm1'))
        await act(async () => {
            stream.onBatch!(batch({ newFolders: ['f-inbox'] }))
        })

        // First-page check (fetchPage(1)) ...
        await waitFor(() => expect(getMessages).toHaveBeenCalled())
        expect(getMessages.mock.calls[0][0]).toBe('box-1')
        expect(getMessages.mock.calls[0][1]).toBe('f-inbox')
        expect(getMessages.mock.calls[0][2]).toMatchObject({ page: 1 })
        // ... whose changed signature invalidates the list.
        await waitFor(() => expect(result.current.data?.pages[0].messages.map((m) => m.id)).toEqual(['m2', 'm1']))
    })

    it('does not touch the open list for mail that arrived in another folder', async () => {
        const { result } = renderHook(() => useInfiniteMessages('inbox', 30), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.data).toBeDefined())

        getMessages.mockClear()
        await act(async () => {
            stream.onBatch!(batch({ newFolders: ['f-sent'] }))
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(getMessages).not.toHaveBeenCalled()
    })

    it('re-checks an arrival that lands while the list query is mid-fetch instead of dropping it', async () => {
        const { result } = renderHook(() => useInfiniteMessages('inbox', 30), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.data?.pages[0].messages).toHaveLength(1))

        getMessages.mockClear()
        let release!: (value: unknown) => void
        getMessages.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
        act(() => { void result.current.refetch() })
        await waitFor(() => expect(result.current.isFetching).toBe(true))

        // The in-flight fetch may predate this arrival.
        await act(async () => {
            stream.onBatch!(batch({ newFolders: ['f-inbox'] }))
        })
        expect(getMessages).toHaveBeenCalledTimes(1)

        getMessages.mockResolvedValue(pageOf('m2', 'm1'))
        await act(async () => { release(pageOf('m1')) })
        await waitFor(() => expect(getMessages.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 })
        expect(getMessages.mock.calls[1][2]).toMatchObject({ page: 1 })
        await waitFor(() => expect(result.current.data?.pages[0].messages.map((m) => m.id)).toEqual(['m2', 'm1']), { timeout: 3_000 })
    })

    it('polls every 120 s while live and every 30 s otherwise', async () => {
        // Only the interval is faked (the first tick passes the min-gap check on its own, since the
        // last check starts at 0). waitFor itself polls with setInterval, so this
        // test lets real time pass in act() instead of using it.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
        const settle = () => act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 60))
        })

        const run = async (status: MailboxRealtimeStatus, expectedMs: number) => {
            stream.status = status
            const { result, unmount } = renderHook(() => useInfiniteMessages('inbox', 30), { wrapper: wrapper() })
            for (let i = 0; i < 20 && !result.current.data; i++) await settle()
            expect(result.current.data).toBeDefined()
            getMessages.mockClear()

            await act(async () => {
                await vi.advanceTimersByTimeAsync(expectedMs - 2_000)
            })
            await settle()
            expect(getMessages).not.toHaveBeenCalled()
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2_500)
            })
            await settle()
            expect(getMessages).toHaveBeenCalledTimes(1)
            unmount()
        }

        await run('live', MAIL_POLL_LIVE_INTERVAL_MS)
        await run('offline', MAIL_POLL_INTERVAL_MS)
        expect(MAIL_POLL_LIVE_INTERVAL_MS).toBe(120_000)
        expect(MAIL_POLL_INTERVAL_MS).toBe(30_000)
    })
})
