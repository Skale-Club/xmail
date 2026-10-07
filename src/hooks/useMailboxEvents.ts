// ============================================================
// Webmail — live change signals for the selected mailbox (SSE push)
// ============================================================
// The webmail twin of useUnifiedInboxEvents. The server publishes a tiny, content-free signal
// (mailbox id, folder id, kind, timestamp) whenever something in a mailbox changes; the browser
// reacts by re-reading through the normal authorized API. Polling stays underneath as the safety
// net (see useInfiniteMessages): it slows down while this stream is live and runs at its normal
// pace whenever the stream is not.
//
// Bearer auth is required, so we CANNOT use `EventSource` (it can't send an Authorization header).
// We connect with authenticated `fetch`, read `Response.body` through a `ReadableStream`, and tear
// the connection down with `AbortController`.
//
// ONE connection per mailbox per tab: connections live in a module-level registry keyed by mailbox
// id, so any number of components calling the hook share a single stream. The connection is closed
// a few seconds after the last subscriber leaves (the grace period bridges route changes, where
// the page layout can unmount and remount) and reopened on demand.

import React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiClientError, apiRequest } from '../lib/api-client'
import { useMailbox } from './useMailbox'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** Events inside one window are merged into a single batch; the first one is delivered at once. */
export const MAILBOX_EVENT_COALESCE_MS = 1_000
/** The server pings every 25 s; silence for much longer than that means a dead (half-open) socket. */
export const MAILBOX_STREAM_STALL_MS = 70_000
/** How long a connection outlives its last subscriber (route changes remount the layout). */
export const MAILBOX_STREAM_CLOSE_GRACE_MS = 3_000
/** Minimum gap between mailbox-list refreshes triggered by non-arrival signals. */
const MAILBOX_LIST_REFRESH_MIN_GAP_MS = 5_000

export type MailboxRealtimeStatus = 'live' | 'connecting' | 'offline'

/** What changed since the last batch, merged over the coalescing window. `null` = folder unknown. */
export interface MailboxChangeBatch {
    /** Folders that received mail. */
    newFolders: ReadonlySet<string | null>
    /** Folders where existing mail changed (read, starred, moved, expunged). */
    updatedFolders: ReadonlySet<string | null>
    /** True when folder counters changed. */
    counts: boolean
    /** True right after a reconnect: signals may have been missed, so treat everything as changed. */
    resync: boolean
}

export type MailboxBatchListener = (batch: MailboxChangeBatch) => void

/** The closed, content-free signal shape the server publishes (mirror of src/server/lib/mailbox-events.ts). */
interface MailboxEventWire {
    mailboxId?: string
    folderId?: string | null
    kind?: string
    at?: string
}

interface Pending {
    newFolders: Set<string | null>
    updatedFolders: Set<string | null>
    counts: boolean
    resync: boolean
}

function emptyPending(): Pending {
    return { newFolders: new Set(), updatedFolders: new Set(), counts: false, resync: false }
}

interface Entry {
    mailboxId: string
    refs: number
    status: MailboxRealtimeStatus
    statusListeners: Set<() => void>
    batchListeners: Set<MailboxBatchListener>
    controller: AbortController | null
    reconnectTimer: ReturnType<typeof setTimeout> | null
    closeTimer: ReturnType<typeof setTimeout> | null
    windowTimer: ReturnType<typeof setTimeout> | null
    stallTimer: ReturnType<typeof setTimeout> | null
    stalled: boolean
    attempt: number
    everLive: boolean
    disposed: boolean
    pending: Pending
}

const registry = new Map<string, Entry>()

/** Test hook: how many streams are currently open or opening. */
export function __mailboxStreamCount(): number {
    return registry.size
}

function setStatus(entry: Entry, status: MailboxRealtimeStatus): void {
    if (entry.status === status) return
    entry.status = status
    for (const listener of [...entry.statusListeners]) listener()
}

function hasPending(p: Pending): boolean {
    return p.newFolders.size > 0 || p.updatedFolders.size > 0 || p.counts || p.resync
}

function flush(entry: Entry): void {
    if (!hasPending(entry.pending)) return
    const batch: MailboxChangeBatch = entry.pending
    entry.pending = emptyPending()
    for (const listener of [...entry.batchListeners]) {
        try {
            listener(batch)
        } catch {
            // One bad consumer must not starve the others.
        }
    }
}

