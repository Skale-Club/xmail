// ============================================================
// Unified Inbox — organization-scoped aggregate event bus (Phase 22 UIX-06)
// ============================================================
// This is the near-real-time channel's server core. It publishes only SMALL,
// organization-scoped signals (conversation id/version, event kind, unread aggregate,
// sync health) so the browser can invalidate list/unread/detail caches. It NEVER carries
// message bodies, subjects, or addresses — those are fetched by the authorized read API.
//
// These tests pin the contract the SSE endpoint and the client hook rely on:
//   - cross-tenant isolation (org A never sees org B's activity),
//   - redaction to ids/counts (no content can leak through the bus or the SSE frame),
//   - deterministic cleanup (unsubscribe releases the slot; no leaked listeners),
//   - listener-error isolation (one bad subscriber can't break the publisher),
//   - a bounded subscriber cap (a runaway client can't exhaust memory),
//   - and the SSE wire framing (event/data lines + heartbeat comment).

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    INBOX_EVENT_MAX_SUBSCRIBERS_PER_ORG,
    INBOX_SSE_HEADERS,
    InboxEventCapacityError,
    formatInboxSseComment,
    formatInboxSseEvent,
    inboxEventSubscriberCount,
    publishInboxEvent,
    subscribeToInboxEvents,
    type InboxEvent,
} from './inbox-events'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const CONV_1 = '33333333-3333-4333-8333-333333333333'

// Track every subscription so a test can never leak a listener into the shared module singleton.
const cleanups: Array<() => void> = []
function track(unsub: () => void): () => void {
    cleanups.push(unsub)
    return unsub
}

afterEach(() => {
    while (cleanups.length) cleanups.pop()!()
    // The module singleton must be empty between tests — proves cleanup actually releases slots.
    expect(inboxEventSubscriberCount()).toBe(0)
})

function baseEvent(overrides: Partial<InboxEvent> = {}): InboxEvent {
    return {
        organizationId: ORG_A,
        kind: 'conversation.updated',
        conversationId: CONV_1,
        at: '2026-07-16T10:00:00.000Z',
        ...overrides,
    }
}

describe('inbox-events bus: delivery + tenant isolation', () => {
    it('delivers a published event to a subscriber of the same organization', () => {
        const received: InboxEvent[] = []
        track(subscribeToInboxEvents(ORG_A, (e) => received.push(e)))

        publishInboxEvent(baseEvent({ kind: 'conversation.updated' }))

        expect(received).toHaveLength(1)
        expect(received[0].kind).toBe('conversation.updated')
        expect(received[0].conversationId).toBe(CONV_1)
    })

    it('never delivers another organization’s event to a subscriber (cross-tenant denial)', () => {
        const orgAReceived: InboxEvent[] = []
        const orgBReceived: InboxEvent[] = []
        track(subscribeToInboxEvents(ORG_A, (e) => orgAReceived.push(e)))
        track(subscribeToInboxEvents(ORG_B, (e) => orgBReceived.push(e)))

        publishInboxEvent(baseEvent({ organizationId: ORG_B, conversationId: CONV_1 }))

        // The stream must not leak another org's activity — org A hears nothing.
        expect(orgAReceived).toHaveLength(0)
        expect(orgBReceived).toHaveLength(1)
    })

    it('carries the unread aggregate + version but never message content', () => {
        const received: InboxEvent[] = []
        track(subscribeToInboxEvents(ORG_A, (e) => received.push(e)))

        // A caller carelessly passes content-bearing fields; the bus must strip them.
        publishInboxEvent({
            organizationId: ORG_A,
            kind: 'unread.changed',
            conversationId: CONV_1,
            version: 42,
            unreadCount: 7,
            syncDegraded: false,
            at: '2026-07-16T10:00:00.000Z',
            // Not part of the contract — must never survive redaction.
            plainBody: 'the secret body',
            subject: 'secret subject',
            fromAddress: 'lead@acme.example',
        } as unknown as InboxEvent)

        expect(received).toHaveLength(1)
        const event = received[0]
        expect(event.unreadCount).toBe(7)
        expect(event.version).toBe(42)
        // Only the whitelisted keys survive — no body/subject/address can ride the bus.
        expect(Object.keys(event).sort()).toEqual(
            ['at', 'conversationId', 'kind', 'organizationId', 'syncDegraded', 'unreadCount', 'version'].sort(),
        )
        const asRecord = event as unknown as Record<string, unknown>
        expect(asRecord.plainBody).toBeUndefined()
        expect(asRecord.subject).toBeUndefined()
        expect(asRecord.fromAddress).toBeUndefined()
    })
})

