/**
 * Provider-neutral inbound staging for outreach (Phase 19, PROV-04).
 *
 * The problem this replaces:
 *   processReplies and processBounces both scanned the same INBOX and both used
 *   user-visible read state as their cursor. The reply job ran first, saw a DSN,
 *   matched it by In-Reply-To (a DSN quotes the original Message-ID), marked it
 *   read, and moved on. The bounce job only looked at unread mail, so it never saw
 *   the bounce: a hard bounce was recorded as a reply, the sequence stopped as
 *   "engaged", and the address was never suppressed.
 *
 * The contract here:
 *   1. Every inbound item from every provider normalizes into one shape.
 *   2. It is classified EXACTLY ONCE, in DSN -> auto-reply -> human reply -> other
 *      order, and that decision is persisted BEFORE any side effect runs.
 *   3. Reply and bounce consumers read the same durable classification, so they
 *      cannot disagree or race.
 *   4. Ingestion progress lives in outreach_provider_cursors — never in read flags,
 *      which belong to the human and are mutable from any mail client.
 *
 * Storage shape: supabase/migrations/039_outreach_provider_events.sql.
 * Phase 21 materializes conversations from these rows rather than re-polling.
 */

import type {
    OutreachProviderAttachment,
    OutreachProviderEventClassification,
    OutreachProviderName,
} from '../../db/schema'

// ============================================================
// Normalized message
// ============================================================

export interface NormalizedInboundMessage {
    provider: OutreachProviderName
    /** Stable provider-side identity; see nativeProviderMessageId/imapProviderMessageId. */
    providerMessageId: string
    /** Internet Message-ID, angle brackets stripped. */
    messageId: string | null
    inReplyTo: string | null
    references: string | null
    fromAddress: string | null
    toAddresses: string[]
    ccAddresses: string[]
    subject: string | null
    textBody: string | null
    htmlBody: string | null
    headers: Record<string, string>
    attachments: OutreachProviderAttachment[]
    receivedAt: Date
}

export type InboundClassification = OutreachProviderEventClassification

export type InboundClassificationSignal =
    | 'dsn_report'
    | 'bounce_sender'
    | 'bounce_subject'
    | 'auto_submitted'
    | 'precedence'
    | 'x_auto_response'
    | 'subject_ooo'
    | 'in_reply_to'
    | 'references'
    | 'known_correspondent'
    | 'none'

export interface ClassificationInput {
    fromAddress: string | null
    subject: string | null
    headers: Record<string, string>
    inReplyTo: string | null
    references: string | null
    /**
     * True when the sender is a lead this account emailed recently. Resolved by the
     * caller (one bounded lookup), because it preserves the tier-3 from-address
     * matcher in matchReplyToOutreach for clients that strip In-Reply-To. Without it
     * such replies would stage as 'other' and the reply consumer would never see them.
     */
    hasKnownCorrespondent?: boolean
}

// Kept identical to the historical detectors in processBounces.ts/processReplies.ts so
// this refactor changes WHEN classification happens, not WHAT counts as a bounce.
const BOUNCE_SENDERS = ['mailer-daemon', 'postmaster', 'bounce@', 'bounces@']

const BOUNCE_SUBJECTS = [
    'undeliverable',
    'returned mail',
    'returned message',
    'delivery failure',
    'delivery status',
    'delivery report',
    'mail delivery failed',
    'message bounced',
    'unable to deliver',
]

const OOO_SUBJECT_RE = /^(re:\s*)?(out of office|auto[- ]?reply|automatic reply|on vacation|out of the office|fora do escrit[oó]rio|aus[eê]ncia|ausente|fuera de la oficina)/i

function headerValue(headers: Record<string, string>, name: string): string {
    return (headers[name] ?? headers[name.toLowerCase()] ?? '').trim().toLowerCase()
}

/** RFC 3464 delivery-status reports are the unambiguous machine-readable bounce signal. */
function isDeliveryStatusReport(headers: Record<string, string>): boolean {
    const contentType = headerValue(headers, 'content-type')
    return contentType.includes('multipart/report') && contentType.includes('delivery-status')
}

/**
 * One classifier, one order: DSN/bounce -> auto-reply -> human reply -> other.
 *
 * The order is the whole point. A DSN legitimately carries In-Reply-To and often an
 * "Automatic reply"-shaped subject, so testing for replies or auto-replies first
 * misroutes real bounces.
 */
