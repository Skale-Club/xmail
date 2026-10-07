import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'

/**
 * The live-updates hook, without a server: a controllable ReadableStream stands in for the SSE
 * response. Covers frame parsing, 1 s coalescing, the shared single connection per mailbox,
 * reconnect with a resync, and the grace-period teardown.
 */

const apiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('../lib/api-client', () => {
    class ApiClientError extends Error {
        status: number
        constructor(message: string, options: { status: number }) {
            super(message)
            this.status = options.status
        }
    }
    return { apiRequest: apiRequestMock, ApiClientError }
})
vi.mock('./useMailbox', () => ({ useMailbox: () => ({ selectedMailbox: null, refreshMailboxes: vi.fn() }) }))

import {
    MAILBOX_EVENT_COALESCE_MS,
    MAILBOX_RATE_LIMIT_BACKOFF_MS,
    MAILBOX_RESYNC_MIN_GAP_MS,
    MAILBOX_STREAM_CLOSE_GRACE_MS,
    MAILBOX_STREAM_STABLE_MS,
    MAILBOX_STREAM_STALL_MS,
    __mailboxStreamCount,
    useMailboxEvents,
    type MailboxBatchListener,
    type MailboxChangeBatch,
} from './useMailboxEvents'

const encoder = new TextEncoder()

function makeStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    return {
        body,
        push: (text: string) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
        error: (reason: unknown) => controller.error(reason),
    }
}

function frame(kind: string, folderId: string | null, mailboxId = 'box-1') {
    return `event: ${kind}\ndata: ${JSON.stringify({ mailboxId, folderId, kind, at: '2026-10-06T00:00:00.000Z' })}\n\n`
}

/** An SSE comment line, as the server's heartbeat sends it. */
function frameComment(text: string) {
    return `: ${text}\n\n`
}

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

function connectWith(stream: ReturnType<typeof makeStream>) {
    apiRequestMock.mockImplementationOnce(async (_path: string, options: { signal: AbortSignal }) => {
        // Like a real fetch body: aborting the request errors the stream being read.
        options.signal.addEventListener('abort', () => {
            try { stream.error(new DOMException('aborted', 'AbortError')) } catch { /* already closed */ }
        })
        return { ok: true, status: 200, body: stream.body }
    })
}

function Probe({ id, onBatch }: { id: string; onBatch?: MailboxBatchListener }) {
    const { status } = useMailboxEvents(id, onBatch)
    return <span data-testid="status">{status}</span>
}

beforeEach(() => {
    vi.useFakeTimers()
    apiRequestMock.mockReset()
})

afterEach(async () => {
    // Unmount first (hooks run in reverse, so RTL's own cleanup would come too late), then let any
    // stream left behind run out its close grace period.
    cleanup()
    await advance(MAILBOX_STREAM_CLOSE_GRACE_MS + 1)
    vi.useRealTimers()
})

