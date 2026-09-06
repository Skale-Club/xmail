/**
 * Guards the 2026-09-02 crash: an ImapFlow `'error'` event with no listener is re-thrown by
 * Node as an uncaught exception, and install-alerting.ts exits the process on those. Every
 * client must be built through createImapClient, which attaches the listener before connect.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('imapflow', async () => {
    const { EventEmitter } = await import('node:events')
    class FakeImapFlow extends EventEmitter {
        constructor(options: Record<string, unknown>) {
            super()
            constructed.push(options)
        }
    }
    return { ImapFlow: FakeImapFlow }
})

import {
    attachImapErrorGuard,
    createImapClient,
    IMAP_CONNECTION_TIMEOUT_MS,
    IMAP_GREETING_TIMEOUT_MS,
    IMAP_SOCKET_TIMEOUT_MS,
} from '../imap-client'

const target = { host: 'imap.example.com', port: null, secure: null, auth: { user: 'u', pass: 'p' } }

describe('createImapClient', () => {
    it('survives a socket timeout emitted as an error event instead of crashing the process', () => {
        const client = createImapClient(target, { purpose: 'test', emailAccountId: 'acc-1' })
        const err = Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })
        // With no listener this throws synchronously ("Unhandled error") — the crash itself.
        expect(() => (client as unknown as EventEmitter).emit('error', err)).not.toThrow()
        expect((client as unknown as EventEmitter).listenerCount('error')).toBe(1)
    })

    it('pins bounded timeouts and the documented defaults for port/TLS', () => {
        constructed.length = 0
        createImapClient(target, { purpose: 'test' })
        expect(constructed[0]).toMatchObject({
            host: 'imap.example.com',
            port: 993,
            secure: true,
            logger: false,
            socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
            connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
            greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
        })
        expect(IMAP_SOCKET_TIMEOUT_MS).toBeLessThan(5 * 60 * 1000) // imapflow's default, too slow for a cron budget
    })

    it('respects an explicit port and secure=false', () => {
        constructed.length = 0
        createImapClient({ ...target, port: 143, secure: false }, { purpose: 'test' })
        expect(constructed[0]).toMatchObject({ port: 143, secure: false })
    })

    it('attachImapErrorGuard logs rather than throws on a bare emitter', () => {
        const emitter = new EventEmitter()
        attachImapErrorGuard(emitter as never, { purpose: 'bare' })
        expect(() => emitter.emit('error', new Error('boom'))).not.toThrow()
    })
})

describe('no ImapFlow is constructed outside createImapClient', () => {
    it('grep guard', async () => {
        const { readdirSync, readFileSync, statSync } = await import('node:fs')
        const { join } = await import('node:path')
        const offenders: string[] = []
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
                const full = join(dir, entry)
                if (statSync(full).isDirectory()) {
                    if (entry !== '__tests__') walk(full)
                } else if (full.endsWith('.ts') && !full.endsWith('imap-client.ts')) {
                    if (readFileSync(full, 'utf8').includes('new ImapFlow(')) offenders.push(full)
                }
            }
        }
        walk(join(process.cwd(), 'src', 'server'))
        expect(offenders).toEqual([])
    })
})
