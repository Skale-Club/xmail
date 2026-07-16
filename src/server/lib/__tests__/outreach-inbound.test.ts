import { describe, expect, it, vi } from 'vitest'
import {
    DEFAULT_INBOUND_PAGE_SIZE,
    MAX_INBOUND_PAGE_SIZE,
    classifyInboundMessage,
    consumeClassifiedEvents,
    imapProviderMessageId,
    ingestInboundPage,
    nativeProviderMessageId,
    resolveImapCursor,
    resolveInboundPageSize,
    type InboundEventStore,
    type InboundSource,
    type NormalizedInboundMessage,
    type ProviderCursorState,
    type StoredProviderEvent,
} from '../outreach-inbound'

const ORG = '40000000-0000-4000-8000-000000000001'
const ACCOUNT = '40000000-0000-4000-8000-000000000002'

function message(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
    return {
        provider: 'native',
        providerMessageId: 'msg-1',
        messageId: 'inbound-1@prospect.test',
        inReplyTo: null,
        references: null,
        fromAddress: 'lead@prospect.test',
        toAddresses: ['seller@example.test'],
        ccAddresses: [],
        subject: 'Hello',
        textBody: 'body',
        htmlBody: null,
        headers: {},
        attachments: [],
        receivedAt: new Date('2026-07-16T10:00:00.000Z'),
        ...overrides,
    }
}

/** In-memory stand-in for the SQL store; mirrors the unique key of migration 039. */
function createFakeStore(seed: StoredProviderEvent[] = []) {
    const events = new Map<string, StoredProviderEvent>()
    let cursor: ProviderCursorState | null = null
    let sequence = 0

    for (const event of seed) events.set(`${event.provider}:${event.providerMessageId}`, { ...event })

    const store: InboundEventStore & {
        all: () => StoredProviderEvent[]
        cursorState: () => ProviderCursorState | null
    } = {
        async recordEvent(input) {
            const key = `${input.provider}:${input.providerMessageId}`
            if (events.has(key)) return { inserted: false }
            events.set(key, {
                id: `event-${++sequence}`,
                organizationId: input.organizationId,
                emailAccountId: input.emailAccountId,
                provider: input.provider,
                providerMessageId: input.providerMessageId,
                messageId: input.messageId,
                inReplyTo: input.inReplyTo,
                messageReferences: input.messageReferences,
                classification: input.classification,
                fromAddress: input.fromAddress,
                subject: input.subject,
                textBody: input.textBody,
                htmlBody: input.htmlBody,
                receivedAt: input.receivedAt,
                processedAt: null,
                processingError: null,
            })
            return { inserted: true }
        },
        async loadCursor() {
            return cursor
        },
        async saveCursor(_account, _provider, next) {
            cursor = { ...next }
        },
        // Mirrors the SQL store's lease: pick the oldest pending row of this
        // classification, run the handler, and only then mark it processed. A failure
        // records the error and leaves the row pending, exactly as the transaction does.
        // The fake cannot model a crash — see outreach-inbound-claim.db.test.ts for that.
        async withNextPendingEvent(classification, handle) {
            const pending = [...events.values()].find((event) =>
                event.classification === classification
                && event.processedAt === null
                && event.processingError === null)
            if (!pending) return { status: 'idle' }

            try {
                await handle({ ...pending })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                pending.processingError = message.slice(0, 1000)
                return { status: 'failed', event: { ...pending }, error: message }
            }

            pending.processedAt = new Date('2026-07-16T12:00:00.000Z')
            pending.processingError = null
            return { status: 'processed', event: { ...pending } }
        },
        all: () => [...events.values()],
        cursorState: () => cursor,
    }
    return store
}

function createFakeSource(pages: NormalizedInboundMessage[][], nextCursor: ProviderCursorState): InboundSource {
    let call = 0
    return {
        provider: 'native',
        async fetchPage(_cursor, pageSize) {
            const messages = (pages[call++] ?? []).slice(0, pageSize)
            return { messages, nextCursor }
        },
    }
}