describe('inbox-events bus: cleanup + resilience', () => {
    it('stops delivering after unsubscribe and releases the subscriber slot', () => {
        const received: InboxEvent[] = []
        const unsub = subscribeToInboxEvents(ORG_A, (e) => received.push(e))
        expect(inboxEventSubscriberCount(ORG_A)).toBe(1)

        unsub()
        expect(inboxEventSubscriberCount(ORG_A)).toBe(0)

        publishInboxEvent(baseEvent())
        expect(received).toHaveLength(0)

        // Idempotent: a double unsubscribe must not corrupt the counter.
        unsub()
        expect(inboxEventSubscriberCount(ORG_A)).toBe(0)
    })

    it('isolates a throwing listener so co-subscribers still receive the event', () => {
        const good: InboxEvent[] = []
        track(subscribeToInboxEvents(ORG_A, () => { throw new Error('bad subscriber') }))
        track(subscribeToInboxEvents(ORG_A, (e) => good.push(e)))

        expect(() => publishInboxEvent(baseEvent())).not.toThrow()
        expect(good).toHaveLength(1)
    })

    it('enforces a bounded per-organization subscriber cap', () => {
        for (let i = 0; i < INBOX_EVENT_MAX_SUBSCRIBERS_PER_ORG; i++) {
            track(subscribeToInboxEvents(ORG_A, () => {}))
        }
        expect(inboxEventSubscriberCount(ORG_A)).toBe(INBOX_EVENT_MAX_SUBSCRIBERS_PER_ORG)
        expect(() => subscribeToInboxEvents(ORG_A, () => {})).toThrow(InboxEventCapacityError)
    })

    it('is a no-op publish when the organization has no subscribers', () => {
        const listener = vi.fn()
        track(subscribeToInboxEvents(ORG_A, listener))
        publishInboxEvent(baseEvent({ organizationId: ORG_B }))
        expect(listener).not.toHaveBeenCalled()
    })
})

describe('inbox-events SSE framing', () => {
    it('formats an event as event/data lines carrying only safe fields', () => {
        const frame = formatInboxSseEvent({
            organizationId: ORG_A,
            kind: 'conversation.updated',
            conversationId: CONV_1,
            unreadCount: 3,
            at: '2026-07-16T10:00:00.000Z',
            // Content that must never reach the wire.
            plainBody: 'super secret',
        } as unknown as InboxEvent)

        expect(frame).toMatch(/^event: conversation\.updated\n/)
        expect(frame).toContain('data: ')
        expect(frame.endsWith('\n\n')).toBe(true)
        // The wire frame carries ids/counts only — never the body.
        expect(frame).not.toContain('super secret')
        expect(frame).not.toContain('plainBody')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))!
        const payload = JSON.parse(dataLine.slice('data: '.length))
        expect(payload.organizationId).toBe(ORG_A)
        expect(payload.unreadCount).toBe(3)
        expect(payload).not.toHaveProperty('plainBody')
    })

    it('formats a heartbeat as an SSE comment line', () => {
        expect(formatInboxSseComment('ping')).toBe(': ping\n\n')
    })

    it('exposes SSE headers that disable caching and proxy buffering', () => {
        expect(INBOX_SSE_HEADERS['Content-Type']).toContain('text/event-stream')
        expect(INBOX_SSE_HEADERS['Cache-Control']).toContain('no-cache')
        // Prevent nginx/proxy buffering that would defeat the stream (bounded polling is the fallback).
        expect(INBOX_SSE_HEADERS['X-Accel-Buffering']).toBe('no')
    })
})
