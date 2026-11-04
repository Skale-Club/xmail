import { expect, it, vi } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serveOwnedStream, ownedStreamCount } from './owned-stream'
import { formatMailboxSseEvent, mailboxEventSubscriberCount, publishMailboxEvent, subscribeToMailboxEvents } from '../mailbox-events'

it('keeps a completed HTTP GET open for later events, then releases the real subscription on revocation', async () => {
    const userId = '10000000-0000-4000-8000-000000000001', mailboxId = '20000000-0000-4000-8000-000000000002'
    let allowed = true
    const authorize = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        return allowed ? { expiresAt: Date.now() + 10000 } : null
    })
    const app = express()
    app.get('/events', (req, res) => serveOwnedStream(req, res, {
        userId, authorize, subscribe: listener => subscribeToMailboxEvents(mailboxId, listener, userId),
        frame: formatMailboxSseEvent, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
        connected: ': connected\n\n', heartbeat: ': ping\n\n', heartbeatMs: 25000,
    }))
    const server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const controller = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    async function bounded<T>(operation: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP stream test deadline')), 1500) })]) }
        finally { clearTimeout(timer) }
    }
    try {
        const response = await bounded(fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`, { signal: controller.signal }))
        expect(response.status).toBe(200)
        reader = response.body!.getReader()
        let wire = ''
        const until = async (text: string) => {
            while (!wire.includes(text)) {
                const chunk = await bounded(reader!.read())
                if (chunk.done) throw new Error('HTTP stream ended before its authorized frame')
                wire += new TextDecoder().decode(chunk.value)
            }
        }
        await until(': connected')
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(ownedStreamCount(userId)).toBe(1); expect(mailboxEventSubscriberCount(mailboxId)).toBe(1)
        publishMailboxEvent({ mailboxId, kind: 'message.new', body: 'private-body-fixture' } as never)
        await until('"kind":"message.new"')
        expect(wire).not.toContain('private-body')
        allowed = false
        publishMailboxEvent({ mailboxId, kind: 'folder.counts' })
        expect((await bounded(reader.read())).done).toBe(true)
        expect(authorize).toHaveBeenCalledTimes(3)
        expect(ownedStreamCount()).toBe(0); expect(mailboxEventSubscriberCount()).toBe(0)
    } finally {
        controller.abort(); await reader?.cancel().catch(() => {})
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
})
