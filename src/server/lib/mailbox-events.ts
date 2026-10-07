// ============================================================
// Webmail — mailbox-scoped change signals (push over SSE)
// ============================================================
// A small in-process publish/subscribe bus, the webmail twin of inbox-events.ts. The ONLY payload
// is a signal: which mailbox, which folder (when known), what kind of change, and when. It never
// carries a subject, sender, address or body — the browser reacts to a signal by re-reading the
// folder through the normal authorized API, so mail content never rides the fanout channel and a
// subscriber for mailbox A can only ever observe mailbox A's signals (listeners are keyed by id).
//
// Fanout scope: a single Node process (production runs one `xmail` container — see CLAUDE.md), so
// an in-memory bus reaches every open SSE connection. The webmail keeps its polling as the safety
// net for a missed signal (proxy buffering, a future scale-out).
//
// Publishers call this AFTER the database write has committed — never inside a transaction — so a
// client that re-reads on a signal always sees committed state. `publishMailboxEvent` never throws.
//
// No module-level import may pull in the database: this file loads cheaply in the pure-node
// `server` test project and from mail-events.ts (which sits under every mail write path).

export type MailboxEventKind = 'message.new' | 'message.updated' | 'folder.counts'

/** The complete, closed shape of a signal: ids, a kind and a timestamp. */
export interface MailboxEvent {
    mailboxId: string
    /** The folder the change happened in (null when it is mailbox-wide or unknown). */
    folderId: string | null
    kind: MailboxEventKind
    /** ISO publish timestamp. */
    at: string
}

export type MailboxEventInput = Omit<MailboxEvent, 'folderId' | 'at'> & {
    folderId?: string | null
    at?: string
}

/** Concurrent SSE connections one user may hold (a few tabs + a reconnect overlapping the old one). */
export const MAILBOX_EVENT_MAX_SUBSCRIBERS_PER_USER = 6
/** Concurrent SSE connections across every user. */
export const MAILBOX_EVENT_MAX_SUBSCRIBERS_TOTAL = 2000

export class MailboxEventCapacityError extends Error {
    readonly scope: 'user' | 'global'
    constructor(scope: 'user' | 'global') {
        super(`mailbox_event_subscriber_capacity_${scope}`)
        this.name = 'MailboxEventCapacityError'
        this.scope = scope
    }
}

export type MailboxEventListener = (event: MailboxEvent) => void

// Structural scoping: listeners are keyed by mailbox id, so a publish for mailbox B is only ever
// iterated against mailbox B's listener set. There is no shared channel to leak across.
const subscribers = new Map<string, Set<MailboxEventListener>>()
const perUser = new Map<string, number>()
let totalSubscribers = 0

/**
 * Rebuild an event from exactly the whitelisted keys. This is the single redaction chokepoint:
 * anything a caller adds beyond the contract (a subject, a sender) is dropped here before it can
 * reach a subscriber or the SSE wire.
 */
export function redactMailboxEvent(input: MailboxEventInput): MailboxEvent {
    return {
        mailboxId: input.mailboxId,
        folderId: input.folderId ?? null,
        kind: input.kind,
        at: input.at ?? new Date().toISOString(),
    }
}

/**
 * Subscribe a listener to one mailbox's signals. `userId` (the authenticated requester) enforces
 * the per-user connection cap. Returns an idempotent unsubscribe — call it on SSE client
 * disconnect so no listener leaks. Throws {@link MailboxEventCapacityError} when a bound is hit.
 */
export function subscribeToMailboxEvents(
    mailboxId: string,
    listener: MailboxEventListener,
    userId?: string,
): () => void {
    if (totalSubscribers >= MAILBOX_EVENT_MAX_SUBSCRIBERS_TOTAL) {
        throw new MailboxEventCapacityError('global')
    }
    if (userId && (perUser.get(userId) ?? 0) >= MAILBOX_EVENT_MAX_SUBSCRIBERS_PER_USER) {
        throw new MailboxEventCapacityError('user')
    }

    const set = subscribers.get(mailboxId) ?? new Set<MailboxEventListener>()
    set.add(listener)
    subscribers.set(mailboxId, set)
    totalSubscribers++
    if (userId) perUser.set(userId, (perUser.get(userId) ?? 0) + 1)

    let active = true
    return () => {
        if (!active) return
        active = false
        const current = subscribers.get(mailboxId)
        if (current && current.delete(listener)) {
            totalSubscribers--
            if (current.size === 0) subscribers.delete(mailboxId)
        }
        if (userId) {
            const remaining = (perUser.get(userId) ?? 1) - 1
            if (remaining <= 0) perUser.delete(userId)
            else perUser.set(userId, remaining)
        }
    }
}

/**
 * Publish a redacted signal to every subscriber of the event's mailbox. A throwing listener is
 * isolated, and a bus error of any kind is swallowed: a publish is a best-effort side effect of a
 * mail write and must never be able to break mail flow.
 */
export function publishMailboxEvent(input: MailboxEventInput): void {
    try {
        const set = subscribers.get(input.mailboxId)
        if (!set || set.size === 0) return
        const safe = redactMailboxEvent(input)
        // Snapshot so a listener that unsubscribes itself during dispatch can't mutate the live set.
        for (const listener of [...set]) {
            try {
                listener(safe)
            } catch {
                // One bad subscriber must not affect the others or the publisher.
            }
        }
    } catch {
        // Never break mail flow over a signal.
    }
}

/** Current subscriber count (total, or for one mailbox). Used by the SSE endpoint + tests. */
export function mailboxEventSubscriberCount(mailboxId?: string): number {
    if (mailboxId === undefined) return totalSubscribers
    return subscribers.get(mailboxId)?.size ?? 0
}

/** Serialize an event to an SSE `event:`/`data:` frame. Re-redacts, so the wire can never carry content. */
export function formatMailboxSseEvent(event: MailboxEventInput): string {
    const safe = redactMailboxEvent(event)
    return `event: ${safe.kind}\ndata: ${JSON.stringify(safe)}\n\n`
}

/** Serialize a heartbeat/keepalive as an SSE comment line. */
export function formatMailboxSseComment(text: string): string {
    return `: ${text}\n\n`
}
