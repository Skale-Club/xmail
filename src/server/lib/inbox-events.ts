// ============================================================
// Unified Inbox — organization-scoped aggregate event bus (Phase 22 UIX-06)
// ============================================================
// The near-real-time channel's server core. It is a small, in-process publish/subscribe bus
// whose ONLY payload is organization-scoped SIGNALS: a conversation id/version, an event kind,
// the unread aggregate, and sync-health. It NEVER carries message bodies, subjects, or
// addresses — the browser reacts to a signal by invalidating a TanStack Query key and letting
// the authorized read API return the actual data. This keeps tenant content off the fanout
// channel entirely (a subscriber for org A can only ever observe org A's aggregate signals).
//
// Fanout scope: a single Node process (production runs one `xmail` container — see CLAUDE.md).
// The materializer/command jobs run in-process alongside the HTTP server, so an in-memory bus
// reaches every open SSE connection. Multi-process fanout is intentionally NOT implemented;
// the client's bounded list/unread polling fallback (see useUnifiedInboxEvents) remains the
// authoritative safety net if a signal is ever missed (proxy buffering, a future scale-out).
//
// No module-level import may pull in the database or any provider adapter: this file must load
// cheaply in the pure-node `server` test project (no DATABASE_URL, no container).

export type InboxEventKind =
    | 'conversation.created'
    | 'conversation.updated'
    | 'unread.changed'
    | 'sync.health'

/**
 * The complete, closed shape of a fanout event. Every field is an id, a count, a flag, or a
 * timestamp — deliberately incapable of carrying message content. `redactInboxEvent` rebuilds
 * an event from exactly these keys, so an accidental extra field on a caller's object (a body,
 * a subject, an address) can never survive onto the bus or the SSE wire.
 */
export interface InboxEvent {
    organizationId: string
    kind: InboxEventKind
    /** The conversation the signal is about (null for a pure org-wide aggregate change). */
    conversationId?: string | null
    /** Monotonic version for the conversation (e.g. updated-at epoch ms); lets the client drop stale events. */
    version?: number | null
    /** The organization/user unread aggregate at publish time, when known. */
    unreadCount?: number | null
    /** Coarse sync-health flag (no provider error text ever). */
    syncDegraded?: boolean | null
    /** ISO publish timestamp. */
    at: string
}

/** Bound a single organization's concurrent subscribers so a runaway client can't exhaust memory. */
export const INBOX_EVENT_MAX_SUBSCRIBERS_PER_ORG = 100
/** Bound the total concurrent subscribers across all organizations. */
export const INBOX_EVENT_MAX_SUBSCRIBERS_TOTAL = 2000

/** Heartbeat cadence — keeps idle connections alive through proxy idle timeouts and detects half-open sockets. */
export const INBOX_SSE_HEARTBEAT_MS = 25_000

/**
 * SSE response headers. `no-transform` + `X-Accel-Buffering: no` stop intermediaries from
 * buffering the stream (which would defeat near-real-time); when a proxy buffers anyway, the
 * client's bounded polling fallback still keeps the inbox fresh.
 */
export const INBOX_SSE_HEADERS: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
}

export class InboxEventCapacityError extends Error {
    constructor() {
        super('inbox_event_subscriber_capacity')
        this.name = 'InboxEventCapacityError'
    }
}

export type InboxEventListener = (event: InboxEvent) => void

// Structural org-scoping: subscribers are keyed by organization id, so a publish for org B is
// only ever iterated against org B's listener set. There is no shared channel to leak across.
const subscribers = new Map<string, Set<InboxEventListener>>()
let totalSubscribers = 0

/**
 * Rebuild an event from ONLY the whitelisted keys. This is the single redaction chokepoint:
 * anything a caller adds beyond the contract is dropped here before it can reach a subscriber
 * or the SSE wire.
 */
export function redactInboxEvent(input: InboxEvent): InboxEvent {
    return {
        organizationId: input.organizationId,
        kind: input.kind,
        conversationId: input.conversationId ?? null,
        version: typeof input.version === 'number' ? input.version : null,
        unreadCount: typeof input.unreadCount === 'number' ? input.unreadCount : null,
        syncDegraded: typeof input.syncDegraded === 'boolean' ? input.syncDegraded : null,
        at: input.at,
    }
}

/**
 * Subscribe a listener to one organization's aggregate signals. Returns an idempotent
 * unsubscribe that releases the slot; call it on SSE client disconnect so no listener leaks.
 * Throws {@link InboxEventCapacityError} when a per-org or global bound is already reached.
 */
export function subscribeToInboxEvents(organizationId: string, listener: InboxEventListener): () => void {
    const set = subscribers.get(organizationId) ?? new Set<InboxEventListener>()
    if (totalSubscribers >= INBOX_EVENT_MAX_SUBSCRIBERS_TOTAL || set.size >= INBOX_EVENT_MAX_SUBSCRIBERS_PER_ORG) {
        throw new InboxEventCapacityError()
    }
    set.add(listener)
    subscribers.set(organizationId, set)
    totalSubscribers++

    let active = true
    return () => {
        if (!active) return
        active = false
        const current = subscribers.get(organizationId)
        if (current && current.delete(listener)) {
            totalSubscribers--
            if (current.size === 0) subscribers.delete(organizationId)
        }
    }
}

/**
 * Publish a redacted signal to every subscriber of the event's organization. A throwing
 * listener is isolated so it can never break the publisher or its co-subscribers. Callers
 * publish AFTER a database commit (materialized message, applied mutation) so a subscriber
 * that invalidates its cache always reads committed state back.
 */
export function publishInboxEvent(input: InboxEvent): void {
    const safe = redactInboxEvent(input)
    const set = subscribers.get(safe.organizationId)
    if (!set || set.size === 0) return
    // Snapshot so a listener that unsubscribes itself during dispatch can't mutate the live set.
    for (const listener of [...set]) {
        try {
            listener(safe)
        } catch {
            // Deliberately swallowed — one bad subscriber must not affect the others or the publisher.
        }
    }
}

/** Current subscriber count (total, or for one organization). Used by the SSE endpoint + tests. */
export function inboxEventSubscriberCount(organizationId?: string): number {
    if (organizationId === undefined) return totalSubscribers
    return subscribers.get(organizationId)?.size ?? 0
}

/** Serialize an event to an SSE `event:`/`data:` frame. Re-redacts, so the wire can never carry content. */
export function formatInboxSseEvent(event: InboxEvent): string {
    const safe = redactInboxEvent(event)
    return `event: ${safe.kind}\ndata: ${JSON.stringify(safe)}\n\n`
}

/** Serialize a heartbeat/keepalive as an SSE comment line (ignored by EventSource-style parsers). */
export function formatInboxSseComment(text: string): string {
    return `: ${text}\n\n`
}
