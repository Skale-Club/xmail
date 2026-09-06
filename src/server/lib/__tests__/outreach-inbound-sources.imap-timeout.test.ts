import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * IMAP timeout hardening for `createImapInboundSource` (outreach-replies-processor hangs,
 * 2026-09): the reader normally completes a full account pass in well under a second once
 * connected, but 7-8 times a day it rode the un-bounded ImapFlow client all the way to the
 * job's own 600s timeout — a hung socket, not slow work. This suite locks in the fix:
 *
 *   - every ImapFlow operation is bounded (connect/greeting/socket options, all confirmed
 *     supported on the pinned imapflow version via node_modules/imapflow/lib/imap-flow.d.ts
 *     and cross-checked against imap-flow.js for the error `.code` each one raises),
 *   - an overall per-account deadline wraps the whole fetchPage as a backstop for a hang
 *     that isn't purely socket-level (the "Command failed" signature),
 *   - the client is ALWAYS closed — success, thrown error, or deadline,
 *   - the thrown error always names the account (id + email) and the phase, so an incident
 *     points at the culprit instead of requiring log archaeology.
 *
 * Same seam as outlook-inbound.test.ts / outreach-provider.test.ts: without mocking `../../../db`
 * the real client is built at import time and throws on a missing/real DATABASE_URL. `../crypto`
 * is mocked too, so the suite does not depend on OUTLOOK_TOKEN_ENCRYPTION_KEY being set in this
 * environment — decryptSecret's real behaviour has its own coverage in crypto.test.ts. `imapflow`
 * is mocked so these are pure unit tests — no real socket, no real network.
 */

vi.mock('../../../db', () => ({ db: {}, queryClient: vi.fn() }))
vi.mock('../crypto', () => ({ decryptSecret: (value: string) => value }))

// Hoisted so the `imapflow` mock factory (itself hoisted above these imports) can close over
// it. `nextBehavior` configures the ONE ImapFlow client instance the next `fetchPage()` call
// constructs; `instances` lets a test inspect the mocks (close/logout call counts, etc.).
const imapFlowState = vi.hoisted(() => {
    interface MockClientBehavior {
        connect?: () => Promise<void>
        mailbox?: { uidValidity: number | bigint }
        search?: (...args: unknown[]) => Promise<unknown>
        fetchOne?: (...args: unknown[]) => Promise<unknown>
        logout?: () => Promise<void>
    }

    let nextBehavior: MockClientBehavior = {}
    const instances: ReturnType<typeof buildInstance>[] = []

    function buildInstance(options: unknown, behavior: MockClientBehavior) {
        return {
            options,
            mailbox: behavior.mailbox ?? { uidValidity: 100 },
            // ImapFlow is an EventEmitter and createImapClient attaches its 'error' guard
            // before connect(), so a mock without `on` is not a stand-in for the real class.
            // What the guard does is covered by imap-client.test.ts; here it only has to exist.
            on: vi.fn(),
            connect: vi.fn(behavior.connect ?? (async () => undefined)),
            getMailboxLock: vi.fn(async (_path: string) => ({ path: 'INBOX', release: vi.fn() })),
            search: vi.fn(behavior.search ?? (async () => [] as number[])),
            fetchOne: vi.fn(behavior.fetchOne ?? (async () => false as const)),
            logout: vi.fn(behavior.logout ?? (async () => undefined)),
            close: vi.fn(),
        }
    }

    function ImapFlowMock(this: unknown, options: unknown) {
        const instance = buildInstance(options, nextBehavior)
        instances.push(instance)
        return instance
    }

    return {
        ImapFlowMock,
        instances,
        setNextBehavior: (behavior: MockClientBehavior) => {
            nextBehavior = behavior
        },
        reset: () => {
            nextBehavior = {}
            instances.length = 0
        },
    }
})

vi.mock('imapflow', () => ({ ImapFlow: imapFlowState.ImapFlowMock }))

import {
    ImapInboundTimeoutError,
    createImapInboundSource,
    type ImapInboundAccount,
} from '../outreach-inbound-sources'

const ACCOUNT: ImapInboundAccount = {
    id: '00000000-0000-4000-8000-0000000000aa',
    email: 'v.souza@tryskaleclub.com',
    imapHost: 'imap.example.test',
    imapPort: 993,
    imapUsername: 'v.souza@tryskaleclub.com',
    imapPassword: 'stored-encrypted-imap-password',
    imapSecure: true,
}

function lastClient() {
    const client = imapFlowState.instances.at(-1)
    if (!client) throw new Error('no ImapFlow instance was constructed')
    return client
}

function rawMime(subject: string) {
    return [
        'From: lead@prospect.test',
        'To: v.souza@tryskaleclub.com',
        `Subject: ${subject}`,
        'Message-ID: <1@prospect.test>',
        '',
        'Hello there',
        '',
    ].join('\r\n')
}