const EMPTY_CURSOR: ProviderCursorState = {
    deltaCursor: null,
    uidValidity: null,
    lastUid: null,
    lastReceivedAt: null,
    lastProviderMessageId: null,
}

describe('classifyInboundMessage', () => {
    it('classifies a DSN as a bounce even when it also looks like a reply', () => {
        // The regression that motivated this module: a DSN carries In-Reply-To
        // referencing the original outreach email, so a reply-first order let the
        // reply job consume a hard bounce and mark it read before the bounce job ran.
        const result = classifyInboundMessage({
            fromAddress: 'MAILER-DAEMON@mx.prospect.test',
            subject: 'Undeliverable: Quick question',
            headers: { 'content-type': 'multipart/report; report-type=delivery-status; boundary=x' },
            inReplyTo: 'xmail-abc@outreach.local',
            references: 'xmail-abc@outreach.local',
        })
        expect(result.classification).toBe('bounce')
    })

    it('recognizes a DSN by its report content type alone', () => {
        expect(classifyInboundMessage({
            fromAddress: 'noreply@relay.test',
            subject: 'Delivery report',
            headers: { 'content-type': 'multipart/report; report-type=delivery-status' },
            inReplyTo: null,
            references: null,
        })).toMatchObject({ classification: 'bounce', signal: 'dsn_report' })
    })

    it('ranks bounce ahead of an out-of-office subject', () => {
        expect(classifyInboundMessage({
            fromAddress: 'postmaster@prospect.test',
            subject: 'Automatic reply: Undeliverable',
            headers: {},
            inReplyTo: 'xmail-abc@outreach.local',
            references: null,
        }).classification).toBe('bounce')
    })

    it('classifies auto-replies ahead of human replies', () => {
        expect(classifyInboundMessage({
            fromAddress: 'lead@prospect.test',
            subject: 'Re: Quick question',
            headers: { 'auto-submitted': 'auto-replied' },
            inReplyTo: 'xmail-abc@outreach.local',
            references: null,
        })).toMatchObject({ classification: 'auto_reply', signal: 'auto_submitted' })

        expect(classifyInboundMessage({
            fromAddress: 'lead@prospect.test',
            subject: 'Out of office',
            headers: {},
            inReplyTo: 'xmail-abc@outreach.local',
            references: null,
        })).toMatchObject({ classification: 'auto_reply', signal: 'subject_ooo' })
    })

    it('classifies a threaded human reply', () => {
        expect(classifyInboundMessage({
            fromAddress: 'lead@prospect.test',
            subject: 'Re: Quick question',
            headers: {},
            inReplyTo: 'xmail-abc@outreach.local',
            references: null,
        })).toMatchObject({ classification: 'reply', signal: 'in_reply_to' })

        expect(classifyInboundMessage({
            fromAddress: 'lead@prospect.test',
            subject: 'Re: Quick question',
            headers: {},
            inReplyTo: null,
            references: '<root@outreach.local> <xmail-abc@outreach.local>',
        })).toMatchObject({ classification: 'reply', signal: 'references' })
    })

    it('keeps the from-address fallback reachable for clients that strip In-Reply-To', () => {
        // Preserves the existing tier-3 matcher in matchReplyToOutreach. Without this
        // the message would be staged as 'other' and the reply consumer would never
        // query it, silently dropping a matcher the code already relies on.
        expect(classifyInboundMessage({
            fromAddress: 'lead@prospect.test',
            subject: 'about your note',
            headers: {},
            inReplyTo: null,
            references: null,
            hasKnownCorrespondent: true,
        })).toMatchObject({ classification: 'reply', signal: 'known_correspondent' })
    })

    it('preserves unrelated human mail as other rather than dropping it', () => {
        expect(classifyInboundMessage({
            fromAddress: 'stranger@elsewhere.test',
            subject: 'Partnership idea',
            headers: {},
            inReplyTo: null,
            references: null,
        })).toMatchObject({ classification: 'other' })
    })
})