describe('useMailboxEvents', () => {
    it('connects with the authenticated SSE request, parses frames and ignores heartbeats', async () => {
        const stream = makeStream()
        connectWith(stream)
        const onBatch = vi.fn()
        const { result, unmount } = renderHook(() => useMailboxEvents('box-1', onBatch))

        expect(result.current.status).toBe('connecting')
        await flush()
        expect(result.current.status).toBe('live')
        expect(apiRequestMock).toHaveBeenCalledTimes(1)
        const [path, options] = apiRequestMock.mock.calls[0]
        expect(path).toBe('/api/mail/mailboxes/box-1/events')
        expect(options.headers).toEqual({ Accept: 'text/event-stream' })
        expect(options.retry).toBe(false)

        stream.push(': connected\n\n')
        stream.push(': ping\n\n')
        await flush()
        expect(onBatch).not.toHaveBeenCalled()

        stream.push(frame('message.new', 'f-inbox'))
        await flush()
        expect(onBatch).toHaveBeenCalledTimes(1)
        const batch: MailboxChangeBatch = onBatch.mock.calls[0][0]
        expect([...batch.newFolders]).toEqual(['f-inbox'])
        expect(batch.counts).toBe(true)
        expect(batch.resync).toBe(false)

        unmount()
    })

    it('delivers the first event at once and merges a burst into ONE trailing batch', async () => {
        const stream = makeStream()
        connectWith(stream)
        const onBatch = vi.fn()
        const { unmount } = renderHook(() => useMailboxEvents('box-1', onBatch))
        await flush()

        stream.push(frame('message.new', 'f-inbox'))
        await flush()
        expect(onBatch).toHaveBeenCalledTimes(1)

        // Inside the 1 s window: nothing is delivered yet.
        stream.push(frame('message.new', 'f-inbox'))
        stream.push(frame('message.updated', 'f-archive'))
        stream.push(frame('folder.counts', 'f-inbox'))
        stream.push(frame('message.new', 'f-spam'))
        await flush()
        await advance(MAILBOX_EVENT_COALESCE_MS - 100)
        expect(onBatch).toHaveBeenCalledTimes(1)

        await advance(200)
        expect(onBatch).toHaveBeenCalledTimes(2)
        const merged: MailboxChangeBatch = onBatch.mock.calls[1][0]
        expect([...merged.newFolders].sort()).toEqual(['f-inbox', 'f-spam'])
        expect([...merged.updatedFolders]).toEqual(['f-archive'])
        expect(merged.counts).toBe(true)

        // A quiet window ends the cycle: no empty batch.
        await advance(MAILBOX_EVENT_COALESCE_MS * 3)
        expect(onBatch).toHaveBeenCalledTimes(2)
        unmount()
    })

    it('ignores signals for another mailbox and malformed frames', async () => {
        const stream = makeStream()
        connectWith(stream)
        const onBatch = vi.fn()
        const { unmount } = renderHook(() => useMailboxEvents('box-1', onBatch))
        await flush()

        stream.push(frame('message.new', 'f-x', 'box-OTHER'))
        stream.push('event: message.new\ndata: {not json\n\n')
        stream.push(frame('something.else', 'f-x'))
        await flush()
        await advance(MAILBOX_EVENT_COALESCE_MS * 2)
        expect(onBatch).not.toHaveBeenCalled()
        unmount()
    })

    it('shares ONE connection between components of the same mailbox, and opens one per mailbox', async () => {
        const first = makeStream()
        const second = makeStream()
        connectWith(first)
        const a = vi.fn()
        const b = vi.fn()

        const view = render(
            <>
                <Probe id="box-1" onBatch={a} />
                <Probe id="box-1" onBatch={b} />
                <Probe id="box-1" />
            </>,
        )
        await flush()
        expect(apiRequestMock).toHaveBeenCalledTimes(1)
        expect(__mailboxStreamCount()).toBe(1)

        // Both listeners get the same signal off the single stream.
        first.push(frame('message.new', 'f-inbox'))
        await flush()
        expect(a).toHaveBeenCalledTimes(1)
        expect(b).toHaveBeenCalledTimes(1)

        // A different mailbox is a different stream.
        connectWith(second)
        view.rerender(
            <>
                <Probe id="box-1" onBatch={a} />
                <Probe id="box-2" />
            </>,
        )
        await flush()
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        expect(apiRequestMock.mock.calls[1][0]).toBe('/api/mail/mailboxes/box-2/events')
        view.unmount()
    })

    it('keeps the stream through a quick remount and aborts it once nobody listens', async () => {
        const stream = makeStream()
        connectWith(stream)
        const first = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        const signal: AbortSignal = apiRequestMock.mock.calls[0][1].signal

        first.unmount()
        await advance(MAILBOX_STREAM_CLOSE_GRACE_MS - 500)
        const second = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        expect(apiRequestMock).toHaveBeenCalledTimes(1)
        expect(signal.aborted).toBe(false)

        second.unmount()
        await advance(MAILBOX_STREAM_CLOSE_GRACE_MS + 1)
        expect(signal.aborted).toBe(true)
        expect(__mailboxStreamCount()).toBe(0)
    })

    it('goes offline when the stream ends, reconnects with backoff and asks consumers to resync', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const first = makeStream()
        const second = makeStream()
        connectWith(first)
        connectWith(second)
        const onBatch = vi.fn()
        const { result, unmount } = renderHook(() => useMailboxEvents('box-1', onBatch))
        await flush()
        expect(result.current.status).toBe('live')

        first.close()
        await flush()
        expect(result.current.status).toBe('offline')
        expect(apiRequestMock).toHaveBeenCalledTimes(1)

        await advance(1_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        expect(result.current.status).toBe('live')
        expect(onBatch).toHaveBeenCalledTimes(1)
        expect(onBatch.mock.calls[0][0]).toMatchObject({ resync: true, counts: true })
        unmount()
    })

    it('backs off exponentially while the server is unreachable', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor 1.0: delays are exactly 1 s, 2 s, 4 s
        apiRequestMock.mockRejectedValue(new Error('network down'))
        const { result, unmount } = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        expect(result.current.status).toBe('offline')
        expect(apiRequestMock).toHaveBeenCalledTimes(1)

        await advance(1_000) // retry 1 after 1 s
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        await advance(1_900) // retry 2 needs 2 s more: not yet
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        await advance(200)
        expect(apiRequestMock).toHaveBeenCalledTimes(3)
        await advance(3_800) // retry 3 needs 4 s
        expect(apiRequestMock).toHaveBeenCalledTimes(3)
        await advance(200)
        expect(apiRequestMock).toHaveBeenCalledTimes(4)
        unmount()
    })

    it('stops retrying when the mailbox is gone (404) and stays offline', async () => {
        const { ApiClientError } = await import('../lib/api-client')
        apiRequestMock.mockRejectedValue(new ApiClientError('Mailbox not found', { status: 404, path: 'x' }))
        const { result, unmount } = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        await advance(60_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(1)
        expect(result.current.status).toBe('offline')
        unmount()
    })

    it('treats a long silence (no heartbeat) as a dead socket and reconnects', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const first = makeStream()
        const second = makeStream()
        connectWith(first)
        connectWith(second)
        const { result, unmount } = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        expect(result.current.status).toBe('live')

        await advance(MAILBOX_STREAM_STALL_MS + 100)
        await flush()
        expect(result.current.status).toBe('offline')
        await advance(1_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        expect(result.current.status).toBe('live')
        unmount()
    })

    it('keeps backing off when streams die right after opening, and resyncs at most once per window', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5) // delays are exactly 1 s, 2 s, 4 s
        const streams = [makeStream(), makeStream(), makeStream(), makeStream()]
        streams.forEach(connectWith)
        const onBatch = vi.fn()
        const { unmount } = renderHook(() => useMailboxEvents('box-1', onBatch))
        await flush()
        expect(apiRequestMock).toHaveBeenCalledTimes(1)

        // Each stream opens (200) and dies at once. Before the fix `attempt` reset on the 200, so
        // every retry came after ~1 s forever.
        streams[0].close()
        await flush()
        await advance(1_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        streams[1].close()
        await flush()
        await advance(1_900) // second retry needs 2 s
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        await advance(200)
        expect(apiRequestMock).toHaveBeenCalledTimes(3)
        streams[2].close()
        await flush()
        await advance(3_900) // third needs 4 s
        expect(apiRequestMock).toHaveBeenCalledTimes(3)
        await advance(200)
        expect(apiRequestMock).toHaveBeenCalledTimes(4)

        // Three reconnects inside one window produced exactly ONE resync batch.
        const resyncs = onBatch.mock.calls.filter(([batch]) => batch.resync)
        expect(resyncs).toHaveLength(1)
        unmount()
    })

    it('resets the backoff once a stream lived long enough, and allows a resync again after the window', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const streams = [makeStream(), makeStream(), makeStream()]
        streams.forEach(connectWith)
        const onBatch = vi.fn()
        const { unmount } = renderHook(() => useMailboxEvents('box-1', onBatch))
        await flush()

        streams[0].close() // dies at once: next delay 1 s, then 2 s
        await flush()
        await advance(1_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(2)

        // This one stays up past the stable threshold (and past the resync window).
        await advance(Math.max(MAILBOX_STREAM_STABLE_MS, MAILBOX_RESYNC_MIN_GAP_MS) + 1_000)
        streams[1].close()
        await flush()
        await advance(1_000) // reset: back to the 1 s base, not 2 s
        expect(apiRequestMock).toHaveBeenCalledTimes(3)
        expect(onBatch.mock.calls.filter(([batch]) => batch.resync)).toHaveLength(2)
        unmount()
    })

    it('treats the first heartbeat as proof of health', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const streams = [makeStream(), makeStream(), makeStream()]
        streams.forEach(connectWith)
        const { unmount } = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        streams[0].close()
        await flush()
        await advance(1_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(2)

        streams[1].push(frameComment('ping'))
        await flush()
        streams[1].close()
        await flush()
        await advance(1_000) // reset by the ping: 1 s, not 2 s
        expect(apiRequestMock).toHaveBeenCalledTimes(3)
        unmount()
    })

    it('backs off at least a minute after an HTTP 429', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5)
        const { ApiClientError } = await import('../lib/api-client')
        apiRequestMock.mockRejectedValueOnce(new ApiClientError('Too many requests', { status: 429, path: 'x' }))
        connectWith(makeStream())
        const { result, unmount } = renderHook(() => useMailboxEvents('box-1', vi.fn()))
        await flush()
        expect(result.current.status).toBe('offline')

        await advance(MAILBOX_RATE_LIMIT_BACKOFF_MS - 1_000)
        expect(apiRequestMock).toHaveBeenCalledTimes(1)
        await advance(1_500)
        expect(apiRequestMock).toHaveBeenCalledTimes(2)
        unmount()
    })

    it('is an idle no-op without a mailbox', async () => {
        const { result } = renderHook(() => useMailboxEvents(undefined))
        await flush()
        expect(result.current.status).toBe('offline')
        expect(apiRequestMock).not.toHaveBeenCalled()
    })
})
