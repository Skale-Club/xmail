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
 *   5. An event is marked processed only once its side effect has actually happened.
 *      Consumption is at-least-once, never at-most-once: re-applying a bounce is
 *      idempotent, losing one is not.
 *
 * Storage shape: supabase/migrations/039_outreach_provider_events.sql.
 * Phase 21 materializes conversations from these rows rather than re-polling.
 */

import type {
    OutreachProviderAttachment,
    OutreachProviderEventClassification,
    OutreachProviderName,
} from '../../db/schema'
import { sqlTimestampValue } from './sql-timestamp'

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

/**
 * Same reasoning as the IMAP key, different instability: a Graph message id is scoped to the
 * mailbox AND to the folder, so moving a message (a rule firing, an operator filing it) mints
 * a new id for the same physical mail. Keying on the id would re-ingest it as a new event and
 * duplicate the side effect. The internet Message-ID survives the move.
 *
 * Fallback: mail with no Message-ID keys on the Graph id and can therefore re-ingest once
 * after a move. Accepted — the alternative is dropping it.
 */
export function graphProviderMessageId(input: {
    messageId: string | null
    graphId: string
}): string {
    const messageId = normalizeMessageId(input.messageId)
    return messageId ? `mid:${messageId}` : `graph:${input.graphId}`
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

/** Outcome of one lease attempt. `idle` means there was nothing left to claim. */
export type ClaimOutcome =
    | { status: 'idle' }
    | { status: 'processed'; event: StoredProviderEvent }
    | { status: 'failed'; event: StoredProviderEvent; error: string }

/**
 * Note what is absent: there is no read-flag surface. The cursor is the only progress
 * signal by construction, so no future change can quietly reintroduce isRead/\Seen as
 * an ingestion cursor.
 *
 * Note also what is absent since C-2: there is no operation that marks an event processed
 * on its own. `processed_at` can only be written by withNextPendingEvent, after the side
 * effect it describes has actually happened — so no future caller can reintroduce the
 * claim-then-lose ordering.
 */
export interface InboundEventStore {
    recordEvent(input: RecordEventInput): Promise<{ inserted: boolean }>
    loadCursor(emailAccountId: string, provider: OutreachProviderName): Promise<ProviderCursorState | null>
    saveCursor(
        emailAccountId: string,
        provider: OutreachProviderName,
        next: ProviderCursorState,
    ): Promise<void>
    /**
     * Leases the oldest pending event of one classification, runs `handle` while holding
     * the lease, and only then marks it processed. The lease and the `processed_at` write
     * are the same transaction, so the event is either fully applied or still pending —
     * never silently consumed.
     */
    withNextPendingEvent(
        classification: InboundClassification,
        handle: (event: StoredProviderEvent) => Promise<void>,
    ): Promise<ClaimOutcome>
    /**
     * Records a provider-stated backoff against the cursor row without touching the cursor
     * value itself. Optional so a store predating throttling still satisfies the port.
     */
    recordCursorRetry?(
        emailAccountId: string,
        provider: OutreachProviderName,
        input: { error: string; retryAt: Date | null },
    ): Promise<void>
}

export interface InboundSourcePage {
    messages: NormalizedInboundMessage[]
    nextCursor: ProviderCursorState
    /**
     * Cursor that is safe to persist once the message at `index` has been durably staged.
     * Optional because not every provider can express one (a Graph delta token is scoped
     * to the whole page). When present, ingestion checkpoints progress mid-page and, on a
     * failure, resumes from the last staged message instead of re-fetching the entire
     * page — the 2026-08 egress incident was one page being re-transmitted, bodies and
     * all, on every tick for a month because the cursor only ever advanced page-at-a-time.
     */
    getMessageCursor?: (index: number) => ProviderCursorState | null
    /**
     * Messages the source skipped because they are already staged (counted into
     * `duplicates`). Lets a source avoid transferring bodies for mail that ingestion
     * would only bounce off the unique key anyway.
     */
    alreadyStaged?: number
    /**
     * Set when the provider asked us to back off (Graph 429 Retry-After). Reported rather
     * than thrown, so the work already done this page is still staged.
     */
    retryAfter?: Date | null
    /**
     * How many provider pages were actually read. Zero means the source returned without
     * reading anything — a throttle or an outage — which is indistinguishable from "the
     * mailbox is empty" unless the source says so. The activation gate needs the
     * difference: "did not throw" is not evidence that a read succeeded (W-1).
     */
    pagesFetched?: number
}

export interface InboundSource {
    provider: OutreachProviderName
    fetchPage(
        cursor: ProviderCursorState | null,
        pageSize: number,
    ): Promise<InboundSourcePage>
}

export interface IngestResult {
    scanned: number
    recorded: number
    duplicates: number
    classifications: Record<InboundClassification, number>
    /** Provider-stated backoff, echoed for the caller's logs/metrics. */
    retryAfter?: Date | null
    /** Provider pages actually read; 0 means nothing was read. See InboundSourcePage. */
    pagesFetched?: number
}

// ============================================================
// Ingestion
// ============================================================

/**
 * How often ingestion persists the per-message cursor mid-page. Small enough that a
 * crash re-stages at most this many already-deduplicated messages; large enough that a
 * full page is not one cursor write per row.
 */
export const CURSOR_CHECKPOINT_INTERVAL = 25

/**
 * Backoff persisted when ingestion of an account throws. Must exceed the shortest
 * caller cadence (replies run every 15 minutes) or the failed account is retried at
 * full weight on the very next tick anyway.
 */
export const INGEST_FAILURE_BACKOFF_MINUTES = 30

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
        // Messages the source pre-filtered as already staged never reach recordEvent,
        // but they are still duplicates from the caller's point of view.
        duplicates: page.alreadyStaged ?? 0,
        classifications: { reply: 0, bounce: 0, auto_reply: 0, other: 0 },
        // Sources that do not report it read exactly one page by construction (native and
        // IMAP both query directly and throw on failure), so absence means one.
        pagesFetched: page.pagesFetched ?? 1,
    }

    // The last per-message cursor whose message is durably staged. Persisted mid-page as
    // a checkpoint and, crucially, on failure: a message whose recordEvent always throws
    // must cost re-reading only itself, never the messages staged before it. Without
    // this, one poisonous message re-transmitted the whole page — bodies included — on
    // every tick of both calling jobs (the 2026-08 Supabase egress overrun).
    let lastStagedCursor: ProviderCursorState | null = null

    try {
        for (const [index, message] of messages.entries()) {
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

            const messageCursor = page.getMessageCursor?.(index) ?? null
            if (messageCursor) {
                lastStagedCursor = messageCursor
                if ((index + 1) % CURSOR_CHECKPOINT_INTERVAL === 0) {
                    await deps.store.saveCursor(deps.account.id, deps.source.provider, messageCursor)
                }
            }
        }
    } catch (error) {
        // Everything before the failing message is durably staged, so advancing to it is
        // safe. The failing message itself stays ahead of the cursor and is re-fetched
        // next tick. The caller records the backoff (recordCursorRetry) AFTER this save,
        // because saveCursor clears the retry bookkeeping.
        if (lastStagedCursor) {
            await deps.store.saveCursor(deps.account.id, deps.source.provider, lastStagedCursor)
        }
        throw error
    }

    // Only after every message in the page is durably staged. If recordEvent throws we
    // never get here, so the unstaged tail is re-fetched next tick and deduplicated —
    // losing part of a page is recoverable, advancing past one is not.
    await deps.store.saveCursor(deps.account.id, deps.source.provider, page.nextCursor)

    // After the cursor, never before: saveCursor clears the row's error/retry bookkeeping on
    // success, so recording the backoff first would immediately erase it.
    if (page.retryAfter) {
        result.retryAfter = page.retryAfter
        await deps.store.recordCursorRetry?.(deps.account.id, deps.source.provider, {
            error: 'provider_throttled',
            retryAt: page.retryAfter,
        })
    }

    return result
}

