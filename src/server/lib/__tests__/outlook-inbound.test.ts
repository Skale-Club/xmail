import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PROV-02 / PROV-04 — Outlook inbound parity.
 *
 * Outlook was send-only: replies and DSNs arriving in a Graph mailbox were never read, so an
 * Outlook-assigned lead could hard-bounce and keep receiving the sequence forever. This suite
 * locks the Graph delta reader onto the same contract IMAP and native already obey:
 *
 *   - progress lives in a durable, resumable cursor (never in read/unread state),
 *   - the cursor advances only over messages that were actually read,
 *   - the same message ingests once no matter how often Graph replays it,
 *   - a throttle, a token expiry, or a mid-chain failure loses work but never loses mail.
 *
 * Assertions are deliberately behavioural (what URL is fetched next, what is staged) rather
 * than about the cursor's encoding, so the reader stays free to change how it marks a chain.
 */

const dbMock = vi.hoisted(() => ({
    query: {
        outlookMailboxes: { findFirst: vi.fn() },
        emailAccounts: { findMany: vi.fn() },
        mailFolders: { findFirst: vi.fn() },
        mailMessages: { findMany: vi.fn() },
    },
    update: vi.fn(),
    execute: vi.fn(),
}))

// Same seam as outreach-provider.test.ts: without it the real client is built at import time
// and throws on DATABASE_URL.
vi.mock('../../../db', () => ({ db: dbMock, queryClient: vi.fn() }))

import { encryptSecret } from '../crypto'
import {
    GRAPH_DELTA_INBOX_PATH,
    OutlookGraphError,
    fetchOutlookInboxDelta,
    type OutlookGraphMessage,
} from '../outlook'
import {
    graphProviderMessageId,
    ingestInboundPage,
    type InboundEventStore,
    type ProviderCursorState,
    type StoredProviderEvent,
} from '../outreach-inbound'
import { createGraphInboundSource, normalizeGraphMessage } from '../outreach-inbound-sources'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002'
const MAILBOX_ID = '00000000-0000-4000-8000-000000000003'

const NOW = new Date('2026-07-16T12:00:00.000Z')
const RECENT = '2026-07-16T10:00:00Z'
const ANCIENT = '2019-01-04T09:00:00Z'

const DELTA_LINK = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=D1'
const NEXT_LINK = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=S1'

function graphResponse(status: number, body = '', headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: async () => body,
        json: async () => (body ? JSON.parse(body) : {}),
    }
}

function deltaPage(body: Record<string, unknown>) {
    return graphResponse(200, JSON.stringify(body))
}

function stubDbUpdate(returning: unknown[] = []) {
    dbMock.update.mockReturnValue({
        set: () => ({
            where: () => Object.assign(Promise.resolve(returning), {
                returning: async () => returning,
            }),
        }),
    })
}

function outlookMailbox(overrides: Record<string, unknown> = {}) {
    return {
        id: MAILBOX_ID,
        organizationId: ORGANIZATION_ID,
        email: 'seller@example.com',
        displayName: 'Seller',
        microsoftUserId: 'ms-user',
        tenantId: 'tenant',
        scopes: ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send'],
        status: 'active',
        accessTokenEncrypted: encryptSecret('access-token-current'),
        refreshTokenEncrypted: encryptSecret('refresh-token-current'),
        tokenExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
        lastSyncedAt: null,
        lastSendAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }
}

function graphMessage(overrides: Partial<OutlookGraphMessage> = {}): OutlookGraphMessage {
    return {
        id: 'AAMk-graph-1',
        internetMessageId: '<inbound-1@prospect.test>',
        internetMessageHeaders: [
            { name: 'In-Reply-To', value: '<xmail-1@outreach.local>' },
            { name: 'References', value: '<root@outreach.local> <xmail-1@outreach.local>' },
            { name: 'Content-Type', value: 'text/plain; charset=utf-8' },
        ],
        from: { emailAddress: { address: 'lead@prospect.test', name: 'Lead Person' } },
        toRecipients: [{ emailAddress: { address: 'seller@example.com' } }],
        ccRecipients: [],
        subject: 'Re: Quick question',
        body: { contentType: 'text', content: 'Sounds good, call me tomorrow.' },
        bodyPreview: 'Sounds good',
        receivedDateTime: RECENT,
        hasAttachments: false,
        isDraft: false,
        ...overrides,
    } as OutlookGraphMessage
}

