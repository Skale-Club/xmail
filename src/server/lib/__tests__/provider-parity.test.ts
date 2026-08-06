import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PROV-05 — cross-provider parity.
 *
 * The claim under test is narrow and total: **the provider changes the transport and nothing
 * else.** Which inbox the round-robin happens to assign must not decide whether a recipient
 * gets a one-click opt-out, whether their reply can be threaded back to a campaign, whether
 * the kill switch applies, or whether a bounce is suppressed.
 *
 * The suite is deliberately table-driven over the three real adapters with only their
 * transports faked, because every regression this phase fixed shared one shape: a provider
 * branch that quietly did less than the others while every existing test still passed.
 */

const dbMock = vi.hoisted(() => ({
    query: {
        outlookMailboxes: { findFirst: vi.fn() },
        leads: { findFirst: vi.fn() },
        campaignLeads: { findFirst: vi.fn() },
    },
    update: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    execute: vi.fn(),
}))

vi.mock('../../../db', () => ({ db: dbMock, queryClient: vi.fn() }))

import { encryptSecret } from '../crypto'
import {
    createStableOutreachMessageId,
    dispatchOutreachMessage,
    type DispatchClaimResult,
    type DispatchClaimed,
    type DispatchOutreachInput,
    type DispatchRepository,
} from '../outreach-dispatch'
import {
    evaluateOutreachDeliverySnapshot,
    type DeliveryPolicyCode,
    type DeliveryPolicySnapshot,
} from '../outreach-delivery-policy'
import {
    readMimeHeader,
    sendComposedOutreachMessage,
    toDispatchResult,
    type OutreachProviderDependencies,
} from '../outreach-provider'
import {
    classifyInboundMessage,
    consumeClassifiedEvents,
    graphProviderMessageId,
    imapProviderMessageId,
    ingestInboundPage,
    nativeProviderMessageId,
    normalizeMessageId,
    type InboundEventStore,
    type InboundSource,
    type NormalizedInboundMessage,
    type ProviderCursorState,
    type StoredProviderEvent,
} from '../outreach-inbound'
import { normalizeReplyText } from '../../jobs/processReplies'

const NOW = new Date('2026-07-16T12:00:00.000Z')
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000002'
const CAMPAIGN_ID = '00000000-0000-4000-8000-000000000003'
const CAMPAIGN_LEAD_ID = '00000000-0000-4000-8000-000000000004'
const LEAD_ID = '00000000-0000-4000-8000-000000000006'
const MAILBOX_ID = '00000000-0000-4000-8000-000000000007'
const LEASE = '00000000-0000-4000-8000-000000000011'
const UNSUBSCRIBE_URL = 'https://app.example.com/o/u/eyJraW5kIjoidW5zdWIifQ.signature'

const STEP_ID = '00000000-0000-4000-8000-000000000005'

const INPUT: DispatchOutreachInput = {
    origin: 'campaign',
    organizationId: ORGANIZATION_ID,
    emailAccountId: ACCOUNT_ID,
    campaignId: CAMPAIGN_ID,
    campaignLeadId: CAMPAIGN_LEAD_ID,
    sequenceStepId: STEP_ID,
    leadId: LEAD_ID,
    trackingToken: 'track-token',
    idempotencyKey: 'campaign:lead-1:step-1',
    to: 'lead@prospect.test',
    subject: 'Quick question',
    text: 'Hi there, worth a chat?',
    html: '<p>Hi there, worth a chat?</p>',
}

/** What goes on the wire: RFC 5322 requires the angle brackets. */
const STABLE_MESSAGE_ID = createStableOutreachMessageId(ORGANIZATION_ID, INPUT.idempotencyKey, 'seller@example.com')
/**
 * What goes in the ledger: the dispatcher strips the brackets before persisting, because
 * reply matching compares LOWER(outreach_emails.message_id) against an inbound In-Reply-To
 * that has already been unbracketed. The two forms must not drift apart per provider.
 */