export function classifyInboundMessage(input: ClassificationInput): {
    classification: InboundClassification
    signal: InboundClassificationSignal
} {
    const from = (input.fromAddress ?? '').toLowerCase()
    const subject = (input.subject ?? '').trim()
    const subjectLower = subject.toLowerCase()

    // 1. Bounce / DSN.
    if (isDeliveryStatusReport(input.headers)) {
        return { classification: 'bounce', signal: 'dsn_report' }
    }
    if (BOUNCE_SENDERS.some((sender) => from.includes(sender))) {
        return { classification: 'bounce', signal: 'bounce_sender' }
    }
    if (BOUNCE_SUBJECTS.some((candidate) => subjectLower.includes(candidate))) {
        return { classification: 'bounce', signal: 'bounce_subject' }
    }

    // 2. Auto-reply.
    const autoSubmitted = headerValue(input.headers, 'auto-submitted')
    if (autoSubmitted === 'auto-replied' || autoSubmitted === 'auto-generated') {
        return { classification: 'auto_reply', signal: 'auto_submitted' }
    }
    const precedence = headerValue(input.headers, 'precedence')
    if (precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'junk') {
        return { classification: 'auto_reply', signal: 'precedence' }
    }
    if (headerValue(input.headers, 'x-auto-response-suppress') === 'all') {
        return { classification: 'auto_reply', signal: 'x_auto_response' }
    }
    if (subject && OOO_SUBJECT_RE.test(subject)) {
        return { classification: 'auto_reply', signal: 'subject_ooo' }
    }

    // 3. Human reply.
    if (input.inReplyTo && input.inReplyTo.trim()) {
        return { classification: 'reply', signal: 'in_reply_to' }
    }
    if (input.references && input.references.trim()) {
        return { classification: 'reply', signal: 'references' }
    }
    if (input.hasKnownCorrespondent) {
        return { classification: 'reply', signal: 'known_correspondent' }
    }

    // 4. Everything else is preserved, not dropped — Phase 21 turns these into
    //    conversation messages.
    return { classification: 'other', signal: 'none' }
}

// ============================================================
// Page bounds
// ============================================================

export const DEFAULT_INBOUND_PAGE_SIZE = 200
export const MAX_INBOUND_PAGE_SIZE = 500

/** Clamps to [1, MAX]. A provider that ignores the request is still capped at ingest. */
export function resolveInboundPageSize(requested?: number): number {
    if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_INBOUND_PAGE_SIZE
    return Math.min(MAX_INBOUND_PAGE_SIZE, Math.max(1, Math.floor(requested)))
}

// ============================================================
// Cursors
// ============================================================

export interface ProviderCursorState {
    /** Outlook: opaque Graph @odata.deltaLink. */
    deltaCursor: string | null
    /** IMAP: UIDVALIDITY that lastUid is meaningful under. */
    uidValidity: number | null
    lastUid: number | null
    /** Native: received-at plus an id tie breaker for equal timestamps. */
    lastReceivedAt: Date | null
    lastProviderMessageId: string | null
}

/**
 * IMAP UIDs are only meaningful under the UIDVALIDITY they were issued with. If the
 * server renumbers, resuming from the stored high-water mark would skip mail that was
 * never actually read. Reset instead — re-ingesting is cheap and deduplicated;
 * skipping a bounce is not recoverable.
 */
export function resolveImapCursor(
    stored: ProviderCursorState | null,
    mailboxUidValidity: number,
): { startUid: number; reset: boolean; uidValidity: number } {
    if (!stored || stored.uidValidity === null) {
        // A high-water mark with no UIDVALIDITY cannot be interpreted; treat as a reset
        // whenever one was stored, so the operator-visible signal is accurate.
        const reset = Boolean(stored && stored.lastUid !== null)
        return { startUid: 0, reset, uidValidity: mailboxUidValidity }
    }
    if (stored.uidValidity !== mailboxUidValidity) {
        return { startUid: 0, reset: true, uidValidity: mailboxUidValidity }
    }
    return { startUid: stored.lastUid ?? 0, reset: false, uidValidity: mailboxUidValidity }
}

// ============================================================
// Provider message keys
// ============================================================

export function normalizeMessageId(messageId: string | null | undefined): string | null {
    const normalized = messageId?.replace(/[<>]/g, '').trim()
    return normalized ? normalized.slice(0, 500) : null
}