const now = () => NOW.getTime()

function readDelta(overrides: Partial<Parameters<typeof fetchOutlookInboxDelta>[0]> = {}) {
    return fetchOutlookInboxDelta({
        mailbox: outlookMailbox() as never,
        cursor: null,
        maxEvents: 200,
        now,
        ...overrides,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', 'test-outlook-encryption-key')
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'client-id')
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('MICROSOFT_REDIRECT_URI', 'https://app.example.com/oauth/callback')
    stubDbUpdate([outlookMailbox()])
})

describe('fetchOutlookInboxDelta — initial delta', () => {
    it('selects the identifiers, headers and bodies that classification depends on', async () => {
        const fetchMock = vi.fn(async () => deltaPage({ value: [graphMessage()], '@odata.deltaLink': DELTA_LINK }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta()

        const [url] = fetchMock.mock.calls[0] as unknown as [string]
        expect(url).toContain(GRAPH_DELTA_INBOX_PATH)
        // In-Reply-To/References exist ONLY in internetMessageHeaders — Graph has no
        // first-class field for them. Without this select, every Graph reply would look
        // unthreaded and classify as 'other'.
        expect(url).toContain('internetMessageHeaders')
        expect(url).toContain('internetMessageId')
        expect(url).toContain('receivedDateTime')
        expect(url).toContain('body')
        expect(url).toContain('$top=')

        expect(result.messages).toHaveLength(1)
        expect(result.cursor).toBe(DELTA_LINK)
        expect(result.cursorKind).toBe('delta')
        expect(result.reset).toBe(false)
    })

    it('bounds a first-ever sync to a recent lookback window', async () => {
        // A brand-new mailbox may hold years of mail. Staging all of it would flood the
        // event store and let ancient threads masquerade as fresh replies.
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [
                graphMessage({ id: 'recent', internetMessageId: '<recent@prospect.test>' }),
                graphMessage({ id: 'ancient', internetMessageId: '<ancient@prospect.test>', receivedDateTime: ANCIENT }),
            ],
            '@odata.deltaLink': DELTA_LINK,
        })))

        const result = await readDelta({ lookbackDays: 7 })

        expect(result.messages.map((m) => m.id)).toEqual(['recent'])
    })

    it('does not apply the lookback to a resumed chain', async () => {
        // Delta only returns what changed. If the poller was down for two weeks, the mail it
        // missed is old but still unprocessed — dropping it would lose exactly the bounces
        // the outage delayed.
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [graphMessage({ id: 'late', receivedDateTime: ANCIENT })],
            '@odata.deltaLink': DELTA_LINK,
        })))

        const result = await readDelta({ cursor: DELTA_LINK, lookbackDays: 7 })

        expect(result.messages.map((m) => m.id)).toEqual(['late'])
    })

    it('skips removed tombstones and drafts', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [
                graphMessage(),
                { id: 'gone', '@removed': { reason: 'deleted' } },
                graphMessage({ id: 'draft', internetMessageId: '<draft@x.test>', isDraft: true }),
            ],
            '@odata.deltaLink': DELTA_LINK,
        })))

        const result = await readDelta()

        expect(result.messages.map((m) => m.id)).toEqual(['AAMk-graph-1'])
    })
})

