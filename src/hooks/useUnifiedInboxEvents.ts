// ============================================================
// Unified Inbox — near-real-time client channel (Phase 22 UIX-06)
// ============================================================
// ONE organization-scoped stream keeps the operator's unread badge, conversation list, and
// open thread converged without polling every thread (locked decision #9).
//
// Bearer auth is required, so we CANNOT use `EventSource` (it can't send an Authorization
// header). We connect with authenticated `fetch`, consume `Response.body` through a
// `ReadableStream` reader, and tear the connection down with `AbortController`. The stream
// carries only SIGNALS (ids/counts/kind) — never message bodies — so reacting to one means
// invalidating a TanStack Query key and letting the authorized read API return the real data.
//
// Degradation is safe and visible: on disconnect we reconnect with capped exponential backoff
// AND run a bounded list/unread polling fallback (never per-thread) so the inbox stays fresh
// and readable even when the stream is unavailable (proxy buffering, transient network). The
// UI surfaces the degraded state via `status`/`isStale` (see InboxSyncStatus).

import React from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { fetchWithAuth } from '../lib/api'
import { inboxKeys, isInboxListQueryKey } from '../lib/unified-inbox-api'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** Bounded fallback cadence while disconnected — invalidates ONLY the aggregates, never per-thread. */
const POLL_FALLBACK_MS = 30_000

export type InboxRealtimeStatus = 'idle' | 'connecting' | 'live' | 'reconnecting'

export interface InboxRealtimeState {
    status: InboxRealtimeStatus
    /** True once a live connection has been lost — the UI shows "Updates delayed" + periodic refresh. */
    isStale: boolean
    /** When the last live signal was applied (for a "Last updated" marker). */
    lastEventAt: Date | null
}

/** The closed, content-free signal shape the server publishes (mirror of src/server/lib/inbox-events.ts). */
interface InboxAggregateEvent {
    organizationId?: string
    kind?: string
    conversationId?: string | null
    version?: number | null
    unreadCount?: number | null
    syncDegraded?: boolean | null
    at?: string
}

const EVENTS_PATH = '/api/outreach/unified-inbox/events'

function isDetailKey(queryKey: readonly unknown[], organizationId: string | undefined): boolean {
    return queryKey[0] === 'outreach-inbox' && queryKey[1] === organizationId && queryKey[2] === 'detail'
}

function invalidateAggregates(queryClient: QueryClient, organizationId: string): void {
    // Unread badge + the conversation list only. The list re-filters membership/ordering on the
    // server; this is the bounded work the polling fallback repeats — it NEVER enumerates threads.
    void queryClient.invalidateQueries({ queryKey: inboxKeys.unread(organizationId) })
    void queryClient.invalidateQueries({ predicate: (q) => isInboxListQueryKey(q.queryKey, organizationId) })
}

/**
 * Opens and maintains the single authenticated SSE stream for `organizationId`. Returns the
 * realtime status so a host component can surface degraded sync. Safe to mount without an
 * organization (idle no-op). Tears everything down on org switch / unmount / logout.
 */