/** Native rows have a durable primary key; nothing renumbers it. */
export function nativeProviderMessageId(rowId: string): string {
    return rowId
}

/**
 * Prefers the internet Message-ID because `uid:<validity>:<uid>` is NOT stable across
 * a UIDVALIDITY reset: the same physical message reappears under a new UID and would
 * re-ingest as a new event, duplicating side effects on exactly the mail we just
 * resynced. Message-ID survives renumbering.
 *
 * Fallback: mail with no Message-ID (rare, malformed) keys on uid coordinates and can
 * therefore re-ingest once after a reset. Accepted — the alternative is dropping it.
 */
export function imapProviderMessageId(input: {
    messageId: string | null
    uidValidity: number
    uid: number
}): string {
    const messageId = normalizeMessageId(input.messageId)
    return messageId ? `mid:${messageId}` : `uid:${input.uidValidity}:${input.uid}`
}

// ============================================================
// Ports
// ============================================================

export interface RecordEventInput {
    organizationId: string
    emailAccountId: string
    provider: OutreachProviderName
    providerMessageId: string
    messageId: string | null
    inReplyTo: string | null
    messageReferences: string | null
    classification: InboundClassification
    fromAddress: string | null
    toAddresses: string[]
    ccAddresses: string[]
    subject: string | null
    textBody: string | null
    htmlBody: string | null
    headers: Record<string, string>
    attachments: OutreachProviderAttachment[]
    receivedAt: Date
}

export interface StoredProviderEvent {
    id: string
    organizationId: string
    emailAccountId: string
    provider: OutreachProviderName
    providerMessageId: string
    messageId: string | null
    inReplyTo: string | null
    messageReferences: string | null
    classification: InboundClassification
    fromAddress: string | null
    subject: string | null
    textBody: string | null
    htmlBody: string | null
    receivedAt: Date
    processedAt: Date | null
    processingError: string | null
}

/**
 * Note what is absent: there is no read-flag surface. The cursor is the only progress
 * signal by construction, so no future change can quietly reintroduce isRead/\Seen as
 * an ingestion cursor.
 */
export interface InboundEventStore {
    recordEvent(input: RecordEventInput): Promise<{ inserted: boolean }>
    loadCursor(emailAccountId: string, provider: OutreachProviderName): Promise<ProviderCursorState | null>
    saveCursor(
        emailAccountId: string,
        provider: OutreachProviderName,
        next: ProviderCursorState,
    ): Promise<void>
    /** Atomically claims unprocessed events of one classification. */
    claimPending(classification: InboundClassification, limit: number): Promise<StoredProviderEvent[]>
    recordProcessingError(eventId: string, error: string): Promise<void>
}

export interface InboundSource {
    provider: OutreachProviderName
    fetchPage(
        cursor: ProviderCursorState | null,
        pageSize: number,
    ): Promise<{ messages: NormalizedInboundMessage[]; nextCursor: ProviderCursorState }>
}

export interface IngestResult {
    scanned: number
    recorded: number
    duplicates: number
    classifications: Record<InboundClassification, number>
}

// ============================================================
// Ingestion
// ============================================================

export async function ingestInboundPage(deps: {
    store: InboundEventStore
    source: InboundSource
    account: { id: string; organizationId: string }
    pageSize?: number
    /** Resolves the tier-3 from-address fallback; omitted means "no known correspondent". */
    isKnownCorrespondent?: (fromAddress: string) => Promise<boolean>
}): Promise<IngestResult> {
    const pageSize = resolveInboundPageSize(deps.pageSize)
    const cursor = await deps.store.loadCursor(deps.account.id, deps.source.provider)
    const page = await deps.source.fetchPage(cursor, pageSize)

    // Cap here too: a provider that ignores the requested page size must not be able
    // to turn one tick into an unbounded scan.
    const messages = page.messages.slice(0, pageSize)

    const result: IngestResult = {
        scanned: messages.length,
        recorded: 0,
        duplicates: 0,
        classifications: { reply: 0, bounce: 0, auto_reply: 0, other: 0 },
    }

    for (const message of messages) {
        let hasKnownCorrespondent = false
        // Only consulted when cheaper signals are absent, so the extra lookup does not
        // run for the common threaded-reply/DSN cases.
        if (deps.isKnownCorrespondent && message.fromAddress && !message.inReplyTo && !message.references) {
            hasKnownCorrespondent = await deps.isKnownCorrespondent(message.fromAddress)
        }

        const { classification } = classifyInboundMessage({
            fromAddress: message.fromAddress,
            subject: message.subject,
            headers: message.headers,
            inReplyTo: message.inReplyTo,
            references: message.references,
            hasKnownCorrespondent,
        })

        const { inserted } = await deps.store.recordEvent({
            organizationId: deps.account.organizationId,
            emailAccountId: deps.account.id,
            provider: message.provider,
            providerMessageId: message.providerMessageId,
            messageId: normalizeMessageId(message.messageId),
            inReplyTo: message.inReplyTo,
            messageReferences: message.references,
            classification,
            fromAddress: message.fromAddress,
            toAddresses: message.toAddresses,
            ccAddresses: message.ccAddresses,
            subject: message.subject,
            textBody: message.textBody,
            htmlBody: message.htmlBody,
            headers: message.headers,
            attachments: message.attachments,
            receivedAt: message.receivedAt,
        })

        if (inserted) result.recorded++
        else result.duplicates++
        result.classifications[classification]++
    }

    // Only after every message in the page is durably staged. If recordEvent throws we
    // never get here, so the page is re-fetched next tick and deduplicated — losing a
    // page is recoverable, advancing past one is not.
    await deps.store.saveCursor(deps.account.id, deps.source.provider, page.nextCursor)

    return result
}