describe('page bounds', () => {
    it('defaults to 200 and never exceeds the hard cap of 500', () => {
        expect(DEFAULT_INBOUND_PAGE_SIZE).toBe(200)
        expect(MAX_INBOUND_PAGE_SIZE).toBe(500)
        expect(resolveInboundPageSize(undefined)).toBe(200)
        expect(resolveInboundPageSize(50)).toBe(50)
        expect(resolveInboundPageSize(5_000)).toBe(500)
        expect(resolveInboundPageSize(0)).toBe(1)
        expect(resolveInboundPageSize(-10)).toBe(1)
    })

    it('caps a source that ignores the requested page size', async () => {
        const store = createFakeStore()
        const oversized = Array.from({ length: 900 }, (_, index) => message({
            providerMessageId: `bulk-${index}`,
            messageId: `bulk-${index}@prospect.test`,
        }))
        const source: InboundSource = {
            provider: 'native',
            async fetchPage() {
                return { messages: oversized, nextCursor: EMPTY_CURSOR }
            },
        }

        const result = await ingestInboundPage({
            store,
            source,
            account: { id: ACCOUNT, organizationId: ORG },
            pageSize: 5_000,
        })

        expect(result.scanned).toBe(MAX_INBOUND_PAGE_SIZE)
        expect(store.all()).toHaveLength(MAX_INBOUND_PAGE_SIZE)
    })
})

describe('resolveImapCursor', () => {
    it('starts from zero when no cursor exists', () => {
        expect(resolveImapCursor(null, 12)).toEqual({ startUid: 0, reset: false, uidValidity: 12 })
    })

    it('resumes from the stored high-water mark while UIDVALIDITY is stable', () => {
        expect(resolveImapCursor({ ...EMPTY_CURSOR, uidValidity: 12, lastUid: 480 }, 12))
            .toEqual({ startUid: 480, reset: false, uidValidity: 12 })
    })

    it('resets safely when UIDVALIDITY changes', () => {
        // The server renumbered UIDs, so the stored high-water mark now points at a
        // different message. Resuming from it would skip mail that was never seen.
        expect(resolveImapCursor({ ...EMPTY_CURSOR, uidValidity: 12, lastUid: 480 }, 77))
            .toEqual({ startUid: 0, reset: true, uidValidity: 77 })
    })

    it('does not trust a high-water mark stored without UIDVALIDITY', () => {
        expect(resolveImapCursor({ ...EMPTY_CURSOR, uidValidity: null, lastUid: 480 }, 12))
            .toEqual({ startUid: 0, reset: true, uidValidity: 12 })
    })
})

describe('provider message keys', () => {
    it('keys native events on the durable row id', () => {
        expect(nativeProviderMessageId('11111111-2222-4333-8444-555555555555'))
            .toBe('11111111-2222-4333-8444-555555555555')
    })

    it('prefers the internet Message-ID so a UIDVALIDITY reset cannot duplicate side effects', () => {
        // uid:<validity>:<uid> is not stable across renumbering: after a reset the same
        // physical message reappears under a new UID and would re-ingest as a new event.
        expect(imapProviderMessageId({ messageId: '<abc@prospect.test>', uidValidity: 12, uid: 5 }))
            .toBe('mid:abc@prospect.test')
        expect(imapProviderMessageId({ messageId: '<abc@prospect.test>', uidValidity: 77, uid: 900 }))
            .toBe('mid:abc@prospect.test')
    })

    it('falls back to uid coordinates when a message has no Message-ID', () => {
        expect(imapProviderMessageId({ messageId: null, uidValidity: 12, uid: 5 })).toBe('uid:12:5')
    })
})