describe('fetchOutlookInboxDelta — paging and budgets', () => {
    it('follows @odata.nextLink and stores the deltaLink only once the chain completes', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage({ id: 'p1' })], '@odata.nextLink': NEXT_LINK }))
            .mockResolvedValueOnce(deltaPage({
                value: [graphMessage({ id: 'p2', internetMessageId: '<p2@prospect.test>' })],
                '@odata.deltaLink': DELTA_LINK,
            }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta()

        expect(fetchMock.mock.calls[1][0]).toBe(NEXT_LINK)
        expect(result.messages.map((m) => m.id)).toEqual(['p1', 'p2'])
        expect(result.cursor).toBe(DELTA_LINK)
        expect(result.cursorKind).toBe('delta')
        expect(result.pagesFetched).toBe(2)
    })

    it('stops at the event budget and resumes from the unread page next run', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage({ id: 'p1' })], '@odata.nextLink': NEXT_LINK }))
        vi.stubGlobal('fetch', fetchMock)

        const first = await readDelta({ maxEvents: 1 })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(first.messages.map((m) => m.id)).toEqual(['p1'])
        expect(first.cursorKind).toBe('next')

        // Behavioural round trip: whatever the cursor encodes, replaying it must ask Graph
        // for the page we stopped before — never re-read the page we already staged.
        const resume = vi.fn(async (_url: string) => deltaPage({ value: [], '@odata.deltaLink': DELTA_LINK }))
        vi.stubGlobal('fetch', resume)
        await readDelta({ cursor: first.cursor, maxEvents: 1 })
        expect(resume.mock.calls[0][0]).toBe(NEXT_LINK)
    })

    it('keeps the lookback bound across every page of a fresh chain', async () => {
        // The subtle one: a fresh chain paused at a nextLink resumes with a non-null cursor.
        // If "fresh" were inferred from `cursor === null`, page 2 of the first-ever sync
        // would silently ingest the entire mailbox history.
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage({ id: 'p1' })], '@odata.nextLink': NEXT_LINK }))
        vi.stubGlobal('fetch', fetchMock)

        const first = await readDelta({ maxEvents: 1, lookbackDays: 7 })

        const resume = vi.fn(async () => deltaPage({
            value: [
                graphMessage({ id: 'p2-recent', internetMessageId: '<p2@prospect.test>' }),
                graphMessage({ id: 'p2-ancient', internetMessageId: '<old@prospect.test>', receivedDateTime: ANCIENT }),
            ],
            '@odata.deltaLink': DELTA_LINK,
        }))
        vi.stubGlobal('fetch', resume)
        const second = await readDelta({ cursor: first.cursor, maxEvents: 200, lookbackDays: 7 })

        expect(second.messages.map((m) => m.id)).toEqual(['p2-recent'])
    })

    it('stops following pages once the page budget is spent', async () => {
        const fetchMock = vi.fn(async () => deltaPage({ value: [graphMessage()], '@odata.nextLink': NEXT_LINK }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta({ maxPages: 2 })

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.cursorKind).toBe('next')
    })

    it('stops following pages once the time budget is spent', async () => {
        // The clock advances because I/O happened, not after a fixed number of calls — a
        // call-counting fake would silently pass if the reader stopped checking the budget.
        let clockMs = NOW.getTime()
        const fetchMock = vi.fn(async () => {
            clockMs += 60_000
            return deltaPage({ value: [graphMessage()], '@odata.nextLink': NEXT_LINK })
        })
        vi.stubGlobal('fetch', fetchMock)

        const result = await fetchOutlookInboxDelta({
            mailbox: outlookMailbox() as never,
            cursor: DELTA_LINK,
            maxEvents: 200,
            timeBudgetMs: 20_000,
            now: () => clockMs,
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.cursorKind).toBe('next')
        expect(result.cursor).toBe(NEXT_LINK)
    })

    it('never returns more messages than the caller budgeted for', async () => {
        // ingestInboundPage truncates an oversized page but still advances the cursor, so a
        // source that overshoots its budget silently loses mail. Defer the page instead.
        const oversized = Array.from({ length: 30 }, (_, index) => graphMessage({
            id: `bulk-${index}`,
            internetMessageId: `<bulk-${index}@prospect.test>`,
        }))
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage({ id: 'p1' })], '@odata.nextLink': NEXT_LINK }))
            .mockResolvedValueOnce(deltaPage({ value: oversized, '@odata.deltaLink': DELTA_LINK }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta({ maxEvents: 5 })

        expect(result.messages.length).toBeLessThanOrEqual(5)
        expect(result.messages.map((m) => m.id)).toEqual(['p1'])
        expect(result.cursorKind).toBe('next')
    })
})