// ============================================================
// Consumption
// ============================================================

export const DEFAULT_CLAIM_LIMIT = 200

export async function consumeClassifiedEvents(deps: {
    store: InboundEventStore
    classification: InboundClassification
    limit?: number
    handle: (event: StoredProviderEvent) => Promise<void>
}): Promise<{ claimed: number; processed: number; failed: number }> {
    const limit = resolveInboundPageSize(deps.limit ?? DEFAULT_CLAIM_LIMIT)
    const events = await deps.store.claimPending(deps.classification, limit)

    let processed = 0
    let failed = 0

    for (const event of events) {
        try {
            await deps.handle(event)
            processed++
        } catch (error) {
            failed++
            const message = error instanceof Error ? error.message : String(error)
            // The claim already marked the event processed, so a failure is recorded on
            // the row rather than retried forever. Operators find these with
            // `processing_error IS NOT NULL`; a poison message cannot stall the queue.
            await deps.store.recordProcessingError(event.id, message.slice(0, 1000))
        }
    }

    return { claimed: events.length, processed, failed }
}

// ============================================================
// SQL store
// ============================================================

export interface InboundSqlClient {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
}

function rows<T>(result: unknown): T[] {
    return Array.isArray(result) ? result as T[] : []
}

interface CursorRow {
    delta_cursor: string | null
    uid_validity: string | number | null
    last_uid: string | number | null
    last_received_at: Date | null
    last_provider_message_id: string | null
}