// ============================================================
// Consumption
// ============================================================

export const DEFAULT_CLAIM_LIMIT = 200

/**
 * Drains up to `limit` events of one classification, one lease at a time.
 *
 * One at a time rather than one batch: the lease has to be held across the side effect
 * for the side effect to be recoverable, and a batch-wide lease held across 200 side
 * effects would be one long transaction whose failure re-runs all 200. Per event, a crash
 * costs at most the single event in flight, which is re-applied on a later tick.
 */
export async function consumeClassifiedEvents(deps: {
    store: InboundEventStore
    classification: InboundClassification
    limit?: number
    handle: (event: StoredProviderEvent) => Promise<void>
}): Promise<{ claimed: number; processed: number; failed: number }> {
    const limit = resolveInboundPageSize(deps.limit ?? DEFAULT_CLAIM_LIMIT)

    let claimed = 0
    let processed = 0
    let failed = 0

    for (let attempt = 0; attempt < limit; attempt++) {
        const outcome = await deps.store.withNextPendingEvent(deps.classification, deps.handle)
        if (outcome.status === 'idle') break

        claimed++
        if (outcome.status === 'processed') processed++
        else failed++
    }

    return { claimed, processed, failed }
}

// ============================================================
// SQL store
// ============================================================

export interface InboundSqlClient {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
    /** Runs `fn` in a transaction, rolling back if it throws. */
    begin<T>(fn: (tx: InboundSqlClient) => Promise<T>): Promise<T>
}

/**
 * How long a failed event waits before another tick retries it.
 *
 * Without it, a permanently poisonous event (one whose handler always throws) would be
 * re-claimed every tick forever and, being the oldest, would sit at the front of every
 * batch. With it, such an event costs one attempt per window and never crowds out newer
 * mail. Failures are still visible via `processing_error IS NOT NULL`.
 *
 * Retrying forever is the deliberate choice over dead-lettering: this queue carries
 * bounces, and 039's rationale is that skipping one is unrecoverable while re-reading is
 * merely cheap.
 */
