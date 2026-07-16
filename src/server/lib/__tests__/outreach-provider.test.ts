import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PROV-03 / PROV-05 — provider parity.
 *
 * The contract under test: an outreach message is composed ONCE into MIME bytes, and every
 * provider (SMTP, native relay, Outlook Graph) ships those same bytes. A test that only
 * checked "the send succeeded" would not have caught the bug this plan exists to fix —
 * Outlook silently dropping List-Unsubscribe and returning no Message-ID — so the assertions
 * here are deliberately about the raw bytes and the returned id, not about call counts.
 */

const dbMock = vi.hoisted(() => ({
    query: { outlookMailboxes: { findFirst: vi.fn() } },
    update: vi.fn(),
}))

// Path is relative to THIS file: src/db, the same module outlook.ts reaches via '../../db'.
// Without this the real client is constructed at import time and throws on DATABASE_URL.
vi.mock('../../../db', () => ({ db: dbMock, queryClient: vi.fn() }))

import { encryptSecret } from '../crypto'
import {
    createStableOutreachMessageId,
    dispatchOutreachMessage,
    normalizeProviderFailure,
} from '../outreach-dispatch'
import { OutlookGraphError, sendMimeMessageWithOutlook } from '../outlook'
import {
    composeOutreachMime,
    createOutreachProviderAdapter,
    createSmtpTransporter,
    findMissingMimeHeaders,
    readMimeHeader,
    REQUIRED_OUTREACH_MIME_HEADERS,
    sendComposedOutreachMessage,
    toDispatchResult,
    type ComposedOutreachMessage,
    type OutreachMimeInput,
} from '../outreach-provider'

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002'
const MAILBOX_ID = '00000000-0000-4000-8000-000000000003'
const STABLE_MESSAGE_ID = '<xmail-6f1a2b3c@outreach.local>'
const UNSUBSCRIBE_URL = 'https://app.example.com/o/u/eyJraW5kIjoidW5zdWIiLCJjbGlkIjoiMTIzNCIsImNpZCI6IjU2NzgifQ.averylongsignaturesegment'

function emailAccount(overrides: Record<string, unknown> = {}) {
    return {
        id: ACCOUNT_ID,
        organizationId: ORGANIZATION_ID,
        email: 'seller@example.com',
        displayName: 'Seller',
        provider: 'smtp',
        status: 'verified',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: null,
        smtpUsername: 'seller@example.com',
        smtpPassword: encryptSecret('hunter2'),
        outlookMailboxId: null,
        ...overrides,
    } as never
}

const CAMPAIGN_MIME: OutreachMimeInput = {
    from: { address: 'seller@example.com', name: 'Seller Person' },
    to: ['lead@prospect.com'],
    subject: 'Quick question about Prospect Co',
    text: 'Hi there, plain text version.',
    html: '<p>Hi there, <b>html</b> version.</p>',
    replyTo: 'replies@example.com',
    messageId: STABLE_MESSAGE_ID,
    unsubscribe: { url: UNSUBSCRIBE_URL, mailto: 'unsubscribe@example.com?subject=unsubscribe' },
}

const THREADED_MIME: OutreachMimeInput = {
    from: { address: 'seller@example.com', name: 'Seller Person' },
    to: ['lead@prospect.com'],
    subject: 'Re: Quick question about Prospect Co',
    text: 'Following up on your reply.',
    messageId: STABLE_MESSAGE_ID,
    inReplyTo: '<inbound-reply@prospect.com>',
    references: '<root@example.com> <inbound-reply@prospect.com>',
}

function rawHeaders(message: ComposedOutreachMessage): string {
    return message.raw.toString('utf8').split('\r\n\r\n')[0]
}

function graphResponse(status: number, body = '', headers: Record<string, string> = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: async () => body,
        json: async () => (body ? JSON.parse(body) : {}),
    }
}

/** Minimal drizzle-shaped stub: `.where()` must be awaitable AND expose `.returning()`. */
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
        scopes: ['Mail.Send', 'Mail.Read', 'Mail.ReadWrite'],
        status: 'active',
        accessTokenEncrypted: encryptSecret('access-token-current'),
        refreshTokenEncrypted: encryptSecret('refresh-token-current'),
        tokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        lastSyncedAt: null,
        lastSendAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', 'test-outlook-encryption-key')
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'client-id')
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'client-secret')
    vi.stubEnv('MICROSOFT_REDIRECT_URI', 'https://app.example.com/oauth/callback')
    stubDbUpdate([outlookMailbox()])
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