function toNumber(value: string | number | null): number | null {
    if (value === null) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

export function createSqlInboundEventStore(
    getClient: () => Promise<InboundSqlClient>,
): InboundEventStore {
    return {
        async recordEvent(input) {
            const sql = await getClient()
            // ON CONFLICT against the migration-039 unique key is what makes ingestion
            // idempotent: a re-fetched page, a retried tick, and a UIDVALIDITY resync
            // all converge on one row and therefore one side effect.
            const inserted = await sql`
                INSERT INTO outreach_provider_events (
                    organization_id, email_account_id, provider, provider_message_id,
                    message_id, in_reply_to, message_references, classification,
                    from_address, to_addresses, cc_addresses, subject,
                    text_body, html_body, headers, attachments, received_at
                ) VALUES (
                    ${input.organizationId}, ${input.emailAccountId}, ${input.provider},
                    ${input.providerMessageId}, ${input.messageId}, ${input.inReplyTo},
                    ${input.messageReferences}, ${input.classification}, ${input.fromAddress},
                    ${JSON.stringify(input.toAddresses)}::jsonb,
                    ${JSON.stringify(input.ccAddresses)}::jsonb,
                    ${input.subject}, ${input.textBody}, ${input.htmlBody},
                    ${JSON.stringify(input.headers)}::jsonb,
                    ${JSON.stringify(input.attachments)}::jsonb,
                    ${input.receivedAt}
                )
                ON CONFLICT (organization_id, email_account_id, provider, provider_message_id)
                DO NOTHING
                RETURNING id
            `
            return { inserted: rows(inserted).length > 0 }
        },

        async loadCursor(emailAccountId, provider) {
            const sql = await getClient()
            const result = await sql`
                SELECT delta_cursor, uid_validity, last_uid, last_received_at, last_provider_message_id
                FROM outreach_provider_cursors
                WHERE email_account_id = ${emailAccountId} AND provider = ${provider}
                LIMIT 1
            `
            const row = rows<CursorRow>(result)[0]
            if (!row) return null
            return {
                deltaCursor: row.delta_cursor,
                uidValidity: toNumber(row.uid_validity),
                lastUid: toNumber(row.last_uid),
                lastReceivedAt: row.last_received_at,
                lastProviderMessageId: row.last_provider_message_id,
            }
        },

        async saveCursor(emailAccountId, provider, next) {
            const sql = await getClient()
            await sql`
                INSERT INTO outreach_provider_cursors (
                    organization_id, email_account_id, provider, delta_cursor,
                    uid_validity, last_uid, last_received_at, last_provider_message_id,
                    last_success_at, last_error, last_error_at, retry_at, updated_at
                )
                SELECT organization_id, id, ${provider}, ${next.deltaCursor},
                       ${next.uidValidity}, ${next.lastUid}, ${next.lastReceivedAt},
                       ${next.lastProviderMessageId}, now(), NULL, NULL, NULL, now()
                FROM email_accounts
                WHERE id = ${emailAccountId}
                ON CONFLICT (organization_id, email_account_id, provider)
                DO UPDATE SET
                    delta_cursor = EXCLUDED.delta_cursor,
                    uid_validity = EXCLUDED.uid_validity,
                    last_uid = EXCLUDED.last_uid,
                    last_received_at = EXCLUDED.last_received_at,
                    last_provider_message_id = EXCLUDED.last_provider_message_id,
                    last_success_at = now(),
                    last_error = NULL,
                    last_error_at = NULL,
                    retry_at = NULL,
                    updated_at = now()
            `
        },

        async claimPending(classification, limit) {
            const sql = await getClient()
            // FOR UPDATE SKIP LOCKED + setting processed_at in the same statement is the
            // claim. Two workers cannot hand the same event to their side effects, and a
            // reply consumer can never claim a row classified as a bounce.
            const result = await sql`
                UPDATE outreach_provider_events AS event
                SET processed_at = now(), updated_at = now()
                WHERE event.id IN (
                    SELECT candidate.id
                    FROM outreach_provider_events AS candidate
                    WHERE candidate.classification = ${classification}
                      AND candidate.processed_at IS NULL
                    ORDER BY candidate.received_at ASC
                    LIMIT ${limit}
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING event.id, event.organization_id, event.email_account_id, event.provider,
                          event.provider_message_id, event.message_id, event.in_reply_to,
                          event.message_references, event.classification, event.from_address,
                          event.subject, event.text_body, event.html_body, event.received_at,
                          event.processed_at, event.processing_error
            `
            return rows<Record<string, never>>(result).map((row) => {
                const record = row as unknown as Record<string, unknown>
                return {
                    id: String(record.id),
                    organizationId: String(record.organization_id),
                    emailAccountId: String(record.email_account_id),
                    provider: record.provider as OutreachProviderName,
                    providerMessageId: String(record.provider_message_id),
                    messageId: (record.message_id as string | null) ?? null,
                    inReplyTo: (record.in_reply_to as string | null) ?? null,
                    messageReferences: (record.message_references as string | null) ?? null,
                    classification: record.classification as InboundClassification,
                    fromAddress: (record.from_address as string | null) ?? null,
                    subject: (record.subject as string | null) ?? null,
                    textBody: (record.text_body as string | null) ?? null,
                    htmlBody: (record.html_body as string | null) ?? null,
                    receivedAt: record.received_at as Date,
                    processedAt: (record.processed_at as Date | null) ?? null,
                    processingError: (record.processing_error as string | null) ?? null,
                }
            })
        },

        async recordProcessingError(eventId, error) {
            const sql = await getClient()
            await sql`
                UPDATE outreach_provider_events
                SET processing_error = ${error}, updated_at = now()
                WHERE id = ${eventId}
            `
        },
    }
}

/** Lazy db import keeps this module unit-testable without a live connection. */
export function createDrizzleInboundEventStore(): InboundEventStore {
    return createSqlInboundEventStore(async () => {
        const { queryClient } = await import('../../db')
        return queryClient as unknown as InboundSqlClient
    })
}