describe('fetchOutlookInboxDelta — recovery', () => {
    it('restarts with a bounded lookback when Graph expires the delta token', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(graphResponse(410, '{"error":{"code":"syncStateNotFound"}}'))
            .mockResolvedValueOnce(deltaPage({
                value: [
                    graphMessage({ id: 'recent' }),
                    graphMessage({ id: 'ancient', internetMessageId: '<old@prospect.test>', receivedDateTime: ANCIENT }),
                ],
                '@odata.deltaLink': DELTA_LINK,
            }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta({ cursor: 'https://graph.microsoft.com/v1.0/stale?$deltatoken=EXPIRED', lookbackDays: 7 })

        expect(fetchMock.mock.calls[0][0]).toContain('$deltatoken=EXPIRED')
        // The restart is a fresh chain, so the lookback applies again.
        expect(fetchMock.mock.calls[1][0]).toContain(GRAPH_DELTA_INBOX_PATH)
        expect(result.reset).toBe(true)
        expect(result.messages.map((m) => m.id)).toEqual(['recent'])
        expect(result.cursor).toBe(DELTA_LINK)
    })

    it('surfaces Retry-After on a throttle without discarding the prior good cursor', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => graphResponse(
            429,
            '{"error":{"message":"Too many requests"}}',
            { 'retry-after': '120' },
        )))

        const result = await readDelta({ cursor: DELTA_LINK })

        expect(result.messages).toEqual([])
        // Losing a tick is recoverable; losing the cursor means a full resync.
        expect(result.cursor).toBe(DELTA_LINK)
        expect(result.cursorKind).toBe('unchanged')
        expect(result.retryAfter?.getTime()).toBe(NOW.getTime() + 120_000)
    })

    it('keeps pages already read when a later page is throttled', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage({ id: 'p1' })], '@odata.nextLink': NEXT_LINK }))
            .mockResolvedValueOnce(graphResponse(429, '', { 'retry-after': '30' }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta({ cursor: DELTA_LINK })

        expect(result.messages.map((m) => m.id)).toEqual(['p1'])
        expect(result.retryAfter?.getTime()).toBe(NOW.getTime() + 30_000)

        const resume = vi.fn(async (_url: string) => deltaPage({ value: [], '@odata.deltaLink': DELTA_LINK }))
        vi.stubGlobal('fetch', resume)
        await readDelta({ cursor: result.cursor })
        expect(resume.mock.calls[0][0]).toBe(NEXT_LINK)
    })

    it('refreshes the token once when Graph rejects it and retries the same page', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(graphResponse(401, '{"error":{"code":"InvalidAuthenticationToken"}}'))
            .mockResolvedValueOnce(graphResponse(200, JSON.stringify({
                access_token: 'access-token-refreshed',
                refresh_token: 'refresh-token-next',
                expires_in: 3600,
            })))
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage()], '@odata.deltaLink': DELTA_LINK }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta({ cursor: DELTA_LINK })

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(fetchMock.mock.calls[1][0]).toContain('/oauth2/v2.0/token')
        expect(fetchMock.mock.calls[2][0]).toBe(DELTA_LINK)
        const [, retry] = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
        expect((retry.headers as Record<string, string>).Authorization).toBe('Bearer access-token-refreshed')
        expect(result.messages).toHaveLength(1)
    })

    it('gives up after one refresh so a revoked grant cannot loop', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(graphResponse(401, '{"error":{"code":"InvalidAuthenticationToken"}}'))
            .mockResolvedValueOnce(graphResponse(200, JSON.stringify({ access_token: 'refreshed', expires_in: 3600 })))
            .mockResolvedValueOnce(graphResponse(401, '{"error":{"code":"InvalidAuthenticationToken"}}'))
        vi.stubGlobal('fetch', fetchMock)

        await expect(readDelta({ cursor: DELTA_LINK })).rejects.toMatchObject({ statusCode: 401 })
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('does not advance past a page whose attachment metadata could not be read', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({ value: [graphMessage({ id: 'p1' })], '@odata.nextLink': NEXT_LINK }))
            .mockResolvedValueOnce(deltaPage({
                value: [graphMessage({ id: 'p2', internetMessageId: '<p2@prospect.test>', hasAttachments: true })],
                '@odata.deltaLink': DELTA_LINK,
            }))
            .mockResolvedValueOnce(graphResponse(500, '{"error":{"message":"backend busy"}}'))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta({ cursor: DELTA_LINK })

        // Page 1 was read in full and is safe to stage; page 2 was not, so the cursor must
        // still point at page 2 rather than at the deltaLink beyond it.
        expect(result.messages.map((m) => m.id)).toEqual(['p1'])
        expect(result.cursorKind).toBe('next')

        const resume = vi.fn(async (_url: string) => deltaPage({ value: [], '@odata.deltaLink': DELTA_LINK }))
        vi.stubGlobal('fetch', resume)
        await readDelta({ cursor: result.cursor })
        expect(resume.mock.calls[0][0]).toBe(NEXT_LINK)
    })

    it('throws a classified error when the very first page fails and nothing was read', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => graphResponse(500, '{"error":{"message":"backend busy"}}')))

        await expect(readDelta({ cursor: DELTA_LINK })).rejects.toBeInstanceOf(OutlookGraphError)
    })

    it('retains attachment metadata without downloading the bytes', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(deltaPage({
                value: [graphMessage({ hasAttachments: true })],
                '@odata.deltaLink': DELTA_LINK,
            }))
            .mockResolvedValueOnce(deltaPage({
                value: [{
                    id: 'att-1',
                    name: 'quote.pdf',
                    contentType: 'application/pdf',
                    size: 8412,
                    isInline: false,
                    contentId: null,
                }],
            }))
        vi.stubGlobal('fetch', fetchMock)

        const result = await readDelta()

        const [attachmentsUrl] = fetchMock.mock.calls[1] as unknown as [string]
        expect(attachmentsUrl).toContain('/attachments')
        // Binary blobs are deferred (Phase 22); metadata only.
        expect(attachmentsUrl).not.toContain('contentBytes')
        expect(result.messages[0].attachments).toEqual([
            expect.objectContaining({ name: 'quote.pdf', contentType: 'application/pdf', size: 8412 }),
        ])
    })
})