const STORED_MESSAGE_ID = STABLE_MESSAGE_ID.replace(/[<>]/g, '')

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('OUTLOOK_TOKEN_ENCRYPTION_KEY', 'test-outlook-encryption-key')
})

function emailAccount(overrides: Record<string, unknown> = {}) {
    return {
        id: ACCOUNT_ID,
        organizationId: ORGANIZATION_ID,
        email: 'seller@example.com',
        displayName: 'Seller',
        provider: 'smtp',
        status: 'verified',
        outlookMailboxId: null,
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: null,
        smtpUsername: 'seller@example.com',
        smtpPassword: encryptSecret('hunter2'),
        ...overrides,
    }
}

// ---------------------------------------------------------------------------
// The three real adapters, with only their transports faked
// ---------------------------------------------------------------------------

type ProviderKind = 'smtp' | 'native' | 'outlook'

interface ProviderFixture {
    kind: ProviderKind
    account: ReturnType<typeof emailAccount>
    deps: OutreachProviderDependencies
    transmitted: () => Buffer | null
    transmitCount: () => number
}

function providerFixture(kind: ProviderKind): ProviderFixture {
    let raw: Buffer | null = null
    let count = 0
    const capture = (buffer: Buffer) => {
        raw = buffer
        count++
    }

    if (kind === 'smtp') {
        return {
            kind,
            account: emailAccount({ provider: 'smtp' }),
            deps: {
                createSmtpTransport: () => ({
                    sendMail: async (message: { raw: Buffer }) => {
                        capture(message.raw)
                        return { response: '250 2.0.0 OK' }
                    },
                }) as never,
            },
            transmitted: () => raw,
            transmitCount: () => count,
        }
    }

    if (kind === 'native') {
        return {
            kind,
            account: emailAccount({ provider: 'native', smtpHost: null, smtpPassword: null, smtpUsername: null }),
            deps: {
                findNativeMailbox: (async () => ({ id: 'native-mailbox' })) as never,
                relayNativeMessage: (async (_from: string, _to: string[], buffer: Buffer) => {
                    capture(buffer)
                }) as never,
                storeNativeMessage: (async () => undefined) as never,
            },
            transmitted: () => raw,
            transmitCount: () => count,
        }
    }

    return {
        kind,
        account: emailAccount({ provider: 'outlook', outlookMailboxId: MAILBOX_ID }),
        deps: {
            sendOutlookMime: (async (input: { raw: Buffer }) => {
                capture(input.raw)
                return { mailbox: { id: MAILBOX_ID }, requestId: 'graph-request-1' }
            }) as never,
        },
        transmitted: () => raw,
        transmitCount: () => count,
    }
}

const PROVIDER_KINDS: ProviderKind[] = ['smtp', 'native', 'outlook']

// ---------------------------------------------------------------------------
// Dispatcher harness
// ---------------------------------------------------------------------------

function claimed(overrides: Partial<DispatchClaimed> = {}): DispatchClaimed {
    return {
        kind: 'claimed',
        rowId: '00000000-0000-4000-8000-000000000010',
        leaseToken: LEASE,
        attemptCount: 0,
        maxAttempts: 3,
        payload: {
            to: INPUT.to,
            subject: INPUT.subject,
            text: INPUT.text ?? null,
            html: INPUT.html ?? null,
            trackingToken: INPUT.trackingToken,
            inReplyTo: INPUT.inReplyTo,
            references: INPUT.references,
            abVariant: INPUT.abVariant,
        },
        ...overrides,
    }
}

function repository(claimResult: DispatchClaimResult = claimed()): DispatchRepository & {
    claim: ReturnType<typeof vi.fn>
    startDispatch: ReturnType<typeof vi.fn>
    releaseClaim: ReturnType<typeof vi.fn>
    finalizeSent: ReturnType<typeof vi.fn>
    finalizeFailure: ReturnType<typeof vi.fn>
} {
    return {
        claim: vi.fn().mockResolvedValue(claimResult),
        startDispatch: vi.fn().mockResolvedValue({ attemptCount: 1, maxAttempts: 3 }),
        releaseClaim: vi.fn().mockResolvedValue(true),
        finalizeSent: vi.fn().mockResolvedValue(true),
        finalizeFailure: vi.fn().mockResolvedValue(true),
    }
}

