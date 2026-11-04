import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { formatMailboxSseEvent, mailboxEventSubscriberCount, publishMailboxEvent, subscribeToMailboxEvents, type MailboxEvent } from '../mailbox-events'
import { ownedStreamCount, OWNED_STREAM_AUTH_TIMEOUT_MS, OWNED_STREAM_MAX_PER_USER, OWNED_STREAM_MAX_QUEUE, OWNED_STREAM_REVIEW_MS, serveOwnedStream } from './owned-stream'

const userId = '10000000-0000-4000-8000-000000000001', mailboxId = '20000000-0000-4000-8000-000000000002'
class FakeResponse extends EventEmitter {
    headersSent = false; destroyed = false; writableEnded = false; statusCode = 200; canWrite = true
    written: string[] = []; body: unknown; headers = new Map<string, string>()
    status(code: number) { this.statusCode = code; return this }
    json(body: unknown) { this.body = body; this.end(); return this }
    setHeader(key: string, value: string) { this.headers.set(key, value); return this }
    flushHeaders() { this.headersSent = true }
    write(frame: string) { this.headersSent = true; this.written.push(frame); return this.canWrite }
    end() {
        if (!this.writableEnded) { this.writableEnded = true; this.emit('close') }
        return this
    }
}
const responses: FakeResponse[] = []
function fixture(owner = userId) {
    const req = Object.assign(new EventEmitter(), { socket: { destroyed: false }, aborted: false })
    const res = new FakeResponse(); responses.push(res)
    const authorize = vi.fn(async () => ({ expiresAt: Date.now() + 60_000 }))
    const subscribe = vi.fn((listener: (event: MailboxEvent) => void) => subscribeToMailboxEvents(mailboxId, listener, owner))
    const start = () => serveOwnedStream(req as unknown as Request, res as unknown as Response, {
        userId: owner, authorize, subscribe, frame: formatMailboxSseEvent,
        headers: { 'Content-Type': 'text/event-stream' }, connected: ': connected\n\n', heartbeat: ': ping\n\n', heartbeatMs: 25000,
    })
    return { req, res, authorize, subscribe, start }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T12:00:00Z')) })
afterEach(async () => {
    for (const response of responses.splice(0)) response.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(ownedStreamCount()).toBe(0); expect(mailboxEventSubscriberCount()).toBe(0)
    vi.useRealTimers()
})
async function settle() { await vi.advanceTimersByTimeAsync(0) }
describe('owned SSE lifecycle with mocked sockets and the actual redacted event bus', () => {
    it('writes only redacted mailbox metadata after fresh batch admission', async () => {
        const stream = fixture(); await stream.start()
        expect(stream.res.written).toEqual([': connected\n\n'])
        publishMailboxEvent({ mailboxId, kind: 'message.new', folderId: null, body: 'private-body-fixture', email: 'private-contact-fixture' } as never)
        await settle()
        expect(stream.authorize).toHaveBeenCalledTimes(2)
        expect(stream.res.written[1]).toContain('"kind":"message.new"')
        expect(stream.res.written.join('')).not.toContain('private-')
        expect(ownedStreamCount(userId)).toBe(1)
    })
    it('never delivers queued signals before an in-flight provider/local permission check completes', async () => {
        const stream = fixture(); await stream.start()
        let finish!: (value: { expiresAt: number }) => void
        stream.authorize.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        publishMailboxEvent({ mailboxId, kind: 'message.new' }); publishMailboxEvent({ mailboxId, kind: 'folder.counts' })
        expect(stream.res.written).toHaveLength(1)
        finish({ expiresAt: Date.now() + 60000 }); await settle()
        expect(stream.res.written).toHaveLength(3)
    })
    it('closes without delivering after local ownership/session revocation', async () => {
        const stream = fixture(); await stream.start()
        stream.authorize.mockResolvedValueOnce(null as never)
        publishMailboxEvent({ mailboxId, kind: 'message.new' }); await settle()
        expect(stream.res.writableEnded).toBe(true); expect(stream.res.written).toHaveLength(1)
        expect(ownedStreamCount()).toBe(0)
    })
    it('detects idle revocation on the bounded periodic check and releases the bus listener', async () => {
        const stream = fixture(); await stream.start()
        stream.authorize.mockResolvedValueOnce(null as never)
        await vi.advanceTimersByTimeAsync(OWNED_STREAM_REVIEW_MS + 1)
        expect(stream.res.writableEnded).toBe(true); expect(mailboxEventSubscriberCount()).toBe(0)
    })
    it('closes on provider/SQL failure without placing raw diagnostics on the wire', async () => {
        const stream = fixture(); await stream.start()
        stream.authorize.mockRejectedValueOnce(new Error('Authorization: private-provider-fixture'))
        publishMailboxEvent({ mailboxId, kind: 'message.new' }); await settle()
        expect(stream.res.writableEnded).toBe(true); expect(JSON.stringify(stream.res.body) + stream.res.written.join('')).not.toContain('private-provider')
    })
    it('ends at the original hard expiry even if a validation returns a later lease', async () => {
        const stream = fixture()
        stream.authorize.mockResolvedValueOnce({ expiresAt: Date.now() + 1000 })
        await stream.start()
        let finish!: (value: { expiresAt: number }) => void
        stream.authorize.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        publishMailboxEvent({ mailboxId, kind: 'message.new' })
        await vi.advanceTimersByTimeAsync(1001)
        expect(stream.res.writableEnded).toBe(true)
        finish({ expiresAt: Date.now() + 60000 }); await settle()
        expect(stream.res.written).toHaveLength(1)
    })
    it('bounds noncooperative authorization and never subscribes after its deadline', async () => {
        const stream = fixture()
        let finish!: (value: { expiresAt: number }) => void
        stream.authorize.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        const opening = stream.start()
        await vi.advanceTimersByTimeAsync(OWNED_STREAM_AUTH_TIMEOUT_MS + 1)
        await opening
        expect(stream.res.statusCode).toBe(503); expect(stream.subscribe).not.toHaveBeenCalled()
        finish({ expiresAt: Date.now() + 60000 }); await settle()
        expect(ownedStreamCount()).toBe(0)
    })
    it('releases pending capacity immediately on disconnect and ignores the late successful result', async () => {
        const stream = fixture()
        let finish!: (value: { expiresAt: number }) => void
        stream.authorize.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        const opening = stream.start(); expect(ownedStreamCount()).toBe(1)
        stream.req.emit('close'); await opening
        expect(ownedStreamCount()).toBe(0)
        finish({ expiresAt: Date.now() + 60000 }); await settle()
        expect(stream.subscribe).not.toHaveBeenCalled(); expect(stream.res.written).toHaveLength(0)
    })
    it('preserves per-user capacity and permits a clean reconnect after all old streams end', async () => {
        for (let index = 0; index < OWNED_STREAM_MAX_PER_USER; index++) await fixture().start()
        const extra = fixture(); await extra.start()
        expect(extra.res.statusCode).toBe(429); expect(extra.authorize).not.toHaveBeenCalled()
        for (const response of responses) response.end()
        expect(ownedStreamCount()).toBe(0)
        const reconnect = fixture(); await reconnect.start()
        expect(reconnect.res.statusCode).toBe(200); expect(ownedStreamCount()).toBe(1)
    })
    it('closes on write backpressure without retaining a subscriber or unchecked frame queue', async () => {
        const stream = fixture(); stream.res.canWrite = false
        await stream.start()
        expect(stream.res.writableEnded).toBe(true); expect(ownedStreamCount()).toBe(0)
    })
    it('closes a bounded queue overflow instead of accumulating reconnect work', async () => {
        const stream = fixture(); await stream.start()
        let finish!: (value: { expiresAt: number }) => void
        stream.authorize.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        for (let index = 0; index <= OWNED_STREAM_MAX_QUEUE; index++) publishMailboxEvent({ mailboxId, kind: 'message.updated' })
        expect(stream.res.writableEnded).toBe(true); expect(stream.res.written).toHaveLength(1)
        finish({ expiresAt: Date.now() + 60000 }); await settle()
        expect(mailboxEventSubscriberCount()).toBe(0)
    })
    it('does not let reconnects accumulate noncooperative provider/SQL operations after timeout', async () => {
        const finishers: ((value: { expiresAt: number }) => void)[] = []
        const opening: Promise<void>[] = []
        for (let index = 0; index < 8; index++) {
            const stream = fixture(`10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
            stream.authorize.mockReturnValueOnce(new Promise(resolve => { finishers.push(resolve) }))
            opening.push(stream.start())
        }
        await vi.advanceTimersByTimeAsync(OWNED_STREAM_AUTH_TIMEOUT_MS + 1)
        await Promise.all(opening)
        expect(ownedStreamCount()).toBe(0)
        const blocked = fixture(); await blocked.start()
        expect(blocked.res.statusCode).toBe(503); expect(blocked.authorize).not.toHaveBeenCalled()
        for (const finish of finishers) finish({ expiresAt: Date.now() + 60000 })
        await settle()
        const recovered = fixture(); await recovered.start()
        expect(recovered.res.statusCode).toBe(200); expect(recovered.subscribe).toHaveBeenCalledOnce()
    })
})