beforeEach(() => {
    imapFlowState.reset()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('createImapInboundSource timeouts', () => {
    it('a normal fast fetch resolves messages and closes the client cleanly', async () => {
        imapFlowState.setNextBehavior({
            search: async () => [42],
            fetchOne: async () => ({ source: Buffer.from(rawMime('Hi')) }),
        })

        const page = await createImapInboundSource(ACCOUNT).fetchPage(null, 10)

        expect(page.messages).toHaveLength(1)
        expect(page.messages[0]?.subject).toBe('Hi')
        expect(page.nextCursor.lastUid).toBe(42)

        const client = lastClient()
        expect(client.connect).toHaveBeenCalledTimes(1)
        expect(client.logout).toHaveBeenCalledTimes(1)
        expect(client.close).not.toHaveBeenCalled()
    })

    it('bounds every ImapFlow operation with the timeout options this imapflow version supports', async () => {
        imapFlowState.setNextBehavior({ search: async () => [] })

        await createImapInboundSource(ACCOUNT).fetchPage(null, 10)

        const client = lastClient()
        const options = client.options as Record<string, unknown>
        expect(options.connectionTimeout).toBeTypeOf('number')
        expect(options.greetingTimeout).toBeTypeOf('number')
        expect(options.socketTimeout).toBeTypeOf('number')
        // Generous vs. a normal (well-under-a-second) fetch, but far below the job's own
        // 600s budget — see the arithmetic comment above IMAP_ACCOUNT_DEADLINE_MS.
        expect(options.connectionTimeout as number).toBeLessThan(60_000)
        expect(options.greetingTimeout as number).toBeLessThan(60_000)
        expect(options.socketTimeout as number).toBeLessThan(60_000)
    })

    it('a connect that never resolves is aborted by the overall deadline, and the client is closed', async () => {
        vi.useFakeTimers()

        imapFlowState.setNextBehavior({ connect: () => new Promise(() => {}) })

        const pending = createImapInboundSource(ACCOUNT).fetchPage(null, 10)
        const assertion = expect(pending).rejects.toMatchObject({
            name: 'ImapInboundTimeoutError',
            phase: 'overall_deadline',
            emailAccountId: ACCOUNT.id,
            email: ACCOUNT.email,
        })

        await vi.advanceTimersByTimeAsync(30_000)
        await assertion

        expect(lastClient().close).toHaveBeenCalled()
    })

    it('names the account and phase when ImapFlow itself times out connecting', async () => {
        const connectTimeout = Object.assign(
            new Error('Failed to establish connection in required time'),
            { code: 'CONNECT_TIMEOUT' },
        )
        imapFlowState.setNextBehavior({ connect: async () => { throw connectTimeout } })

        const error = await createImapInboundSource(ACCOUNT).fetchPage(null, 10).catch((e) => e)

        expect(error).toBeInstanceOf(ImapInboundTimeoutError)
        expect(error).toMatchObject({
            phase: 'connect',
            emailAccountId: ACCOUNT.id,
            email: ACCOUNT.email,
        })
        expect(error.message).toContain(ACCOUNT.email)
        expect(error.message).toContain(ACCOUNT.id)
    })

    it('names the account and phase when ImapFlow times out waiting for the greeting', async () => {
        const greetingTimeout = Object.assign(
            new Error('Failed to receive greeting from server in required time'),
            { code: 'GREETING_TIMEOUT' },
        )
        imapFlowState.setNextBehavior({ connect: async () => { throw greetingTimeout } })

        const error = await createImapInboundSource(ACCOUNT).fetchPage(null, 10).catch((e) => e)

        expect(error).toBeInstanceOf(ImapInboundTimeoutError)
        expect(error).toMatchObject({ phase: 'greeting', emailAccountId: ACCOUNT.id })
    })

    it('names the account and phase when a command times out after a healthy connect', async () => {
        // This is the "Command failed" signature from production: the server accepts the
        // connection but stops responding mid-command, so the socket goes idle.
        const socketTimeout = Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })
        imapFlowState.setNextBehavior({ search: async () => { throw socketTimeout } })

        const error = await createImapInboundSource(ACCOUNT).fetchPage(null, 10).catch((e) => e)

        expect(error).toBeInstanceOf(ImapInboundTimeoutError)
        expect(error).toMatchObject({ phase: 'command', emailAccountId: ACCOUNT.id })

        // Even though connect() itself succeeded, the client must still be torn down.
        expect(lastClient().logout).toHaveBeenCalledTimes(1)
    })

    it('closes the client even when connect() throws outright (no timeout involved)', async () => {
        imapFlowState.setNextBehavior({ connect: async () => { throw new Error('ECONNREFUSED') } })

        await expect(createImapInboundSource(ACCOUNT).fetchPage(null, 10)).rejects.toThrow('ECONNREFUSED')

        const client = lastClient()
        // logout() is attempted regardless; the mock resolves it, proving the finally path
        // that guarantees closure runs on this branch too (a real ImapFlow client would
        // reject logout() here and fall back to close(), both exercised by the deadline test).
        expect(client.logout).toHaveBeenCalledTimes(1)
    })
})