const ALLOWED_SNAPSHOT: DeliveryPolicySnapshot = {
    organization: { id: ORGANIZATION_ID, outreachEnabled: true },
    account: {
        id: ACCOUNT_ID,
        organizationId: ORGANIZATION_ID,
        email: 'seller@example.com',
        status: 'verified',
        dailySendLimit: 50,
        currentDailySent: 0,
        warmupEnabled: false,
        warmupDays: 14,
        warmupCurrentDay: 14,
        minMinutesBetweenEmails: 0,
        lastSentAt: null,
    },
    campaign: {
        id: CAMPAIGN_ID,
        organizationId: ORGANIZATION_ID,
        status: 'active',
        timezone: 'UTC',
        sendOnWeekends: true,
        sendStartTime: '00:00',
        sendEndTime: '23:59',
    },
    lead: {
        id: LEAD_ID,
        organizationId: ORGANIZATION_ID,
        email: INPUT.to,
        unsubscribedAt: null,
        emailVerificationStatus: 'verified',
    },
    suppressed: false,
}

function snapshot(overrides: Partial<DeliveryPolicySnapshot> = {}): DeliveryPolicySnapshot {
    return {
        ...ALLOWED_SNAPSHOT,
        ...overrides,
        account: { ...ALLOWED_SNAPSHOT.account!, ...(overrides.account ?? {}) },
        campaign: { ...ALLOWED_SNAPSHOT.campaign!, ...(overrides.campaign ?? {}) },
        lead: { ...ALLOWED_SNAPSHOT.lead!, ...(overrides.lead ?? {}) },
    }
}

/**
 * Dispatch one message through the real dispatcher, the real policy evaluator, the real
 * composer and the real provider adapter — only the repository and the wire are faked.
 */
async function dispatchThrough(fixture: ProviderFixture, options: {
    policySnapshot?: DeliveryPolicySnapshot
    claimResult?: DispatchClaimResult
} = {}) {
    const repo = repository(options.claimResult ?? claimed())
    const send = vi.fn(async (input: DispatchOutreachInput & { stableMessageId: string }) => toDispatchResult(
        await sendComposedOutreachMessage(fixture.account as never, {
            from: { address: fixture.account.email, name: 'Seller' },
            to: [input.to],
            subject: input.subject,
            text: input.text ?? null,
            html: input.html ?? null,
            messageId: input.stableMessageId,
            inReplyTo: input.inReplyTo ?? null,
            references: input.references ?? null,
            unsubscribe: {
                url: UNSUBSCRIBE_URL,
                mailto: 'unsubscribe@example.com?subject=unsubscribe',
                oneClick: true,
            },
            date: NOW,
        }, fixture.deps),
    ))

    const result = await dispatchOutreachMessage(INPUT, {
        repository: repo,
        provider: { send },
        evaluatePolicy: async (input) => evaluateOutreachDeliverySnapshot(
            { ...input, now: NOW },
            options.policySnapshot ?? ALLOWED_SNAPSHOT,
        ),
        now: () => NOW,
        leaseToken: () => LEASE,
    })

    return { result, repo, send }
}

// ---------------------------------------------------------------------------
// Outbound parity
// ---------------------------------------------------------------------------

