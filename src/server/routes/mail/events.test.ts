import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests, no DB: GET /:mailboxId/events authorizes through checkUserMailboxAccess (owner or
 * admin) before it opens the stream, caps connections per user, and only ever forwards signals
 * for the authorized mailbox.
 */

const accessMock = vi.hoisted(() => vi.fn())

vi.mock('./mailboxes', () => ({ checkUserMailboxAccess: accessMock }))

const BOX_A = '11111111-1111-4111-8111-111111111111'
const BOX_B = '22222222-2222-4222-8222-222222222222'

let server: http.Server
let baseUrl: string

beforeEach(async () => {
    accessMock.mockReset()
    const router = (await import('./events')).default
    const app = express()
    app.use('/', router)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 20_000)

afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

async function readUntil(res: Response, needle: string): Promise<string> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes(needle)) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
    }
    reader.releaseLock()
    return text
}

describe('GET /:mailboxId/events', () => {
    it('rejects a request without a user', async () => {
        const res = await fetch(`${baseUrl}/${BOX_A}/events`)
        expect(res.status).toBe(401)
        expect(accessMock).not.toHaveBeenCalled()
    })

    it('returns 404 for a mailbox the user cannot access, without opening a stream', async () => {
        accessMock.mockResolvedValue(null)
        const res = await fetch(`${baseUrl}/${BOX_B}/events`, { headers: { 'x-user-id': 'user-a' } })
        expect(res.status).toBe(404)
        expect(res.headers.get('content-type')).toMatch(/application\/json/)
        expect(accessMock).toHaveBeenCalledWith('user-a', BOX_B)
        const { mailboxEventSubscriberCount } = await import('../../lib/mailbox-events')
        expect(mailboxEventSubscriberCount(BOX_B)).toBe(0)
    })

    it('streams SSE for the authorized mailbox and forwards only its signals', async () => {
        accessMock.mockResolvedValue({ id: BOX_A })
        const controller = new AbortController()
        const res = await fetch(`${baseUrl}/${BOX_A}/events`, {
            headers: { 'x-user-id': 'user-a' },
            signal: controller.signal,
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
        expect(res.headers.get('cache-control')).toMatch(/no-transform/)

        const { publishMailboxEvent, mailboxEventSubscriberCount } = await import('../../lib/mailbox-events')
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let text = ''
        const pump = async (needle: string) => {
            while (!text.includes(needle)) {
                const { done, value } = await reader.read()
                if (done) break
                text += decoder.decode(value, { stream: true })
            }
        }
        await pump(': connected')
        expect(mailboxEventSubscriberCount(BOX_A)).toBe(1)

        publishMailboxEvent({ mailboxId: BOX_B, folderId: 'f-b', kind: 'message.new' })
        publishMailboxEvent({ mailboxId: BOX_A, folderId: 'f-a', kind: 'message.new' })
        await pump('event: message.new')
        expect(text).toContain('"mailboxId":"' + BOX_A + '"')
        expect(text).toContain('"folderId":"f-a"')
        expect(text).not.toContain(BOX_B)

        controller.abort()
        await vi.waitFor(() => expect(mailboxEventSubscriberCount(BOX_A)).toBe(0))
    })

    it('answers 429 once the user holds the maximum number of streams', async () => {
        accessMock.mockResolvedValue({ id: BOX_A })
        const { MAILBOX_EVENT_MAX_SUBSCRIBERS_PER_USER } = await import('../../lib/mailbox-events')
        const controllers: AbortController[] = []
        for (let i = 0; i < MAILBOX_EVENT_MAX_SUBSCRIBERS_PER_USER; i++) {
            const controller = new AbortController()
            controllers.push(controller)
            const res = await fetch(`${baseUrl}/${BOX_A}/events`, { headers: { 'x-user-id': 'user-cap' }, signal: controller.signal })
            expect(res.status).toBe(200)
            await readUntil(res, ': connected')
        }
        const over = await fetch(`${baseUrl}/${BOX_A}/events`, { headers: { 'x-user-id': 'user-cap' } })
        expect(over.status).toBe(429)
        controllers.forEach((c) => c.abort())
    })
})