describe('composeOutreachMime', () => {
    it('keeps the caller-supplied stable Message-ID so it is known before dispatch', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        expect(message.messageId).toBe(STABLE_MESSAGE_ID)
        expect(readMimeHeader(message.raw, 'Message-ID')).toBe(STABLE_MESSAGE_ID)
    })

    it('emits RFC 8058 one-click unsubscribe headers for campaign sends', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        expect(readMimeHeader(message.raw, 'List-Unsubscribe'))
            .toBe(`<${UNSUBSCRIBE_URL}>, <mailto:unsubscribe@example.com?subject=unsubscribe>`)
        expect(readMimeHeader(message.raw, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
    })

    it('carries both body alternatives in one multipart/alternative message', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const raw = message.raw.toString('utf8')

        expect(readMimeHeader(message.raw, 'Content-Type')).toContain('multipart/alternative')
        expect(raw).toContain('Hi there, plain text version.')
        expect(raw).toContain('<b>html</b>')
    })

    it('sets Reply-To from the campaign rather than the sending inbox', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        expect(readMimeHeader(message.raw, 'Reply-To')).toBe('replies@example.com')
        expect(readMimeHeader(message.raw, 'From')).toContain('<seller@example.com>')
    })

    it('omits unsubscribe headers when the caller does not supply them', async () => {
        const message = await composeOutreachMime(THREADED_MIME)

        expect(readMimeHeader(message.raw, 'List-Unsubscribe')).toBeNull()
        expect(readMimeHeader(message.raw, 'List-Unsubscribe-Post')).toBeNull()
    })

    it('preserves In-Reply-To and appends the parent to References for threaded replies', async () => {
        const message = await composeOutreachMime(THREADED_MIME)

        expect(readMimeHeader(message.raw, 'In-Reply-To')).toBe('<inbound-reply@prospect.com>')
        expect(readMimeHeader(message.raw, 'References'))
            .toBe('<root@example.com> <inbound-reply@prospect.com>')
    })

    it('brackets a bare parent id and appends it to References exactly once', async () => {
        const message = await composeOutreachMime({
            ...THREADED_MIME,
            inReplyTo: 'inbound-reply@prospect.com',
            references: 'root@example.com',
        })

        expect(readMimeHeader(message.raw, 'In-Reply-To')).toBe('<inbound-reply@prospect.com>')
        expect(readMimeHeader(message.raw, 'References'))
            .toBe('<root@example.com> <inbound-reply@prospect.com>')
    })

    it('encodes display names that would break a hand-built From string', async () => {
        const message = await composeOutreachMime({
            ...CAMPAIGN_MIME,
            from: { address: 'seller@example.com', name: 'José "Zé" Silva' },
        })

        const from = readMimeHeader(message.raw, 'From')
        expect(from).toContain('<seller@example.com>')
        // The old `"${name}" <${addr}>` concatenation produced an unquoted inner quote here.
        expect(from).not.toContain('"Zé"')
    })

    // Nodemailer's stream composer always writes a Bcc header; only the SMTP transport strips
    // it. We ship the composed bytes verbatim, so composing bcc into the message would leak
    // every blind recipient to every other recipient.
    it('keeps blind recipients in the envelope and out of the message headers', async () => {
        const message = await composeOutreachMime({
            ...CAMPAIGN_MIME,
            cc: ['cc@prospect.com'],
            bcc: ['archive@example.com'],
        })

        expect(readMimeHeader(message.raw, 'Cc')).toBe('cc@prospect.com')
        expect(readMimeHeader(message.raw, 'Bcc')).toBeNull()
        expect(message.envelope.to).toEqual(['lead@prospect.com', 'cc@prospect.com', 'archive@example.com'])
    })
})

describe('readMimeHeader', () => {
    it('unfolds continuation lines so a long List-Unsubscribe is readable', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        // Guard the guard: the header really is folded, so a naive substring check would miss.
        expect(rawHeaders(message)).toContain('List-Unsubscribe:\r\n ')
        expect(readMimeHeader(message.raw, 'List-Unsubscribe')).toContain(UNSUBSCRIBE_URL)
    })

    it('matches header names case-insensitively', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        expect(readMimeHeader(message.raw, 'message-id')).toBe(STABLE_MESSAGE_ID)
    })

    it('returns null for an absent header and never reads into the body', () => {
        const raw = Buffer.from('Subject: Hi\r\n\r\nX-Not-A-Header: body text\r\n')

        expect(readMimeHeader(raw, 'X-Not-A-Header')).toBeNull()
        expect(readMimeHeader(raw, 'Subject')).toBe('Hi')
    })
})