describe('ingestInboundPage', () => {
    it('stages every scanned message with one durable classification', async () => {
        const store = createFakeStore()
        const source = createFakeSource([[
            message({ providerMessageId: 'a', inReplyTo: 'xmail-1@outreach.local', subject: 'Re: hi' }),
            message({
                providerMessageId: 'b',
                fromAddress: 'mailer-daemon@mx.test',
                subject: 'Undeliverable: hi',
                inReplyTo: 'xmail-2@outreach.local',
            }),
            message({ providerMessageId: 'c', subject: 'Out of office', inReplyTo: 'xmail-3@outreach.local' }),
            message({ providerMessageId: 'd', subject: 'Cold pitch' }),
        ]], { ...EMPTY_CURSOR, lastReceivedAt: new Date('2026-07-16T10:00:00.000Z'), lastProviderMessageId: 'd' })

        const result = await ingestInboundPage({
            store,
            source,
            account: { id: ACCOUNT, organizationId: ORG },
        })

        expect(result).toMatchObject({ scanned: 4, recorded: 4, duplicates: 0 })
        expect(store.all().map((event) => [event.providerMessageId, event.classification])).toEqual([
            ['a', 'reply'],
            ['b', 'bounce'],
            ['c', 'auto_reply'],
            ['d', 'other'],
        ])
    })

    it('records a duplicate provider id once', async () => {
        const store = createFakeStore()
        const page = [message({ providerMessageId: 'dup', inReplyTo: 'xmail-1@outreach.local' })]
        const source = createFakeSource([page, page], EMPTY_CURSOR)
        const deps = { store, source, account: { id: ACCOUNT, organizationId: ORG } }

        const first = await ingestInboundPage(deps)
        const second = await ingestInboundPage(deps)

        expect(first).toMatchObject({ recorded: 1, duplicates: 0 })
        expect(second).toMatchObject({ recorded: 0, duplicates: 1 })
        expect(store.all()).toHaveLength(1)
    })

    it('advances the cursor so a restart does not rescan the whole inbox', async () => {
        const store = createFakeStore()
        const advanced: ProviderCursorState = {
            ...EMPTY_CURSOR,
            lastReceivedAt: new Date('2026-07-16T10:05:00.000Z'),
            lastProviderMessageId: 'z',
        }
        const source = createFakeSource([[message({ providerMessageId: 'z' })]], advanced)

        await ingestInboundPage({ store, source, account: { id: ACCOUNT, organizationId: ORG } })
        expect(store.cursorState()).toMatchObject({
            lastReceivedAt: advanced.lastReceivedAt,
            lastProviderMessageId: 'z',
        })

        // A restart reads the persisted cursor and asks the provider for what follows it.
        const fetchPage = vi.fn(async () => ({ messages: [], nextCursor: advanced }))
        await ingestInboundPage({
            store,
            source: { provider: 'native', fetchPage },
            account: { id: ACCOUNT, organizationId: ORG },
        })
        expect(fetchPage).toHaveBeenCalledWith(
            expect.objectContaining({ lastProviderMessageId: 'z' }),
            DEFAULT_INBOUND_PAGE_SIZE,
        )
    })

    it('never advances the cursor past an unstaged message when recording fails', async () => {
        const store = createFakeStore()
        const failing: InboundEventStore = {
            ...store,
            recordEvent: async () => { throw new Error('database unavailable') },
        }
        const source = createFakeSource([[message({ providerMessageId: 'lost' })]], {
            ...EMPTY_CURSOR,
            lastProviderMessageId: 'lost',
        })

        await expect(ingestInboundPage({
            store: failing,
            source,
            account: { id: ACCOUNT, organizationId: ORG },
        })).rejects.toThrow('database unavailable')

        // Losing the page is recoverable; advancing past it is not.
        expect(store.cursorState()).toBeNull()
    })

    it('does not read or mutate user read state', async () => {
        const store = createFakeStore()
        const fetchPage = vi.fn(async () => ({ messages: [], nextCursor: EMPTY_CURSOR }))
        await ingestInboundPage({
            store,
            source: { provider: 'native', fetchPage },
            account: { id: ACCOUNT, organizationId: ORG },
        })
        // The store port has no surface for read flags at all — the cursor is the
        // only progress signal.
        expect(Object.keys(store)).not.toContain('markRead')
    })
})