function openWindow(entry: Entry): void {
    entry.windowTimer = setTimeout(() => {
        entry.windowTimer = null
        if (entry.disposed) return
        if (hasPending(entry.pending)) {
            flush(entry)
            openWindow(entry)
        }
    }, MAILBOX_EVENT_COALESCE_MS)
}

/** Leading + trailing coalescing: the first signal goes out at once, a burst becomes one trailing batch. */
function enqueue(entry: Entry, apply: (p: Pending) => void): void {
    apply(entry.pending)
    if (entry.windowTimer) return
    flush(entry)
    openWindow(entry)
}

function handleEvent(entry: Entry, event: MailboxEventWire): void {
    if (event.mailboxId !== entry.mailboxId) return
    const folderId = typeof event.folderId === 'string' ? event.folderId : null
    switch (event.kind) {
        case 'message.new':
            enqueue(entry, (p) => { p.newFolders.add(folderId); p.counts = true })
            break
        case 'message.updated':
            enqueue(entry, (p) => { p.updatedFolders.add(folderId); p.counts = true })
            break
        case 'folder.counts':
            enqueue(entry, (p) => { p.counts = true })
            break
        default:
            break // unknown kind from a newer server: ignore
    }
}

function parseFrame(entry: Entry, raw: string): void {
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue // comment / heartbeat
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) return
    try {
        handleEvent(entry, JSON.parse(dataLines.join('\n')) as MailboxEventWire)
    } catch {
        // Ignore a malformed frame; the next one recovers.
    }
}

function clearStall(entry: Entry): void {
    if (entry.stallTimer) {
        clearTimeout(entry.stallTimer)
        entry.stallTimer = null
    }
}

function armStall(entry: Entry, controller: AbortController): void {
    clearStall(entry)
    entry.stallTimer = setTimeout(() => {
        entry.stalled = true
        controller.abort()
    }, MAILBOX_STREAM_STALL_MS)
}

function scheduleReconnect(entry: Entry): void {
    if (entry.disposed) return
    setStatus(entry, 'offline')
    // Capped exponential backoff with jitter, so a deploy restart doesn't bring every tab back at once.
    const base = Math.min(RECONNECT_BASE_MS * 2 ** entry.attempt, RECONNECT_MAX_MS)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    entry.attempt += 1
    entry.reconnectTimer = setTimeout(() => {
        entry.reconnectTimer = null
        void connect(entry)
    }, delay)
}

async function connect(entry: Entry): Promise<void> {
    if (entry.disposed) return
    const controller = new AbortController()
    entry.controller = controller
    entry.stalled = false
    try {
        // retry:false — this module owns reconnection (backoff above); api-client's own
        // retry-on-network-error would just race a second attempt against it.
        const res = await apiRequest(
            `/api/mail/mailboxes/${encodeURIComponent(entry.mailboxId)}/events`,
            { signal: controller.signal, headers: { Accept: 'text/event-stream' }, retry: false },
        )
        if (!res.body) throw new Error('sse_no_body')

        const reconnected = entry.everLive
        entry.everLive = true
        entry.attempt = 0
        setStatus(entry, 'live')
        // Signals may have been missed while the stream was down: tell consumers to re-read.
        if (reconnected) enqueue(entry, (p) => { p.resync = true; p.counts = true })

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        armStall(entry, controller)
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            armStall(entry, controller)
            buffer += decoder.decode(value, { stream: true })
            let boundary = buffer.indexOf('\n\n')
            while (boundary !== -1) {
                parseFrame(entry, buffer.slice(0, boundary))
                buffer = buffer.slice(boundary + 2)
                boundary = buffer.indexOf('\n\n')
            }
        }
        clearStall(entry)
        // Server closed the stream (e.g. deploy rollover): reconnect unless we're tearing down.
        if (!entry.disposed) scheduleReconnect(entry)
    } catch (error) {
        clearStall(entry)
        if (entry.disposed) return // intentional teardown, not a failure
        if (controller.signal.aborted && !entry.stalled) return
        if (error instanceof ApiClientError && (error.status === 404 || error.status === 403)) {
            // The mailbox is gone or no longer ours: retrying cannot help. Polling still works.
            setStatus(entry, 'offline')
            return
        }
        scheduleReconnect(entry)
    }
}