describe('findMissingMimeHeaders', () => {
    it('reports nothing missing for a composed outreach message', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        expect(findMissingMimeHeaders(message.raw, REQUIRED_OUTREACH_MIME_HEADERS)).toEqual([])
    })

    it('names the headers a malformed buffer lacks', () => {
        expect(findMissingMimeHeaders(Buffer.from('From: a@b.com\r\n\r\nbody'), REQUIRED_OUTREACH_MIME_HEADERS))
            .toEqual(['To', 'Subject', 'Message-ID'])
    })
})

describe('provider adapters ship the composed bytes', () => {
    it('SMTP relays the exact buffer and returns the precomposed Message-ID', async () => {
        const sendMail = vi.fn(async () => ({
            messageId: '<transport-invented-id@smtp.example.com>',
            response: '250 2.0.0 OK queued as ABC123',
        }))
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const adapter = createOutreachProviderAdapter(emailAccount(), {
            createSmtpTransport: () => ({ sendMail }) as never,
        })

        const result = await adapter.send(message)

        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
            raw: message.raw,
            envelope: message.envelope,
        }))
        // The transport's own id must not win: reply/bounce matching keys off the stable id
        // the dispatcher already persisted.
        expect(result.messageId).toBe(STABLE_MESSAGE_ID)
        expect(result.accepted).toBe(true)
        expect(result.acceptance).toBe('accepted')
    })

    it('native relays the same buffer through the DKIM relay and files the sent copy', async () => {
        const relayNativeMessage = vi.fn(async () => undefined)
        const storeNativeMessage = vi.fn(async () => undefined)
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const adapter = createOutreachProviderAdapter(emailAccount({ provider: 'native' }), {
            relayNativeMessage,
            storeNativeMessage,
            findNativeMailbox: async () => ({ id: 'native-mailbox' }) as never,
        })

        const result = await adapter.send(message)

        expect(relayNativeMessage).toHaveBeenCalledWith(
            'seller@example.com',
            ['lead@prospect.com'],
            message.raw,
        )
        expect(storeNativeMessage).toHaveBeenCalledWith(
            'native-mailbox',
            'sent',
            expect.objectContaining({ messageId: STABLE_MESSAGE_ID, subject: CAMPAIGN_MIME.subject }),
            true,
        )
        expect(result.messageId).toBe(STABLE_MESSAGE_ID)
    })

    it('native reports a missing mailbox as terminal rather than retrying forever', async () => {
        const relayNativeMessage = vi.fn(async () => undefined)
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const adapter = createOutreachProviderAdapter(emailAccount({ provider: 'native' }), {
            relayNativeMessage,
            findNativeMailbox: async () => undefined,
        })

        const result = await adapter.send(message)

        expect(relayNativeMessage).not.toHaveBeenCalled()
        expect(result.accepted).toBe(false)
        expect(result.failure).toMatchObject({
            code: 'native_mailbox_missing',
            classification: 'terminal',
            retryable: false,
        })
    })

    it('native does not fail an already-relayed send when filing the sent copy throws', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const adapter = createOutreachProviderAdapter(emailAccount({ provider: 'native' }), {
            relayNativeMessage: async () => undefined,
            storeNativeMessage: async () => { throw new Error('folder gone') },
            findNativeMailbox: async () => ({ id: 'native-mailbox' }) as never,
        })

        const result = await adapter.send(message)

        expect(result.accepted).toBe(true)
        expect(result.messageId).toBe(STABLE_MESSAGE_ID)
    })

    it('Outlook hands the same buffer to Graph and returns the precomposed Message-ID', async () => {
        const sendOutlookMime = vi.fn(async () => ({ mailbox: outlookMailbox(), requestId: 'graph-req-1' }))
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const adapter = createOutreachProviderAdapter(
            emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
            { sendOutlookMime: sendOutlookMime as never },
        )

        const result = await adapter.send(message)

        expect(sendOutlookMime).toHaveBeenCalledWith(expect.objectContaining({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        }))
        expect(result.messageId).toBe(STABLE_MESSAGE_ID)
        expect(result.providerId).toBe('graph-req-1')
    })

    it('Outlook refuses to dispatch a buffer missing required headers', async () => {
        const sendOutlookMime = vi.fn()
        const adapter = createOutreachProviderAdapter(
            emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
            { sendOutlookMime: sendOutlookMime as never },
        )

        const result = await adapter.send({
            raw: Buffer.from('From: seller@example.com\r\n\r\nbody'),
            messageId: STABLE_MESSAGE_ID,
            envelope: { from: 'seller@example.com', to: ['lead@prospect.com'] },
            content: {} as never,
        })

        expect(sendOutlookMime).not.toHaveBeenCalled()
        expect(result.accepted).toBe(false)
        expect(result.failure).toMatchObject({ code: 'mime_headers_missing', classification: 'terminal' })
    })

    it('Outlook without a linked mailbox is terminal, not an exception', async () => {
        const adapter = createOutreachProviderAdapter(
            emailAccount({ provider: 'outlook', outlookMailboxId: null }),
            { sendOutlookMime: vi.fn() as never },
        )

        const result = await adapter.send(await composeOutreachMime(CAMPAIGN_MIME))

        expect(result.accepted).toBe(false)
        expect(result.failure).toMatchObject({ code: 'outlook_mailbox_unlinked', classification: 'terminal' })
    })

    // The whole point of the plan: provider choice must not change what the recipient receives.
    it('gives all three providers byte-identical MIME for one composed message', async () => {
        const message = await composeOutreachMime(CAMPAIGN_MIME)
        const seen: Buffer[] = []

        await createOutreachProviderAdapter(emailAccount(), {
            createSmtpTransport: () => ({
                sendMail: async (options: { raw: Buffer }) => {
                    seen.push(options.raw)
                    return { messageId: '<x@y>', response: '250 OK' }
                },
            }) as never,
        }).send(message)

        await createOutreachProviderAdapter(emailAccount({ provider: 'native' }), {
            relayNativeMessage: async (_from, _to, raw) => { seen.push(raw) },
            storeNativeMessage: async () => undefined,
            findNativeMailbox: async () => ({ id: 'native-mailbox' }) as never,
        }).send(message)

        await createOutreachProviderAdapter(
            emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
            { sendOutlookMime: (async (input: { raw: Buffer }) => { seen.push(input.raw); return { mailbox: outlookMailbox() } }) as never },
        ).send(message)

        expect(seen).toHaveLength(3)
        for (const raw of seen) {
            expect(raw.equals(message.raw)).toBe(true)
            expect(readMimeHeader(raw, 'List-Unsubscribe')).toContain(UNSUBSCRIBE_URL)
            expect(readMimeHeader(raw, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
            expect(readMimeHeader(raw, 'Message-ID')).toBe(STABLE_MESSAGE_ID)
        }
    })
})