describe('normalizeGraphMessage', () => {
    it('maps a Graph message onto the shared normalized shape', () => {
        const normalized = normalizeGraphMessage(graphMessage())

        expect(normalized).toMatchObject({
            provider: 'outlook',
            providerMessageId: 'mid:inbound-1@prospect.test',
            messageId: 'inbound-1@prospect.test',
            inReplyTo: '<xmail-1@outreach.local>',
            references: '<root@outreach.local> <xmail-1@outreach.local>',
            fromAddress: 'lead@prospect.test',
            toAddresses: ['seller@example.com'],
            subject: 'Re: Quick question',
            textBody: 'Sounds good, call me tomorrow.',
            htmlBody: null,
        })
        expect(normalized?.receivedAt).toEqual(new Date(RECENT))
        // Headers are lower-cased so the shared classifier's lookups hit.
        expect(normalized?.headers['content-type']).toBe('text/plain; charset=utf-8')
    })

    it('keys on the internet Message-ID so a folder move cannot duplicate side effects', () => {
        // Graph ids are per-mailbox and change when a message moves between folders; the
        // internet Message-ID does not.
        expect(graphProviderMessageId({ messageId: '<abc@prospect.test>', graphId: 'AAMk-1' }))
            .toBe('mid:abc@prospect.test')
        expect(graphProviderMessageId({ messageId: '<abc@prospect.test>', graphId: 'AAMk-2-after-move' }))
            .toBe('mid:abc@prospect.test')
        expect(graphProviderMessageId({ messageId: null, graphId: 'AAMk-1' })).toBe('graph:AAMk-1')
    })

    it('routes an HTML body to htmlBody so reply context survives', () => {
        const normalized = normalizeGraphMessage(graphMessage({
            body: { contentType: 'html', content: '<p>Sounds good</p>' },
        }))

        expect(normalized?.htmlBody).toBe('<p>Sounds good</p>')
        expect(normalized?.textBody).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// Ingestion through the shared contracts
// ---------------------------------------------------------------------------

function createFakeStore() {
    const events = new Map<string, StoredProviderEvent>()
    let cursor: ProviderCursorState | null = null
    let sequence = 0
    const retries: Array<{ error: string; retryAt: Date | null }> = []

    const store: InboundEventStore & {
        all: () => StoredProviderEvent[]
        cursorState: () => ProviderCursorState | null
        retries: () => Array<{ error: string; retryAt: Date | null }>
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
        async claimPending() {
            return []
        },
        async recordProcessingError() {},
        async recordCursorRetry(_account, _provider, input) {
            retries.push({ error: input.error, retryAt: input.retryAt })
        },
        all: () => [...events.values()],
        cursorState: () => cursor,
        retries: () => retries,
    }
    return store
}

function graphSource(mailbox = outlookMailbox()) {
    return createGraphInboundSource({
        account: { id: ACCOUNT_ID, email: 'seller@example.com' },
        mailbox: mailbox as never,
        now,
    })
}

describe('Graph inbound obeys the shared inbound contracts', () => {
    it('stages a Graph DSN as a bounce, not as a reply', async () => {
        // Parity with IMAP/native: a DSN quotes the original Message-ID in In-Reply-To, so a
        // reply-first order would consume the bounce and never suppress the address.
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [graphMessage({
                id: 'dsn',
                internetMessageId: '<dsn@mx.prospect.test>',
                from: { emailAddress: { address: 'MAILER-DAEMON@mx.prospect.test' } },
                subject: 'Undeliverable: Quick question',
                internetMessageHeaders: [
                    { name: 'In-Reply-To', value: '<xmail-1@outreach.local>' },
                    { name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary=x' },
                ],
            })],
            '@odata.deltaLink': DELTA_LINK,
        })))
        const store = createFakeStore()

        await ingestInboundPage({
            store,
            source: graphSource(),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })

        expect(store.all()).toHaveLength(1)
        expect(store.all()[0]).toMatchObject({ provider: 'outlook', classification: 'bounce' })
    })

    it('records a replayed Graph message exactly once', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [graphMessage()],
            '@odata.deltaLink': DELTA_LINK,
        })))
        const store = createFakeStore()
        const deps = {
            store,
            source: graphSource(),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        }

        const first = await ingestInboundPage(deps)
        const second = await ingestInboundPage(deps)

        expect(first).toMatchObject({ recorded: 1, duplicates: 0 })
        expect(second).toMatchObject({ recorded: 0, duplicates: 1 })
        expect(store.all()).toHaveLength(1)
    })

    it('persists the deltaLink only after every event of the chain is staged', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [graphMessage()],
            '@odata.deltaLink': DELTA_LINK,
        })))
        const store = createFakeStore()
        const failing: InboundEventStore = {
            ...store,
            recordEvent: async () => { throw new Error('database unavailable') },
        }

        await expect(ingestInboundPage({
            store: failing,
            source: graphSource(),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })).rejects.toThrow('database unavailable')

        expect(store.cursorState()).toBeNull()
    })

    it('advances the durable delta cursor after a clean page', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => deltaPage({
            value: [graphMessage()],
            '@odata.deltaLink': DELTA_LINK,
        })))
        const store = createFakeStore()

        await ingestInboundPage({
            store,
            source: graphSource(),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })

        expect(store.cursorState()).toMatchObject({ deltaCursor: DELTA_LINK })
    })

    it('records the provider Retry-After against the cursor row', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => graphResponse(429, '', { 'retry-after': '90' })))
        const store = createFakeStore()

        await ingestInboundPage({
            store,
            source: graphSource(),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })

        expect(store.retries()).toHaveLength(1)
        expect(store.retries()[0].retryAt?.getTime()).toBe(NOW.getTime() + 90_000)
    })
})