describe('every provider ships the same message', () => {
    it.each(PROVIDER_KINDS)('%s transmits the compliance headers and the stable Message-ID', async (kind) => {
        const fixture = providerFixture(kind)

        const { result } = await dispatchThrough(fixture)

        expect(result).toMatchObject({ status: 'sent', messageId: STORED_MESSAGE_ID })

        const raw = fixture.transmitted()
        expect(raw).not.toBeNull()
        // Bulk-sender compliance: the Graph JSON shape had nowhere to put these, so an
        // Outlook-assigned lead used to receive marketing mail with no one-click opt-out.
        expect(readMimeHeader(raw!, 'List-Unsubscribe')).toContain(UNSUBSCRIBE_URL)
        expect(readMimeHeader(raw!, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
        // Reply/bounce matching keys off exactly this id, so a transport-invented one is a
        // silently unmatchable message.
        expect(readMimeHeader(raw!, 'Message-ID')).toBe(STABLE_MESSAGE_ID)
        expect(readMimeHeader(raw!, 'Subject')).toBe(INPUT.subject)
    })

    it('composes an identical message for every provider', async () => {
        const fixtures = PROVIDER_KINDS.map(providerFixture)
        for (const fixture of fixtures) await dispatchThrough(fixture)

        // Byte equality is asserted one level down, in outreach-provider.test.ts, where a
        // single composed buffer reaches all three transports. It cannot be asserted here:
        // each provider composes its own message and Nodemailer mints a fresh random
        // multipart boundary every time, so identical messages differ in bytes by design.
        // What must match is everything a recipient or our matcher can actually observe.
        const observable = fixtures.map((fixture) => {
            const raw = fixture.transmitted()!
            return {
                from: readMimeHeader(raw, 'From'),
                to: readMimeHeader(raw, 'To'),
                subject: readMimeHeader(raw, 'Subject'),
                messageId: readMimeHeader(raw, 'Message-ID'),
                listUnsubscribe: readMimeHeader(raw, 'List-Unsubscribe'),
                listUnsubscribePost: readMimeHeader(raw, 'List-Unsubscribe-Post'),
                contentType: readMimeHeader(raw, 'Content-Type')?.split(';')[0],
                carriesText: raw.includes(INPUT.text!),
            }
        })

        expect(observable[1]).toEqual(observable[0])
        expect(observable[2]).toEqual(observable[0])
        expect(observable[0].carriesText).toBe(true)
    })

    it.each(PROVIDER_KINDS)('%s threads a reply through the same headers', async (kind) => {
        const fixture = providerFixture(kind)
        const parent = '<inbound-reply@prospect.test>'

        await dispatchThrough(fixture, {
            claimResult: claimed({
                payload: {
                    ...claimed().payload,
                    inReplyTo: parent,
                    references: '<root@outreach.local>',
                },
            }),
        })

        const raw = fixture.transmitted()!
        expect(readMimeHeader(raw, 'In-Reply-To')).toBe(parent)
        expect(readMimeHeader(raw, 'References')).toBe(`<root@outreach.local> ${parent}`)
    })
})

// ---------------------------------------------------------------------------
// Policy parity — the safety gate cannot be bypassed by provider choice
// ---------------------------------------------------------------------------

const DENIALS: Array<{ code: DeliveryPolicyCode; snapshot: DeliveryPolicySnapshot }> = [
    // The org-wide kill switch.
    { code: 'organization_disabled', snapshot: snapshot({ organization: { id: ORGANIZATION_ID, outreachEnabled: false } }) },
    { code: 'campaign_inactive', snapshot: snapshot({ campaign: { ...ALLOWED_SNAPSHOT.campaign!, status: 'paused' } }) },
    { code: 'account_not_verified', snapshot: snapshot({ account: { ...ALLOWED_SNAPSHOT.account!, status: 'pending' } }) },
    { code: 'lead_unsubscribed', snapshot: snapshot({ lead: { ...ALLOWED_SNAPSHOT.lead!, unsubscribedAt: NOW } }) },
    { code: 'recipient_suppressed', snapshot: snapshot({ suppressed: true }) },
    {
        code: 'outside_send_window',
        snapshot: snapshot({ campaign: { ...ALLOWED_SNAPSHOT.campaign!, sendStartTime: '09:00', sendEndTime: '10:00' } }),
    },
    {
        code: 'daily_limit_exhausted',
        snapshot: snapshot({ account: { ...ALLOWED_SNAPSHOT.account!, currentDailySent: 50 } }),
    },
    {
        code: 'warmup_limit_exhausted',
        snapshot: snapshot({
            account: {
                ...ALLOWED_SNAPSHOT.account!,
                warmupEnabled: true,
                warmupCurrentDay: 0,
                warmupDays: 14,
                currentDailySent: 5,
            },
        }),
    },
    {
        code: 'account_spacing',
        snapshot: snapshot({
            account: {
                ...ALLOWED_SNAPSHOT.account!,
                minMinutesBetweenEmails: 5,
                lastSentAt: new Date(NOW.getTime() - 60_000),
            },
        }),
    },
]

describe('no provider can bypass the delivery policy', () => {
    const cases = PROVIDER_KINDS.flatMap((kind) => DENIALS.map((denial) => ({ kind, ...denial })))

    it.each(cases)('$kind is denied by $code and never reaches the wire', async ({ kind, code, snapshot: policySnapshot }) => {
        const fixture = providerFixture(kind)

        const { result, repo, send } = await dispatchThrough(fixture, { policySnapshot })

        expect(result).toMatchObject({ status: 'deferred', code })
        // The gate runs before the adapter for every provider: nothing was composed, nothing
        // was transmitted, and no attempt was ever started.
        expect(send).not.toHaveBeenCalled()
        expect(fixture.transmitted()).toBeNull()
        expect(repo.startDispatch).not.toHaveBeenCalled()
        expect(repo.finalizeSent).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------
// Attempt-history and counter parity
// ---------------------------------------------------------------------------

describe('every provider writes the same durable history', () => {
    it.each(PROVIDER_KINDS)('%s records exactly one claim, one attempt and one finalize', async (kind) => {
        const fixture = providerFixture(kind)

        const { repo } = await dispatchThrough(fixture)

        expect(repo.claim).toHaveBeenCalledTimes(1)
        // startDispatch is what increments the budget/counter. Exactly once per send, for
        // every provider — no adapter gets to bump it a second time.
        expect(repo.startDispatch).toHaveBeenCalledTimes(1)
        expect(repo.finalizeSent).toHaveBeenCalledTimes(1)
        expect(repo.finalizeFailure).not.toHaveBeenCalled()
        expect(fixture.transmitCount()).toBe(1)

        const [, finalized] = repo.finalizeSent.mock.calls[0]
        // Unbracketed in the ledger, bracketed on the wire — for all three providers.
        expect(finalized).toMatchObject({ success: true, messageId: STORED_MESSAGE_ID })
    })

    it.each(PROVIDER_KINDS)('%s re-dispatching the same key sends nothing and counts nothing', async (kind) => {
        const fixture = providerFixture(kind)

        const { result, repo, send } = await dispatchThrough(fixture, {
            claimResult: { kind: 'duplicate', rowId: 'row-1' },
        })

        expect(result.status).toBe('duplicate')
        expect(send).not.toHaveBeenCalled()
        expect(fixture.transmitCount()).toBe(0)
        expect(repo.startDispatch).not.toHaveBeenCalled()
    })

    it.each(PROVIDER_KINDS)('%s mints the same stable id for the same idempotency key', (kind) => {
        // A retry must reuse the id already on the wire, or the reply threads against a
        // message id we never sent.
        expect(createStableOutreachMessageId(ORGANIZATION_ID, INPUT.idempotencyKey, 'seller@example.com')).toBe(STABLE_MESSAGE_ID)
        expect(kind).toBeTruthy()
    })
})

// ---------------------------------------------------------------------------
// Inbound parity
// ---------------------------------------------------------------------------

interface InboundFixture {
    kind: ProviderKind
    providerName: 'smtp' | 'native' | 'outlook'
    reply: NormalizedInboundMessage
    bounce: NormalizedInboundMessage
}

function inboundFixture(kind: ProviderKind): InboundFixture {
    const providerName = kind
    const base: Pick<NormalizedInboundMessage, 'provider' | 'toAddresses' | 'ccAddresses' | 'attachments' | 'receivedAt'> = {
        provider: providerName,
        toAddresses: ['seller@example.com'],
        ccAddresses: [],
        attachments: [],
        receivedAt: NOW,
    }

    // Each provider hands us a different body shape: SMTP/IMAP parses text, native stores
    // both, Graph returns exactly one — html for anything composed in Outlook.
    const bodies: Record<ProviderKind, { textBody: string | null; htmlBody: string | null }> = {
        smtp: { textBody: 'Sounds good, call me tomorrow.', htmlBody: null },
        native: { textBody: 'Sounds good, call me tomorrow.', htmlBody: '<p>Sounds good, call me tomorrow.</p>' },
        outlook: { textBody: null, htmlBody: '<div><p>Sounds good, call me tomorrow.</p></div>' },
    }

    const key = {
        smtp: imapProviderMessageId({ messageId: '<inbound-1@prospect.test>', uidValidity: 12, uid: 5 }),
        native: nativeProviderMessageId('11111111-2222-4333-8444-555555555555'),
        outlook: graphProviderMessageId({ messageId: '<inbound-1@prospect.test>', graphId: 'AAMk-1' }),
    }[kind]

    return {
        kind,
        providerName,
        reply: {
            ...base,
            providerMessageId: key,
            messageId: 'inbound-1@prospect.test',
            inReplyTo: STABLE_MESSAGE_ID,
            references: STABLE_MESSAGE_ID,
            fromAddress: 'lead@prospect.test',
            subject: 'Re: Quick question',
            headers: { 'content-type': 'text/plain' },
            ...bodies[kind],
        },
        bounce: {
            ...base,
            providerMessageId: `${key}-dsn`,
            messageId: 'dsn-1@mx.prospect.test',
            // A DSN quotes the original id, which is exactly how it used to be consumed as
            // a reply before anything could suppress the address.
            inReplyTo: STABLE_MESSAGE_ID,
            references: STABLE_MESSAGE_ID,
            fromAddress: 'MAILER-DAEMON@mx.prospect.test',
            subject: 'Undeliverable: Quick question',
            headers: { 'content-type': 'multipart/report; report-type=delivery-status; boundary=x' },
            textBody: 'Your message could not be delivered. 550 5.1.1 user unknown',
            htmlBody: null,
        },
    }
}

function createFakeStore() {
    const events = new Map<string, StoredProviderEvent>()
    let cursor: ProviderCursorState | null = null
    let sequence = 0

    const store: InboundEventStore & { all: () => StoredProviderEvent[] } = {
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
                pending.processingError = message
                return { status: 'failed', event: { ...pending }, error: message }
            }

            pending.processedAt = NOW
            return { status: 'processed', event: { ...pending } }
        },
        all: () => [...events.values()],
    }
    return store
}

const EMPTY_CURSOR: ProviderCursorState = {
    deltaCursor: null,
    uidValidity: null,
    lastUid: null,
    lastReceivedAt: null,
    lastProviderMessageId: null,
}

function sourceOf(fixture: InboundFixture, messages: NormalizedInboundMessage[]): InboundSource {
    return {
        provider: fixture.providerName,
        async fetchPage() {
            return { messages, nextCursor: EMPTY_CURSOR }
        },
    }
}

describe('every provider classifies inbound mail identically', () => {
    it.each(PROVIDER_KINDS)('%s stages a reply as a reply and a DSN as a bounce', async (kind) => {
        const fixture = inboundFixture(kind)
        const store = createFakeStore()

        await ingestInboundPage({
            store,
            source: sourceOf(fixture, [fixture.reply, fixture.bounce]),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })

        expect(store.all().map((event) => event.classification)).toEqual(['reply', 'bounce'])
    })

    it.each(PROVIDER_KINDS)('%s re-delivering the same message stages one event', async (kind) => {
        const fixture = inboundFixture(kind)
        const store = createFakeStore()
        const deps = {
            store,
            source: sourceOf(fixture, [fixture.reply]),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        }

        const first = await ingestInboundPage(deps)
        const second = await ingestInboundPage(deps)

        expect(first).toMatchObject({ recorded: 1, duplicates: 0 })
        expect(second).toMatchObject({ recorded: 0, duplicates: 1 })
    })

    it.each(PROVIDER_KINDS)('%s applies a reply side effect exactly once across replays', async (kind) => {
        const fixture = inboundFixture(kind)
        const store = createFakeStore()
        await ingestInboundPage({
            store,
            source: sourceOf(fixture, [fixture.reply]),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })

        const handle = vi.fn(async () => {})
        await consumeClassifiedEvents({ store, classification: 'reply', handle })
        await consumeClassifiedEvents({ store, classification: 'reply', handle })

        // Counters live behind this handler: a second call is a double-counted reply.
        expect(handle).toHaveBeenCalledTimes(1)
    })

    it.each(PROVIDER_KINDS)('%s never lets the reply consumer see a bounce', async (kind) => {
        const fixture = inboundFixture(kind)
        const store = createFakeStore()
        await ingestInboundPage({
            store,
            source: sourceOf(fixture, [fixture.reply, fixture.bounce]),
            account: { id: ACCOUNT_ID, organizationId: ORGANIZATION_ID },
        })

        const replies = vi.fn(async () => {})
        const bounces = vi.fn(async () => {})
        await consumeClassifiedEvents({ store, classification: 'reply', handle: replies })
        await consumeClassifiedEvents({ store, classification: 'bounce', handle: bounces })

        expect(replies).toHaveBeenCalledTimes(1)
        expect(bounces).toHaveBeenCalledTimes(1)
    })

    it.each(PROVIDER_KINDS)('%s classifies a DSN as a bounce even though it quotes our id', (kind) => {
        const fixture = inboundFixture(kind)
        expect(classifyInboundMessage({
            fromAddress: fixture.bounce.fromAddress,
            subject: fixture.bounce.subject,
            headers: fixture.bounce.headers,
            inReplyTo: fixture.bounce.inReplyTo,
            references: fixture.bounce.references,
        }).classification).toBe('bounce')
    })
})

describe('reply context reaches follow-ups from every provider', () => {
    it.each(PROVIDER_KINDS)('%s produces the same reply text for the agentic decider', (kind) => {
        const fixture = inboundFixture(kind)

        // The property that matters for PROV-05: Outlook hands back HTML only, so without an
        // HTML-to-text fallback an Outlook reply would reach the follow-up decider as an
        // empty string and it would answer a conversation it cannot read.
        expect(normalizeReplyText(fixture.reply.textBody, fixture.reply.htmlBody))
            .toBe('Sounds good, call me tomorrow.')
    })

    it('bounds stored reply context regardless of provider', () => {
        const huge = 'x'.repeat(50_000)
        expect(normalizeReplyText(huge, null).length).toBeLessThanOrEqual(20_000)
        expect(normalizeReplyText(null, `<p>${huge}</p>`).length).toBeLessThanOrEqual(20_000)
    })

    it('normalizes an inbound Message-ID the same way whatever the provider bracket style', () => {
        // Matching is a LOWER() comparison against outreach_emails.message_id, so a stray
        // angle bracket from one provider is an unmatchable reply.
        expect(normalizeMessageId('<inbound-1@prospect.test>')).toBe('inbound-1@prospect.test')
        expect(normalizeMessageId('inbound-1@prospect.test')).toBe('inbound-1@prospect.test')
        expect(normalizeMessageId('  <inbound-1@prospect.test>  ')).toBe('inbound-1@prospect.test')
    })

    it('keys the same physical message stably per provider', () => {
        // Each provider's id has a different instability: IMAP UIDs renumber on a UIDVALIDITY
        // reset, Graph ids change on a folder move. Both defer to the internet Message-ID.
        expect(imapProviderMessageId({ messageId: '<m@x.test>', uidValidity: 1, uid: 1 }))
            .toBe(imapProviderMessageId({ messageId: '<m@x.test>', uidValidity: 99, uid: 42 }))
        expect(graphProviderMessageId({ messageId: '<m@x.test>', graphId: 'AAA' }))
            .toBe(graphProviderMessageId({ messageId: '<m@x.test>', graphId: 'BBB' }))
    })
})