describe('sendComposedOutreachMessage normalizes provider failures', () => {
    it('classifies an SMTP 4xx response as transient and retryable', async () => {
        const result = await sendComposedOutreachMessage(emailAccount(), CAMPAIGN_MIME, {
            createSmtpTransport: () => ({
                sendMail: async () => { throw Object.assign(new Error('451 try later'), { responseCode: 451 }) },
            }) as never,
        })

        expect(result.accepted).toBe(false)
        expect(result.failure).toMatchObject({ classification: 'transient', retryable: true, acceptance: 'rejected' })
    })

    it('classifies a Graph 429 as transient and retryable', async () => {
        const result = await sendComposedOutreachMessage(
            emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
            CAMPAIGN_MIME,
            { sendOutlookMime: (async () => { throw new OutlookGraphError('throttled', 429) }) as never },
        )

        expect(result.failure).toMatchObject({ code: 'provider_429', classification: 'transient', retryable: true })
    })

    it('classifies a Graph 400 as terminal', async () => {
        const result = await sendComposedOutreachMessage(
            emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
            CAMPAIGN_MIME,
            { sendOutlookMime: (async () => { throw new OutlookGraphError('bad mime', 400) }) as never },
        )

        expect(result.failure).toMatchObject({ code: 'provider_400', classification: 'terminal', retryable: false })
    })

    it('classifies a Graph 5xx as transient and retryable', async () => {
        const result = await sendComposedOutreachMessage(
            emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
            CAMPAIGN_MIME,
            { sendOutlookMime: (async () => { throw new OutlookGraphError('server error', 503) }) as never },
        )

        expect(result.failure).toMatchObject({ code: 'provider_503', classification: 'transient', retryable: true })
    })
})