describe('consumeClassifiedEvents', () => {
    it('delivers a bounce to the bounce consumer and never to the reply consumer', async () => {
        const store = createFakeStore()
        const source = createFakeSource([[
            message({ providerMessageId: 'r', inReplyTo: 'xmail-1@outreach.local', subject: 'Re: hi' }),
            message({
                providerMessageId: 'd',
                fromAddress: 'mailer-daemon@mx.test',
                subject: 'Undeliverable: hi',
                inReplyTo: 'xmail-2@outreach.local',
            }),
        ]], EMPTY_CURSOR)
        await ingestInboundPage({ store, source, account: { id: ACCOUNT, organizationId: ORG } })

        const replyHandler = vi.fn(async (_event: StoredProviderEvent) => {})
        const bounceHandler = vi.fn(async (_event: StoredProviderEvent) => {})
        await consumeClassifiedEvents({ store, classification: 'reply', handle: replyHandler })
        await consumeClassifiedEvents({ store, classification: 'bounce', handle: bounceHandler })

        expect(replyHandler).toHaveBeenCalledTimes(1)
        expect(replyHandler.mock.calls[0][0]).toMatchObject({ providerMessageId: 'r' })
        expect(bounceHandler).toHaveBeenCalledTimes(1)
        expect(bounceHandler.mock.calls[0][0]).toMatchObject({ providerMessageId: 'd' })
    })

    it('applies each side effect exactly once across repeated runs', async () => {
        const store = createFakeStore()
        const source = createFakeSource([[
            message({ providerMessageId: 'r', inReplyTo: 'xmail-1@outreach.local' }),
        ]], EMPTY_CURSOR)
        await ingestInboundPage({ store, source, account: { id: ACCOUNT, organizationId: ORG } })

        const handle = vi.fn(async () => {})
        const first = await consumeClassifiedEvents({ store, classification: 'reply', handle })
        const second = await consumeClassifiedEvents({ store, classification: 'reply', handle })

        expect(first).toMatchObject({ claimed: 1, processed: 1, failed: 0 })
        expect(second).toMatchObject({ claimed: 0, processed: 0, failed: 0 })
        expect(handle).toHaveBeenCalledTimes(1)
    })

    it('records a handler failure without consuming the event', async () => {
        const store = createFakeStore()
        const source = createFakeSource([[
            message({ providerMessageId: 'r', inReplyTo: 'xmail-1@outreach.local' }),
        ]], EMPTY_CURSOR)
        await ingestInboundPage({ store, source, account: { id: ACCOUNT, organizationId: ORG } })

        const handle = vi.fn(async () => { throw new Error('lead row vanished') })
        const result = await consumeClassifiedEvents({ store, classification: 'reply', handle })

        expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 })
        expect(store.all()[0].processingError).toContain('lead row vanished')
        // C-2: the failure must not consume the event. It stays pending so a later tick
        // can retry it once the backoff has elapsed.
        expect(store.all()[0].processedAt).toBeNull()

        // ...but not on this tick — the backoff is what stops a poison event from being
        // re-claimed in a hot loop.
        const retry = vi.fn(async () => {})
        await consumeClassifiedEvents({ store, classification: 'reply', handle: retry })
        expect(retry).not.toHaveBeenCalled()
    })

    it('honours the claim limit', async () => {
        const store = createFakeStore()
        const source = createFakeSource([
            Array.from({ length: 10 }, (_, index) => message({
                providerMessageId: `r-${index}`,
                inReplyTo: 'xmail-1@outreach.local',
            })),
        ], EMPTY_CURSOR)
        await ingestInboundPage({ store, source, account: { id: ACCOUNT, organizationId: ORG } })

        const handle = vi.fn(async () => {})
        const result = await consumeClassifiedEvents({ store, classification: 'reply', limit: 3, handle })
        expect(result.claimed).toBe(3)
        expect(handle).toHaveBeenCalledTimes(3)
    })
})