function dispose(entry: Entry): void {
    entry.disposed = true
    entry.controller?.abort()
    clearStall(entry)
    for (const timer of [entry.reconnectTimer, entry.closeTimer, entry.windowTimer]) {
        if (timer) clearTimeout(timer)
    }
    entry.reconnectTimer = entry.closeTimer = entry.windowTimer = null
    entry.statusListeners.clear()
    entry.batchListeners.clear()
    if (registry.get(entry.mailboxId) === entry) registry.delete(entry.mailboxId)
}

function acquire(
    mailboxId: string,
    listeners: { onBatch?: MailboxBatchListener; onStatus: () => void },
): { entry: Entry; release: () => void } {
    let entry = registry.get(mailboxId)
    if (!entry) {
        entry = {
            mailboxId,
            refs: 0,
            status: 'connecting',
            statusListeners: new Set(),
            batchListeners: new Set(),
            controller: null,
            reconnectTimer: null,
            closeTimer: null,
            windowTimer: null,
            stallTimer: null,
            stalled: false,
            attempt: 0,
            everLive: false,
            disposed: false,
            pending: emptyPending(),
        }
        registry.set(mailboxId, entry)
        void connect(entry)
    }
    const live = entry
    if (live.closeTimer) {
        clearTimeout(live.closeTimer)
        live.closeTimer = null
    }
    live.refs += 1
    live.statusListeners.add(listeners.onStatus)
    if (listeners.onBatch) live.batchListeners.add(listeners.onBatch)

    let released = false
    return {
        entry: live,
        release: () => {
            if (released) return
            released = true
            live.statusListeners.delete(listeners.onStatus)
            if (listeners.onBatch) live.batchListeners.delete(listeners.onBatch)
            live.refs -= 1
            if (live.refs <= 0 && !live.closeTimer) {
                live.closeTimer = setTimeout(() => {
                    live.closeTimer = null
                    if (live.refs <= 0) dispose(live)
                }, MAILBOX_STREAM_CLOSE_GRACE_MS)
            }
        },
    }
}

/**
 * Subscribes to the live change signals of `mailboxId` and reports the stream status. Every
 * caller for the same mailbox shares ONE connection. `onBatch` (optional) receives coalesced
 * batches; it may change identity freely — the latest function is always the one called. Safe to
 * mount without a mailbox (idle). The status is 'connecting' until the first attempt resolves,
 * 'live' while connected, 'offline' while reconnecting.
 */
export function useMailboxEvents(
    mailboxId: string | undefined,
    onBatch?: MailboxBatchListener,
): { status: MailboxRealtimeStatus } {
    const [status, setStatusState] = React.useState<MailboxRealtimeStatus>(mailboxId ? 'connecting' : 'offline')
    const callbackRef = React.useRef(onBatch)
    callbackRef.current = onBatch
    const wantsBatches = onBatch !== undefined

    React.useEffect(() => {
        if (!mailboxId) {
            setStatusState('offline')
            return
        }
        const handle = acquire(mailboxId, {
            onBatch: wantsBatches ? (batch) => callbackRef.current?.(batch) : undefined,
            onStatus: () => setStatusState(handle.entry.status),
        })
        setStatusState(handle.entry.status)
        return handle.release
    }, [mailboxId, wantsBatches])

    return { status }
}

/**
 * Mounted ONCE by the webmail layout: keeps the sidebar badges, the folder counters and the
 * mailbox switcher's unread numbers in step with what the server reports, so a new message bumps
 * the Inbox badge and the mailbox badge together without a general refetch of the open list
 * (useInfiniteMessages owns that part).
 */
export function useMailboxLiveSync(): { status: MailboxRealtimeStatus } {
    const queryClient = useQueryClient()
    const { selectedMailbox, refreshMailboxes } = useMailbox()
    const mailboxId = selectedMailbox?.id
    const lastListRefreshRef = React.useRef(0)

    const onBatch = React.useCallback((batch: MailboxChangeBatch) => {
        if (!mailboxId) return
        // Folder counters (the sidebar's observer refetches the active query).
        void queryClient.invalidateQueries({ queryKey: ['folders', mailboxId] })
        // The switcher's per-mailbox unread: always on arrival, otherwise at most every few seconds.
        const arrival = batch.newFolders.size > 0 || batch.resync
        const now = Date.now()
        if (arrival || now - lastListRefreshRef.current >= MAILBOX_LIST_REFRESH_MIN_GAP_MS) {
            lastListRefreshRef.current = now
            void refreshMailboxes()
        }
    }, [mailboxId, queryClient, refreshMailboxes])

    return useMailboxEvents(mailboxId, onBatch)
}
