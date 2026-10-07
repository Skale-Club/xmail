import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * useMailboxLiveSync throttles the counter refresh (folders + mailbox list): the user's own moves
 * echo back as signals, so a burst must not turn into a request per signal.
 */

const apiRequestMock = vi.hoisted(() => vi.fn())
const refreshMailboxes = vi.hoisted(() => vi.fn())

vi.mock('../lib/api-client', () => ({
    apiRequest: apiRequestMock,
    ApiClientError: class extends Error {},
}))
vi.mock('./useMailbox', () => {
    const mailbox = { id: 'box-1' }
    return { useMailbox: () => ({ selectedMailbox: mailbox, refreshMailboxes }) }
})

import { MAILBOX_COUNTS_REFRESH_MIN_GAP_MS, MAILBOX_STREAM_CLOSE_GRACE_MS, useMailboxLiveSync } from './useMailboxEvents'

const encoder = new TextEncoder()

async function flush() {
    await act(async () => {
        for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0)
    })
}
async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
    })
}

beforeEach(() => {
    vi.useFakeTimers()
    apiRequestMock.mockReset()
    refreshMailboxes.mockReset()
})
afterEach(async () => {
    cleanup()
    await advance(MAILBOX_STREAM_CLOSE_GRACE_MS + 1)
    vi.useRealTimers()
})

describe('useMailboxLiveSync', () => {
    it('refreshes counters at once, then at most once per gap (leading + trailing)', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>
        const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
        apiRequestMock.mockResolvedValue({ ok: true, status: 200, body })
        const push = async (kind: string) => {
            const data = JSON.stringify({ mailboxId: 'box-1', folderId: 'f-inbox', kind, at: 'x' })
            controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${data}\n\n`))
            await flush()
        }

        const client = new QueryClient()
        const invalidate = vi.spyOn(client, 'invalidateQueries')
        const wrapper = ({ children }: { children: React.ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        )
        renderHook(() => useMailboxLiveSync(), { wrapper })
        await flush()

        await push('message.new')
        expect(refreshMailboxes).toHaveBeenCalledTimes(1)
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['folders', 'box-1'] })

        // Echoes inside the gap collapse into ONE trailing refresh at the end of it.
        await advance(2_000)
        await push('message.new')
        await advance(500)
        await push('message.updated')
        await advance(500)
        await push('folder.counts')
        expect(refreshMailboxes).toHaveBeenCalledTimes(1)

        await advance(MAILBOX_COUNTS_REFRESH_MIN_GAP_MS - 3_000 - 100)
        expect(refreshMailboxes).toHaveBeenCalledTimes(1)
        await advance(200)
        expect(refreshMailboxes).toHaveBeenCalledTimes(2)
        expect(invalidate).toHaveBeenCalledTimes(2)

        // Nothing is left pending.
        await advance(MAILBOX_COUNTS_REFRESH_MIN_GAP_MS * 2)
        expect(refreshMailboxes).toHaveBeenCalledTimes(2)
    })
})