export function useUnifiedInboxEvents(organizationId: string | undefined): InboxRealtimeState {
    const queryClient = useQueryClient()
    const [status, setStatus] = React.useState<InboxRealtimeStatus>('idle')
    const [lastEventAt, setLastEventAt] = React.useState<Date | null>(null)

    React.useEffect(() => {
        if (!organizationId) {
            setStatus('idle')
            return
        }

        let disposed = false
        let controller: AbortController | null = null
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null
        let pollTimer: ReturnType<typeof setInterval> | null = null
        let attempt = 0
        // Per-conversation version high-watermark: an out-of-order or duplicate signal for a
        // conversation we've already seen at a newer version is dropped, so stale events can't
        // churn the cache. (Invalidation reads server truth, so this is a de-dupe, not a merge.)
        const versions = new Map<string, number>()

        const startPolling = () => {
            if (pollTimer) return
            pollTimer = setInterval(() => {
                if (disposed) return
                invalidateAggregates(queryClient, organizationId)
            }, POLL_FALLBACK_MS)
        }
        const stopPolling = () => {
            if (pollTimer) {
                clearInterval(pollTimer)
                pollTimer = null
            }
        }

        const handleEvent = (event: InboxAggregateEvent) => {
            if (event.conversationId && typeof event.version === 'number') {
                const prev = versions.get(event.conversationId)
                if (prev !== undefined && event.version <= prev) return
                versions.set(event.conversationId, event.version)
            }
            setLastEventAt(new Date())
            invalidateAggregates(queryClient, organizationId)
            if (event.kind === 'conversation.updated' || event.kind === 'conversation.created') {
                // Invalidate the detail NAMESPACE, not a specific id: only the currently-open
                // thread has an active observer, so only IT refetches. This is why we never need
                // to poll every thread — the open one converges, the rest stay untouched.
                void queryClient.invalidateQueries({ predicate: (q) => isDetailKey(q.queryKey, organizationId) })
            }
        }

        const parseFrame = (raw: string) => {
            const dataLines: string[] = []
            for (const line of raw.split('\n')) {
                if (line.startsWith(':')) continue // comment / heartbeat
                if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
            }
            if (dataLines.length === 0) return
            try {
                handleEvent(JSON.parse(dataLines.join('\n')) as InboxAggregateEvent)
            } catch {
                // Ignore a malformed frame; the next one recovers.
            }
        }

        const scheduleReconnect = () => {
            if (disposed) return
            setStatus('reconnecting')
            startPolling() // bounded fallback stays live while the stream is down
            const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
            attempt += 1
            reconnectTimer = setTimeout(() => { void connect() }, delay)
        }

        const connect = async () => {
            if (disposed) return
            controller = new AbortController()
            setStatus((prev) => (prev === 'live' ? prev : 'connecting'))
            try {
                const res = await fetchWithAuth(
                    `${EVENTS_PATH}?organizationId=${encodeURIComponent(organizationId)}`,
                    { signal: controller.signal, headers: { Accept: 'text/event-stream' } },
                )
                if (!res.ok || !res.body) throw new Error(`sse_status_${res.status}`)

                setStatus('live')
                attempt = 0
                stopPolling() // healthy: rely on push, not the fallback timer

                const reader = res.body.getReader()
                const decoder = new TextDecoder()
                let buffer = ''
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value, { stream: true })
                    let boundary = buffer.indexOf('\n\n')
                    while (boundary !== -1) {
                        parseFrame(buffer.slice(0, boundary))
                        buffer = buffer.slice(boundary + 2)
                        boundary = buffer.indexOf('\n\n')
                    }
                }
                // Server closed the stream (e.g. deploy rollover): reconnect unless we're tearing down.
                if (!disposed && !controller.signal.aborted) scheduleReconnect()
            } catch {
                if (disposed || controller?.signal.aborted) return // intentional teardown, not a failure
                scheduleReconnect()
            }
        }

        void connect()

        return () => {
            disposed = true
            controller?.abort()
            if (reconnectTimer) clearTimeout(reconnectTimer)
            stopPolling()
        }
    }, [organizationId, queryClient])

    return {
        status,
        isStale: status === 'reconnecting',
        lastEventAt,
    }
}

// ------------------------------------------------------------
// Single-stream provider + reader
// ------------------------------------------------------------
// The stream is opened ONCE at the outreach shell (OutreachLayout) so exactly one connection
// serves the whole session (locked #9). Descendant workspace regions read the status through
// this context to render the degraded-sync marker — they never open a second stream.

const DEFAULT_REALTIME_STATE: InboxRealtimeState = { status: 'idle', isStale: false, lastEventAt: null }

const InboxRealtimeContext = React.createContext<InboxRealtimeState>(DEFAULT_REALTIME_STATE)

export function InboxRealtimeProvider(
    { organizationId, children }: { organizationId: string | undefined; children: React.ReactNode },
): React.ReactElement {
    const state = useUnifiedInboxEvents(organizationId)
    return React.createElement(InboxRealtimeContext.Provider, { value: state }, children)
}

/** Read the shared realtime status. Returns a safe idle default when no provider is mounted. */
export function useInboxRealtimeStatus(): InboxRealtimeState {
    return React.useContext(InboxRealtimeContext)
}