describe('createSmtpTransporter uses the shared TLS resolver', () => {
    it('dials port 587 with STARTTLS rather than implicit TLS', () => {
        const transporter = createSmtpTransporter(emailAccount({ smtpPort: 587, smtpSecure: true }))

        expect(transporter.transporter.options).toMatchObject({
            port: 587,
            secure: false,
            requireTLS: true,
        })
    })

    it('dials port 465 with implicit TLS', () => {
        const transporter = createSmtpTransporter(emailAccount({ smtpPort: 465, smtpSecure: null }))

        expect(transporter.transporter.options).toMatchObject({ port: 465, secure: true })
    })
})

describe('sendMimeMessageWithOutlook (Graph MIME send)', () => {
    it('posts base64 MIME as text/plain to /me/sendMail', async () => {
        const fetchMock = vi.fn(async () => graphResponse(202, '', { 'request-id': 'graph-req-9' }))
        vi.stubGlobal('fetch', fetchMock)
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        const result = await sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
        expect(init.method).toBe('POST')
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token-current')
        expect(result.requestId).toBe('graph-req-9')
    })

    // The regression this plan closes: the old Graph JSON shape had nowhere to put these.
    it('sends a MIME body that still carries unsubscribe and threading headers', async () => {
        const fetchMock = vi.fn(async () => graphResponse(202))
        vi.stubGlobal('fetch', fetchMock)
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        const message = await composeOutreachMime({
            ...CAMPAIGN_MIME,
            inReplyTo: '<inbound-reply@prospect.com>',
            references: '<root@example.com>',
        })

        await sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        })

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        const decoded = Buffer.from(init.body as string, 'base64')
        expect(readMimeHeader(decoded, 'Message-ID')).toBe(STABLE_MESSAGE_ID)
        expect(readMimeHeader(decoded, 'List-Unsubscribe')).toContain(UNSUBSCRIBE_URL)
        expect(readMimeHeader(decoded, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
        expect(readMimeHeader(decoded, 'In-Reply-To')).toBe('<inbound-reply@prospect.com>')
        expect(readMimeHeader(decoded, 'References')).toBe('<root@example.com> <inbound-reply@prospect.com>')
    })

    it('refreshes the token and retries once when Graph rejects it with 401', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(graphResponse(401, '{"error":{"code":"InvalidAuthenticationToken"}}'))
            .mockResolvedValueOnce(graphResponse(200, JSON.stringify({
                access_token: 'access-token-refreshed',
                refresh_token: 'refresh-token-next',
                expires_in: 3600,
            })))
            .mockResolvedValueOnce(graphResponse(202))
        vi.stubGlobal('fetch', fetchMock)
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        stubDbUpdate([outlookMailbox({ accessTokenEncrypted: encryptSecret('access-token-refreshed') })])
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        await sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        })

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(fetchMock.mock.calls[1][0]).toContain('/oauth2/v2.0/token')
        const [, retry] = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
        expect((retry.headers as Record<string, string>).Authorization).toBe('Bearer access-token-refreshed')
    })

    it('gives up after one refresh so a revoked grant cannot loop', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(graphResponse(401, '{"error":{"code":"InvalidAuthenticationToken"}}'))
            .mockResolvedValueOnce(graphResponse(200, JSON.stringify({
                access_token: 'access-token-refreshed',
                expires_in: 3600,
            })))
            .mockResolvedValueOnce(graphResponse(401, '{"error":{"code":"InvalidAuthenticationToken"}}'))
        vi.stubGlobal('fetch', fetchMock)
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        await expect(sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        })).rejects.toMatchObject({ statusCode: 401 })

        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('throws a classified error carrying the Graph status code', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => graphResponse(429, '{"error":{"message":"Too many requests"}}')))
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        const error = await sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        }).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(OutlookGraphError)
        expect(normalizeProviderFailure(error)).toMatchObject({
            code: 'provider_429',
            classification: 'transient',
            retryable: true,
        })
    })

    it('never leaks the access token into the thrown error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => graphResponse(400, '{"error":{"message":"Invalid MIME"}}')))
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        const error = await sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: message.raw,
        }).catch((e: unknown) => e) as Error

        expect(error.message).toContain('Invalid MIME')
        expect(error.message).not.toContain('access-token-current')
    })

    it('rejects a MIME payload above the documented Graph limit without calling Graph', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())

        await expect(sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'seller@example.com',
            raw: Buffer.alloc(5 * 1024 * 1024, 'a'),
        })).rejects.toMatchObject({ statusCode: 413 })

        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses to send as an address the mailbox does not own', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        dbMock.query.outlookMailboxes.findFirst.mockResolvedValue(outlookMailbox())
        const message = await composeOutreachMime(CAMPAIGN_MIME)

        await expect(sendMimeMessageWithOutlook({
            organizationId: ORGANIZATION_ID,
            mailboxId: MAILBOX_ID,
            fromAddress: 'someone-else@example.com',
            raw: message.raw,
        })).rejects.toThrow(/can only send with its own address/)

        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('dispatcher integration', () => {
    const dispatchInput = {
        origin: 'manual' as const,
        organizationId: ORGANIZATION_ID,
        emailAccountId: ACCOUNT_ID,
        idempotencyKey: 'manual:req-1',
        to: 'lead@prospect.com',
        subject: 'Hello',
        text: 'Body',
    }

    function repository() {
        return {
            claim: vi.fn(async () => ({
                kind: 'claimed' as const,
                rowId: 'row-1',
                leaseToken: 'lease-1',
                attemptCount: 0,
                maxAttempts: 3,
                payload: { to: dispatchInput.to, subject: dispatchInput.subject, text: 'Body', html: null },
            })),
            startDispatch: vi.fn(async () => ({ attemptCount: 1, maxAttempts: 3 })),
            releaseClaim: vi.fn(async () => true),
            finalizeSent: vi.fn(async () => true),
            finalizeFailure: vi.fn(async () => true),
        }
    }

    const allowed = {
        allowed: true as const,
        organization: { id: ORGANIZATION_ID, outreachEnabled: true },
        account: {
            id: ACCOUNT_ID,
            organizationId: ORGANIZATION_ID,
            status: 'verified' as const,
            dailySendLimit: 50,
            currentDailySent: 0,
            warmupEnabled: false,
            warmupDays: 14,
            warmupCurrentDay: 14,
            minMinutesBetweenEmails: 0,
            lastSentAt: null,
        },
    }

    it('makes no Graph request when policy denies the send', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        const repo = repository()

        const result = await dispatchOutreachMessage(dispatchInput, {
            repository: repo as never,
            evaluatePolicy: async () => ({ allowed: false, code: 'organization_disabled' }),
            provider: {
                send: async (input) => toDispatchResult(await sendComposedOutreachMessage(
                    emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
                    { ...CAMPAIGN_MIME, messageId: input.stableMessageId },
                )),
            },
        })

        expect(result).toMatchObject({ status: 'deferred', code: 'organization_disabled' })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(repo.claim).not.toHaveBeenCalled()
    })

    it('schedules a retry from a normalized Graph 429', async () => {
        const repo = repository()

        const result = await dispatchOutreachMessage(dispatchInput, {
            repository: repo as never,
            evaluatePolicy: async () => allowed,
            provider: {
                send: async (input) => toDispatchResult(await sendComposedOutreachMessage(
                    emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
                    { ...CAMPAIGN_MIME, messageId: input.stableMessageId },
                    { sendOutlookMime: (async () => { throw new OutlookGraphError('throttled', 429) }) as never },
                )),
            },
        })

        expect(result).toMatchObject({ status: 'retry_scheduled', code: 'provider_429' })
        expect(repo.finalizeFailure).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'claimed' }),
            expect.objectContaining({
                status: 'failed',
                failure: expect.objectContaining({ code: 'provider_429', retryable: true }),
            }),
        )
    })

    it('finalizes with the stable Message-ID the dispatcher composed', async () => {
        const repo = repository()

        const result = await dispatchOutreachMessage(dispatchInput, {
            repository: repo as never,
            evaluatePolicy: async () => allowed,
            provider: {
                send: async (input) => toDispatchResult(await sendComposedOutreachMessage(
                    emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
                    { ...CAMPAIGN_MIME, messageId: input.stableMessageId },
                    { sendOutlookMime: (async () => ({ mailbox: outlookMailbox(), requestId: 'graph-1' })) as never },
                )),
            },
        })

        // The id is derived from (organizationId, idempotencyKey) before the provider is
        // called, and the dispatcher strips the angle brackets before persisting — so a
        // retry of the same claim reuses it and the recipient never sees a duplicate id.
        const expected = createStableOutreachMessageId(ORGANIZATION_ID, dispatchInput.idempotencyKey)
        expect(result).toMatchObject({
            status: 'sent',
            messageId: expected.replace(/[<>]/g, ''),
        })
        expect(repo.finalizeSent).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'claimed' }),
            expect.objectContaining({ messageId: expected.replace(/[<>]/g, '') }),
            expect.any(Date),
        )
    })
})