export const PROCESSING_RETRY_BACKOFF_MINUTES = 15

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
                    -- ::text::jsonb, não ::jsonb direto: com o cast direto o pooler infere o
                    -- parâmetro como jsonb e o codifica uma segunda vez (o valor já vem de
                    -- JSON.stringify), gravando uma STRING JSON. O cast intermediário mantém o
                    -- parâmetro escalar e deixa o PostgreSQL fazer o único parse. Ver lib/jsonb.ts.
                    ${JSON.stringify(input.toAddresses)}::text::jsonb,
                    ${JSON.stringify(input.ccAddresses)}::text::jsonb,
                    ${input.subject}, ${input.textBody}, ${input.htmlBody},
                    ${JSON.stringify(input.headers)}::text::jsonb,
                    ${JSON.stringify(input.attachments)}::text::jsonb,
                    ${sqlTimestampValue(input.receivedAt)}
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
                       ${next.uidValidity}, ${next.lastUid}, ${sqlTimestampValue(next.lastReceivedAt)},
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

        async withNextPendingEvent(classification, handle) {
            const sql = await getClient()

            // The transaction IS the lease, and that is the whole point: a lease held in
            // columns needs a reaper, a clock, and an expiry guess, and still leaves the
            // window this bug lived in. A row lock is released by Postgres the instant the
            // connection dies, which is exactly the failure mode here (the rollout SIGKILLs
            // the container), and it cannot be leaked, skewed, or forgotten.
            return sql.begin(async (tx) => {
                const claimed = rows<Record<string, unknown>>(await tx`
                    SELECT id, organization_id, email_account_id, provider, provider_message_id,
                           message_id, in_reply_to, message_references, classification,
                           from_address, subject, text_body, html_body, received_at,
                           processed_at, processing_error
                    FROM outreach_provider_events
                    WHERE classification = ${classification}
                      AND processed_at IS NULL
                      -- A previously failed event waits out its backoff. Without this it
                      -- would be re-claimed every tick and, being oldest, would head every
                      -- batch forever.
                      AND (
                          processing_error IS NULL
                          OR updated_at <= now() - (${PROCESSING_RETRY_BACKOFF_MINUTES} * interval '1 minute')
                      )
                    ORDER BY received_at ASC
                    -- SKIP LOCKED preserves the original guarantee: a second worker steps
                    -- over a leased row rather than duplicating its side effect. The
                    -- classification predicate preserves the other one: a reply consumer
                    -- can never see a bounce-classified row.
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                `)

                const record = claimed[0]
                if (!record) return { status: 'idle' } as ClaimOutcome

                const event: StoredProviderEvent = {
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

                try {
                    await handle(event)
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    // Committed, not rolled back: the row must stay pending (processed_at
                    // untouched) AND carry its error. Rolling back would lose the error and
                    // re-run the handler immediately; the old code's mistake in the other
                    // direction was keeping the error and losing the retry.
                    await tx`
                        UPDATE outreach_provider_events
                        SET processing_error = ${message.slice(0, 1000)}, updated_at = now()
                        WHERE id = ${event.id}
                    `
                    return { status: 'failed', event, error: message } as ClaimOutcome
                }

                // Only here. Everything before this point is undone by a crash, which is
                // what makes the event recoverable rather than silently consumed.
                await tx`
                    UPDATE outreach_provider_events
                    SET processed_at = now(), processing_error = NULL, updated_at = now()
                    WHERE id = ${event.id}
                `

                return { status: 'processed', event } as ClaimOutcome
            })
        },

        async recordCursorRetry(emailAccountId, provider, input) {
            const sql = await getClient()
            // Deliberately does not touch delta_cursor/uid/received-at columns: a backoff is
            // bookkeeping about the last attempt, not a change of position.
            //
            // Upsert, not UPDATE: an account that fails before its FIRST successful page has
            // no cursor row, and a plain UPDATE was a silent no-op — so the backoff was never
            // persisted, loadIngestableAccounts kept selecting the account, and every tick
            // re-fetched the same full page (the 2026-08 egress overrun). The org id comes
            // from email_accounts, mirroring saveCursor.
            await sql`
                INSERT INTO outreach_provider_cursors (
                    organization_id, email_account_id, provider,
                    last_error, last_error_at, retry_at, updated_at
                )
                SELECT organization_id, id, ${provider},
                       ${input.error}, now(), ${sqlTimestampValue(input.retryAt)}, now()
                FROM email_accounts
                WHERE id = ${emailAccountId}
                ON CONFLICT (organization_id, email_account_id, provider)
                DO UPDATE SET
                    last_error = EXCLUDED.last_error,
                    last_error_at = now(),
                    retry_at = EXCLUDED.retry_at,
                    updated_at = now()
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
