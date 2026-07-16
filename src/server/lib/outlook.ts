import crypto from 'crypto'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../db'
import { outlookMailboxes, type OutlookMailbox } from '../../db/schema'
import { decryptSecret, encryptSecret } from './crypto'

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
const OAUTH_BASE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const STATE_TTL_MS = 10 * 60 * 1000
const REFRESH_SKEW_MS = 2 * 60 * 1000

/**
 * Graph rejects a MIME `sendMail` body over 4 MB. Catching it here turns a wasted
 * round-trip and an opaque Graph error into a local terminal classification.
 */
const GRAPH_MIME_MAX_BYTES = 4 * 1024 * 1024

/**
 * A Graph HTTP failure carrying its status code, so `normalizeProviderFailure`
 * (outreach-dispatch.ts) can classify 429/5xx as transient-retryable and 4xx as
 * terminal without string-matching the message.
 */
export class OutlookGraphError extends Error {
    readonly statusCode: number
    readonly requestId?: string
    /** Provider-stated backoff (Retry-After), when it sent one. */
    readonly retryAfter?: Date | null

    constructor(message: string, statusCode: number, requestId?: string, retryAfter?: Date | null) {
        super(message)
        this.name = 'OutlookGraphError'
        this.statusCode = statusCode
        this.requestId = requestId
        this.retryAfter = retryAfter ?? null
    }
}

// ---------------------------------------------------------------------------
// Inbox delta reading (PROV-02 / PROV-04)
// ---------------------------------------------------------------------------

export const GRAPH_DELTA_INBOX_PATH = '/me/mailFolders/inbox/messages/delta'

/**
 * In-Reply-To and References have no first-class field on a Graph message — they exist
 * only inside internetMessageHeaders. Without them every Graph reply looks unthreaded and
 * the shared classifier stages it as 'other', which is how an Outlook mailbox would keep
 * "receiving" replies that never reach a campaign.
 */
export const GRAPH_DELTA_SELECT = [
    'id',
    'internetMessageId',
    'internetMessageHeaders',
    'from',
    'toRecipients',
    'ccRecipients',
    'subject',
    'body',
    'bodyPreview',
    'receivedDateTime',
    'hasAttachments',
    'isDraft',
].join(',')

/** Per-run budgets. Every one of them is checked at a page boundary, never mid-page. */
export const GRAPH_DELTA_MAX_PAGES = 10
export const GRAPH_DELTA_PAGE_TOP = 50
export const GRAPH_DELTA_TIME_BUDGET_MS = 20_000
export const GRAPH_DELTA_MAX_ATTACHMENT_LOOKUPS = 50
/** How far back a *fresh* chain is willing to look. Resumed chains are unbounded by design. */
export const GRAPH_DELTA_LOOKBACK_DAYS = 7

/**
 * Marks a cursor that belongs to a chain still doing its first pass over the mailbox.
 *
 * Why this exists: "is this a fresh chain?" cannot be inferred from `cursor === null`. A
 * fresh chain paused at a nextLink resumes with a non-null cursor, and if the lookback were
 * dropped at that point, page 2 of a first-ever sync would ingest the mailbox's entire
 * history. It also cannot be inferred from the link shape — a paused *resumed* chain carries
 * a $skiptoken too. So the reader records the fact itself. The value stays opaque to every
 * other reader of the column.
 */
const FRESH_CHAIN_PREFIX = 'fresh|'

export interface OutlookGraphAttachment {
    id?: string | null
    name?: string | null
    contentType?: string | null
    size?: number | null
    isInline?: boolean | null
    contentId?: string | null
}

export interface OutlookGraphMessage {
    id: string
    internetMessageId?: string | null
    internetMessageHeaders?: Array<{ name: string; value: string }> | null
    from?: { emailAddress?: { address?: string | null; name?: string | null } | null } | null
    toRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null
    ccRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null
    subject?: string | null
    body?: { contentType?: string | null; content?: string | null } | null
    bodyPreview?: string | null
    receivedDateTime?: string | null
    hasAttachments?: boolean | null
    isDraft?: boolean | null
    /** Filled in by the reader from a separate metadata call; Graph delta cannot $expand. */
    attachments?: OutlookGraphAttachment[]
    '@removed'?: { reason?: string } | null
}

export type OutlookDeltaCursorKind = 'delta' | 'next' | 'unchanged'

export interface OutlookDeltaResult {
    messages: OutlookGraphMessage[]
    /** Opaque; persist verbatim and hand back unmodified. Null only before a first success. */
    cursor: string | null
    cursorKind: OutlookDeltaCursorKind
    /** True when Graph expired the stored delta token and the chain restarted. */
    reset: boolean
    retryAfter: Date | null
    pagesFetched: number
}

export interface OutlookDeltaInput {
    mailbox: OutlookMailbox
    cursor: string | null
    /** Hard ceiling on messages returned. The reader never exceeds it (see the defer rule). */
    maxEvents: number
    maxPages?: number
    timeBudgetMs?: number
    maxAttachmentLookups?: number
    lookbackDays?: number
    now?: () => number
}

interface DeltaPageBody {
    value?: OutlookGraphMessage[]
    '@odata.nextLink'?: string
    '@odata.deltaLink'?: string
}

function parseRetryAfter(header: string | null, nowMs: number): Date | null {
    if (!header) return null

    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(nowMs + seconds * 1000)

    // RFC 7231 also permits an HTTP-date.
    const asDate = Date.parse(header)
    return Number.isFinite(asDate) ? new Date(asDate) : null
}

/**
 * Built by hand rather than with URLSearchParams, which percent-encodes the `$` of every
 * OData parameter into `%24select`/`%24top`. Graph accepts that, but the resulting links are
 * unreadable in logs and diverge from every Graph doc and support thread.
 */
function initialDeltaUrl(top: number): string {
    return `${GRAPH_BASE_URL}${GRAPH_DELTA_INBOX_PATH}?$select=${GRAPH_DELTA_SELECT}&$top=${top}`
}

/** 429 is Graph's throttle; 503 carries the same Retry-After contract under load. */
function isThrottled(status: number): boolean {
    return status === 429 || status === 503
}

function markFresh(link: string, fresh: boolean): string {
    return fresh ? `${FRESH_CHAIN_PREFIX}${link}` : link
}

function readCursor(cursor: string | null): { link: string | null; fresh: boolean } {
    if (!cursor) return { link: null, fresh: true }
    if (cursor.startsWith(FRESH_CHAIN_PREFIX)) {
        return { link: cursor.slice(FRESH_CHAIN_PREFIX.length), fresh: true }
    }
    return { link: cursor, fresh: false }
}

/**
 * Graph signals an unusable delta token with 410 plus one of these codes. Anything else with
 * a 410 is treated the same way: a resync is the only recovery either way.
 */
function isDeltaExpired(status: number): boolean {
    return status === 410
}

/**
 * Read one bounded slice of the Outlook inbox's delta stream.
 *
 * The invariants, in the order they matter:
 *
 *  1. **A page is all-or-nothing.** Every message on a page is fully read (including its
 *     attachment metadata) before that page's link is eligible to be persisted. If anything
 *     on a page fails, the returned cursor still points *at* that page, so the next run
 *     re-reads it. Re-reading is free (the event store deduplicates); skipping is not.
 *  2. **Budgets are checked between pages.** Events, pages, wall clock, and attachment
 *     lookups each stop the chain at a page boundary and return the link to the page we did
 *     not read.
 *  3. **The reader never returns more than `maxEvents`.** ingestInboundPage truncates an
 *     oversized page but still advances the cursor, so overshooting here would silently drop
 *     mail. A page that would overshoot is deferred to the next run instead.
 *  4. **A failure never downgrades the cursor.** If no page was read, the caller's own cursor
 *     comes back unchanged.
 */
export async function fetchOutlookInboxDelta(input: OutlookDeltaInput): Promise<OutlookDeltaResult> {
    const now = input.now ?? (() => Date.now())
    const startedAt = now()
    const maxEvents = Math.max(1, input.maxEvents)
    const maxPages = input.maxPages ?? GRAPH_DELTA_MAX_PAGES
    const timeBudgetMs = input.timeBudgetMs ?? GRAPH_DELTA_TIME_BUDGET_MS
    const maxAttachmentLookups = input.maxAttachmentLookups ?? GRAPH_DELTA_MAX_ATTACHMENT_LOOKUPS
    const lookbackDays = input.lookbackDays ?? GRAPH_DELTA_LOOKBACK_DAYS
    const top = Math.min(GRAPH_DELTA_PAGE_TOP, maxEvents)

    let { accessToken, mailbox } = await getValidOutlookAccessToken(input.mailbox)
    let refreshed = false

    async function graphGet(url: string) {
        const request = (token: string) => fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(20_000),
        })

        let response = await request(accessToken)

        // Exactly one refresh per run: Graph can reject a token we still believe is valid
        // (revoked, rotated, clock skew). A second 401 is a real authorization failure and
        // must surface rather than loop.
        if (response.status === 401 && !refreshed) {
            refreshed = true
            const next = await refreshOrMarkExpired(mailbox)
            accessToken = next.accessToken
            mailbox = next.mailbox
            response = await request(accessToken)
        }

        return response
    }

    const parsed = readCursor(input.cursor)
    let fresh = parsed.fresh
    let link = parsed.link ?? initialDeltaUrl(top)
    let reset = false

    const messages: OutlookGraphMessage[] = []
    let pagesFetched = 0
    let attachmentLookups = 0

    /** Nothing was read: hand the caller's own cursor straight back. */
    const unchanged = (retryAfter: Date | null): OutlookDeltaResult => ({
        messages,
        cursor: input.cursor,
        cursorKind: 'unchanged',
        reset,
        retryAfter,
        pagesFetched,
    })

    const paused = (nextLink: string, retryAfter: Date | null = null): OutlookDeltaResult => (
        pagesFetched === 0
            ? unchanged(retryAfter)
            : { messages, cursor: markFresh(nextLink, fresh), cursorKind: 'next', reset, retryAfter, pagesFetched }
    )

    for (;;) {
        if (
            pagesFetched >= maxPages
            || messages.length >= maxEvents
            || attachmentLookups >= maxAttachmentLookups
            || now() - startedAt >= timeBudgetMs
        ) {
            return paused(link)
        }

        const response = await graphGet(link)

        if (isDeltaExpired(response.status) && !reset) {
            // The stored token aged out. A resync is the only recovery, and a resync is a
            // fresh chain — so the lookback bound applies to it again.
            reset = true
            fresh = true
            link = initialDeltaUrl(top)
            continue
        }

        if (!response.ok) {
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now())

            // A throttle is a control signal, not a fault: report it so the caller can stage
            // what it has and record the backoff against the cursor row. Throwing here would
            // discard both.
            if (isThrottled(response.status)) return paused(link, retryAfter)
            if (pagesFetched > 0) return paused(link, retryAfter)

            const body = await response.text()
            throw new OutlookGraphError(
                describeGraphError(body, response.status),
                response.status,
                response.headers.get('request-id') ?? undefined,
                retryAfter,
            )
        }

        const page = await response.json() as DeltaPageBody
        const cutoffMs = now() - lookbackDays * 24 * 60 * 60 * 1000

        const candidates = (page.value ?? []).filter((message) => {
            // Tombstones carry no content, and a draft is our own unsent mail.
            if (message['@removed']) return false
            if (message.isDraft) return false
            if (!fresh) return true
            const receivedMs = message.receivedDateTime ? Date.parse(message.receivedDateTime) : NaN
            return !Number.isFinite(receivedMs) || receivedMs >= cutoffMs
        })

        // Invariant 3: defer rather than overshoot. Graph honours $top, so this is a
        // guard against a provider that does not — the alternative is a silent truncation
        // inside ingestInboundPage that advances the cursor past the dropped messages.
        if (messages.length > 0 && messages.length + candidates.length > maxEvents) {
            return paused(link)
        }

        try {
            for (const message of candidates) {
                if (!message.hasAttachments) {
                    message.attachments = []
                    continue
                }
                // Graph delta cannot $expand, so metadata needs its own call per message.
                message.attachments = await fetchGraphAttachmentMetadata(message.id, graphGet)
                attachmentLookups++
            }
        } catch (error) {
            // Invariant 1: this page was not read in full, so it must not be staged and the
            // cursor must still point at it. Pages already read stay staged.
            if (pagesFetched > 0) {
                return paused(link, error instanceof OutlookGraphError ? error.retryAfter ?? null : null)
            }
            throw error
        }

        messages.push(...candidates)
        pagesFetched++

        const deltaLink = page['@odata.deltaLink']
        if (deltaLink) {
            // The chain is caught up: the first pass is over, so the lookback retires.
            return { messages, cursor: deltaLink, cursorKind: 'delta', reset, retryAfter: null, pagesFetched }
        }

        const nextLink = page['@odata.nextLink']
        if (!nextLink) {
            // Neither link: nothing more to read and nothing new to resume from.
            return unchanged(null)
        }

        link = nextLink
    }
}

/**
 * Attachment metadata only — never contentBytes. Binary blobs are deferred to Phase 22, and
 * pulling them here would turn one inbound tick into an unbounded download.
 */
async function fetchGraphAttachmentMetadata(
    messageId: string,
    graphGet: (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> }>,
): Promise<OutlookGraphAttachment[]> {
    const url = `${GRAPH_BASE_URL}/me/messages/${encodeURIComponent(messageId)}`
        + '/attachments?$select=id,name,contentType,size,isInline,contentId'

    const response = await graphGet(url)

    if (!response.ok) {
        const body = await response.text()
        throw new OutlookGraphError(
            describeGraphError(body, response.status),
            response.status,
            response.headers.get('request-id') ?? undefined,
            parseRetryAfter(response.headers.get('retry-after'), Date.now()),
        )
    }

    const body = await response.json() as { value?: OutlookGraphAttachment[] }
    return body.value ?? []
}

export const OUTLOOK_SCOPES = [
    'offline_access',
    'openid',
    'profile',
    'User.Read',
    'Mail.Read',
    'Mail.ReadWrite',
    'Mail.Send',
] as const

type OutlookOauthState = {
    userId: string
    organizationId: string
    nonce: string
    exp: number
}

type OutlookTokenResponse = {
    access_token: string
    refresh_token?: string
    expires_in: number
    scope?: string
}

type OutlookProfile = {
    id: string
    displayName?: string
    mail?: string
    userPrincipalName?: string
}

export type SanitizedOutlookMailbox = {
    id: string
    organizationId: string
    email: string
    displayName: string | null
    microsoftUserId: string
    tenantId: string | null
    scopes: string[]
    status: 'active' | 'expired' | 'revoked'
    tokenExpiresAt: Date
    lastSyncedAt: Date | null
    lastSendAt: Date | null
    createdAt: Date
    updatedAt: Date
}

export type OutlookSendInput = {
    organizationId: string
    mailboxId?: string
    fromAddress: string
    subject: string
    htmlBody?: string | null
    plainBody?: string | null
    to: string[]
    cc?: string[]
    bcc?: string[]
    attachments?: Array<{
        filename: string
        content: string
        contentType: string
    }>
}

export type OutlookMimeSendInput = {
    organizationId: string
    mailboxId?: string
    fromAddress: string
    /** Fully composed RFC 5322 bytes. Sent verbatim — Graph does not rewrite headers. */
    raw: Buffer
}

export type OutlookMimeSendResult = {
    mailbox: SanitizedOutlookMailbox
    /** Graph's own correlation id for the accepted request, when it returns one. */
    requestId?: string
}

function getRequiredEnv(name: string): string {
    const value = process.env[name]

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`)
    }

    return value
}

function getStateSecret(): string {
    return process.env.OUTLOOK_TOKEN_ENCRYPTION_KEY || getRequiredEnv('JWT_SECRET')
}

function signState(payload: string): string {
    return crypto
        .createHmac('sha256', getStateSecret())
        .update(payload)
        .digest('base64url')
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const parts = token.split('.')

    if (parts.length < 2) {
        return null
    }

    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
        return null
    }
}

function mapRecipients(addresses: string[] = []) {
    return addresses.map((address) => ({
        emailAddress: { address },
    }))
}

async function fetchToken(
    params: Record<string, string>,
): Promise<OutlookTokenResponse> {
    const body = new URLSearchParams({
        client_id: getRequiredEnv('MICROSOFT_CLIENT_ID'),
        client_secret: getRequiredEnv('MICROSOFT_CLIENT_SECRET'),
        ...params,
    })

    const response = await fetch(`${OAUTH_BASE_URL}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
    })

    const data = await response.json() as OutlookTokenResponse & {
        error?: string
        error_description?: string
    }

    if (!response.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Failed to obtain Outlook token')
    }

    return data
}

async function fetchOutlookProfile(accessToken: string): Promise<OutlookProfile> {
    const response = await fetch(`${GRAPH_BASE_URL}/me?$select=id,displayName,mail,userPrincipalName`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
    })

    const data = await response.json() as OutlookProfile & { error?: { message?: string } }

    if (!response.ok || !data.id) {
        throw new Error(data.error?.message || 'Failed to read Outlook profile')
    }

    return data
}

export function sanitizeOutlookMailbox(mailbox: OutlookMailbox): SanitizedOutlookMailbox {
    return {
        id: mailbox.id,
        organizationId: mailbox.organizationId,
        email: mailbox.email,
        displayName: mailbox.displayName,
        microsoftUserId: mailbox.microsoftUserId,
        tenantId: mailbox.tenantId,
        scopes: (mailbox.scopes as string[]) || [],
        status: mailbox.status,
        tokenExpiresAt: mailbox.tokenExpiresAt,
        lastSyncedAt: mailbox.lastSyncedAt,
        lastSendAt: mailbox.lastSendAt,
        createdAt: mailbox.createdAt,
        updatedAt: mailbox.updatedAt,
    }
}

export function createOutlookOauthState(userId: string, organizationId: string): string {
    const payload = Buffer.from(JSON.stringify({
        userId,
        organizationId,
        nonce: crypto.randomUUID(),
        exp: Date.now() + STATE_TTL_MS,
    } satisfies OutlookOauthState)).toString('base64url')

    return `${payload}.${signState(payload)}`
}

export function parseOutlookOauthState(state: string): OutlookOauthState {
    const [payload, signature] = state.split('.')

    if (!payload || !signature || signState(payload) !== signature) {
        throw new Error('Invalid Outlook OAuth state')
    }

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OutlookOauthState

    if (parsed.exp < Date.now()) {
        throw new Error('Expired Outlook OAuth state')
    }

    return parsed
}

export function buildOutlookOauthUrl(state: string, loginHint?: string): string {
    const redirectUri = getRequiredEnv('MICROSOFT_REDIRECT_URI')
    const url = new URL(`${OAUTH_BASE_URL}/authorize`)

    url.searchParams.set('client_id', getRequiredEnv('MICROSOFT_CLIENT_ID'))
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_mode', 'query')
    url.searchParams.set('scope', OUTLOOK_SCOPES.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('prompt', 'select_account')

    if (loginHint) {
        url.searchParams.set('login_hint', loginHint)
    }

    return url.toString()
}

export async function exchangeCodeForOutlookConnection(code: string) {
    const token = await fetchToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: getRequiredEnv('MICROSOFT_REDIRECT_URI'),
    })

    const profile = await fetchOutlookProfile(token.access_token)
    const jwtPayload = decodeJwtPayload(token.access_token)
    const tenantId = typeof jwtPayload?.tid === 'string' ? jwtPayload.tid : null

    return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        scopes: token.scope?.split(' ').filter(Boolean) || [...OUTLOOK_SCOPES],
        profile,
        tenantId,
    }
}

export async function resolveOutlookMailboxForServer(organizationId: string, mailboxId?: string) {
    if (mailboxId) {
        return db.query.outlookMailboxes.findFirst({
            where: and(
                eq(outlookMailboxes.id, mailboxId),
                eq(outlookMailboxes.organizationId, organizationId),
            ),
        })
    }

    return db.query.outlookMailboxes.findFirst({
        where: and(
            eq(outlookMailboxes.organizationId, organizationId),
            eq(outlookMailboxes.status, 'active'),
        ),
        orderBy: [asc(outlookMailboxes.createdAt)],
    })
}

async function refreshOutlookAccessToken(mailbox: OutlookMailbox) {
    const refreshToken = decryptSecret(mailbox.refreshTokenEncrypted)
    const token = await fetchToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        redirect_uri: getRequiredEnv('MICROSOFT_REDIRECT_URI'),
        scope: ((mailbox.scopes as string[]) || OUTLOOK_SCOPES).join(' '),
    })

    const nextRefreshToken = token.refresh_token || refreshToken
    const updates = {
        accessTokenEncrypted: encryptSecret(token.access_token),
        refreshTokenEncrypted: encryptSecret(nextRefreshToken),
        tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
        status: 'active' as const,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
    }

    const [updated] = await db
        .update(outlookMailboxes)
        .set(updates)
        .where(eq(outlookMailboxes.id, mailbox.id))
        .returning()

    return {
        mailbox: updated,
        accessToken: token.access_token,
    }
}

/**
 * Refresh, and mark the mailbox expired if the grant is gone. A failed refresh is not
 * recoverable by retrying the send, so the row must stop advertising itself as active.
 */
async function refreshOrMarkExpired(mailbox: OutlookMailbox) {
    try {
        return await refreshOutlookAccessToken(mailbox)
    } catch (error) {
        await db
            .update(outlookMailboxes)
            .set({
                status: 'expired',
                updatedAt: new Date(),
            })
            .where(eq(outlookMailboxes.id, mailbox.id))

        throw error
    }
}

export async function getValidOutlookAccessToken(mailbox: OutlookMailbox) {
    const expiresAtMs = mailbox.tokenExpiresAt.getTime()

    if (expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
        return {
            mailbox,
            accessToken: decryptSecret(mailbox.accessTokenEncrypted),
        }
    }

    return refreshOrMarkExpired(mailbox)
}

/** Pull a human-readable reason out of a Graph error body without echoing the request. */
function describeGraphError(body: string, status: number): string {
    if (!body.trim()) return `Outlook Graph request failed with status ${status}`

    try {
        const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } }
        const detail = parsed.error?.message || parsed.error?.code
        if (detail) return detail.slice(0, 500)
    } catch {
        // Not JSON — fall through to the raw body.
    }

    return body.slice(0, 500)
}

async function markOutlookMailboxSent(mailboxId: string): Promise<void> {
    await db
        .update(outlookMailboxes)
        .set({
            lastSendAt: new Date(),
            lastSyncedAt: new Date(),
            status: 'active',
            updatedAt: new Date(),
        })
        .where(eq(outlookMailboxes.id, mailboxId))
}

/**
 * Send a precomposed MIME message through Graph.
 *
 * Why MIME and not the JSON `message` shape: Graph's JSON shape has no home for
 * List-Unsubscribe / List-Unsubscribe-Post, drops the caller's Message-ID, and returns
 * nothing to correlate on. Outreach sent through it silently lost bulk-sender compliance
 * headers and reply/bounce matchability (see PROV-03). The documented MIME variant posts
 * base64 RFC 5322 bytes with `Content-Type: text/plain` and preserves the headers as-is.
 *
 * The caller composes the bytes exactly once (outreach-provider.ts) so SMTP, native, and
 * Outlook all ship the identical message.
 */
export async function sendMimeMessageWithOutlook(input: OutlookMimeSendInput): Promise<OutlookMimeSendResult> {
    const mailbox = await resolveOutlookMailboxForServer(input.organizationId, input.mailboxId)

    if (!mailbox) {
        throw new Error('No active Outlook mailbox found for this organization')
    }

    if (input.fromAddress.toLowerCase() !== mailbox.email.toLowerCase()) {
        throw new Error(`Outlook mailbox ${mailbox.email} can only send with its own address`)
    }

    if (input.raw.byteLength > GRAPH_MIME_MAX_BYTES) {
        // 413 so the shared classifier reads it as terminal — a too-large message will not
        // shrink on retry.
        throw new OutlookGraphError(
            `Composed message is ${input.raw.byteLength} bytes; Graph MIME sendMail accepts at most ${GRAPH_MIME_MAX_BYTES}`,
            413,
        )
    }

    const body = input.raw.toString('base64')
    let { accessToken, mailbox: activeMailbox } = await getValidOutlookAccessToken(mailbox)

    const post = (token: string) => fetch(`${GRAPH_BASE_URL}/me/sendMail`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/plain',
        },
        body,
        signal: AbortSignal.timeout(20_000),
    })

    let response = await post(accessToken)

    // Graph can reject a token we still believe is valid (revoked, rotated, or clock skew
    // beyond REFRESH_SKEW_MS). Refresh and retry exactly once — a second 401 is a real
    // authorization failure and must surface as terminal rather than loop.
    if (response.status === 401) {
        const refreshed = await refreshOrMarkExpired(activeMailbox)
        accessToken = refreshed.accessToken
        activeMailbox = refreshed.mailbox
        response = await post(accessToken)
    }

    const requestId = response.headers.get('request-id') ?? undefined

    if (!response.ok) {
        const errorBody = await response.text()
        throw new OutlookGraphError(describeGraphError(errorBody, response.status), response.status, requestId)
    }

    await markOutlookMailboxSent(activeMailbox.id)

    return { mailbox: sanitizeOutlookMailbox(activeMailbox), requestId }
}

// ---------------------------------------------------------------------------
// Outreach capability gate (PROV-02)
// ---------------------------------------------------------------------------

/**
 * Outreach needs all three: Mail.Send to deliver, Mail.Read to see replies and DSNs, and
 * Mail.ReadWrite because the inbound reader may need to write message state later. An
 * account granted only Mail.Send can send campaigns it can never hear the answer to — it
 * looks healthy while silently mailing addresses that already hard-bounced.
 */
export const REQUIRED_OUTLOOK_OUTREACH_SCOPES = ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send'] as const

export type OutlookCapabilityCode =
    | 'outlook_mailbox_unlinked'
    | 'outlook_mailbox_unreachable'
    | 'outlook_mailbox_address_mismatch'
    | 'outlook_mailbox_inactive'
    | 'outlook_missing_scopes'
    | 'outlook_auth_failed'
    | 'outlook_inbound_sync_failed'

export type OutlookCapabilityResult =
    | { verified: true; scopes: string[]; gate: string }
    | {
        verified: false
        /** 'pending' means "try again"; 'failed' means "a human must fix the grant". */
        status: 'pending' | 'failed'
        code: OutlookCapabilityCode
        missingScopes?: string[]
    }

/**
 * Graph's token endpoint may return a scope as a bare name (`Mail.Read`) or as a fully
 * qualified resource URI (`https://graph.microsoft.com/Mail.Read`), and casing is not
 * guaranteed. Comparing raw strings would fail the gate for every correctly-granted mailbox.
 */
function normalizeScope(scope: string): string {
    const trimmed = scope.trim()
    const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
    return lastSegment.toLowerCase()
}

export function findMissingOutlookScopes(
    granted: unknown,
    required: readonly string[] = REQUIRED_OUTLOOK_OUTREACH_SCOPES,
): string[] {
    const grantedSet = new Set(
        (Array.isArray(granted) ? granted : [])
            .filter((scope): scope is string => typeof scope === 'string')
            .map(normalizeScope),
    )
    return required.filter((scope) => !grantedSet.has(normalizeScope(scope)))
}

/**
 * Graph offers no zero-send probe for Mail.Send: creating a draft exercises Mail.ReadWrite,
 * not Mail.Send, and the only call that proves the permission is one that actually delivers
 * mail to a real recipient. Sending a live "test" email from an outreach inbox during
 * verification is exactly the behaviour this phase exists to prevent, so send capability is
 * asserted from the granted scopes while read capability is proven by a real bounded sync.
 * The response states this gate rather than implying the send path was exercised.
 */
export const OUTLOOK_CAPABILITY_GATE =
    'Send capability is asserted from the granted Mail.Send scope (Graph has no zero-send probe); '
    + 'read capability is proven by a bounded initial inbox sync.'

/**
 * What an inbound probe must report back for the gate to trust it.
 *
 * Both fields already exist at the call site and used to be discarded. Deliberately not
 * "did it throw": the reader treats a throttle as a control signal and returns, so silence
 * carries no information about whether a read happened.
 */
export interface OutlookInboundProbe {
    /** Provider pages actually read. Zero means the sync never got a response. */
    pagesFetched?: number
    /** Provider-stated backoff, when Graph asked us to slow down. */
    retryAfter?: Date | null
}

/**
 * Decide whether an Outlook outreach account may be activated.
 *
 * Deliberately free of db/HTTP so the decision table is unit-testable: the caller injects the
 * mailbox lookup and the inbound probe.
 */
export async function evaluateOutlookOutreachCapability(input: {
    account: { id: string; organizationId: string; email: string; outlookMailboxId: string | null }
    loadMailbox: (mailboxId: string, organizationId: string) => Promise<OutlookMailbox | null | undefined>
    /**
     * Must report what the sync actually achieved. Resolving is NOT proof of a read:
     * fetchOutlookInboxDelta returns on a throttle or a 5xx instead of throwing, so a probe
     * that "did not throw" may have read nothing at all (W-1).
     */
    probeInbound: (mailbox: OutlookMailbox) => Promise<OutlookInboundProbe>
}): Promise<OutlookCapabilityResult> {
    const { account } = input

    if (!account.outlookMailboxId) {
        return { verified: false, status: 'failed', code: 'outlook_mailbox_unlinked' }
    }

    // Scoped by organization: tenant isolation is JS-side (the app role bypasses RLS), so a
    // mailbox id pointing at another tenant must not resolve.
    const mailbox = await input.loadMailbox(account.outlookMailboxId, account.organizationId)
    if (!mailbox) {
        return { verified: false, status: 'failed', code: 'outlook_mailbox_unreachable' }
    }

    if (mailbox.email.trim().toLowerCase() !== account.email.trim().toLowerCase()) {
        // Graph only lets a mailbox send as itself, so this account could never deliver.
        return { verified: false, status: 'failed', code: 'outlook_mailbox_address_mismatch' }
    }

    if (mailbox.status !== 'active') {
        return { verified: false, status: 'failed', code: 'outlook_mailbox_inactive' }
    }

    const missingScopes = findMissingOutlookScopes(mailbox.scopes)
    if (missingScopes.length > 0) {
        return { verified: false, status: 'failed', code: 'outlook_missing_scopes', missingScopes }
    }

    let probe: OutlookInboundProbe
    try {
        probe = await input.probeInbound(mailbox)
    } catch (error) {
        if (error instanceof OutlookGraphError) {
            // A revoked or under-scoped grant needs a human; a throttle or a Graph outage
            // does not. Keeping the latter 'pending' lets a retry activate the account
            // without re-consenting, while never letting it send in the meantime.
            const transient = error.statusCode === 429 || error.statusCode >= 500
            if (!transient) {
                return { verified: false, status: 'failed', code: 'outlook_auth_failed' }
            }
        }
        return { verified: false, status: 'pending', code: 'outlook_inbound_sync_failed' }
    }

    // The gate's claim is "read capability is proven by a bounded initial inbox sync", so
    // it must hold evidence that a sync happened. A throttled or unavailable Graph returns
    // a perfectly well-formed empty result, which proves nothing — same 'pending' outcome
    // as a thrown throttle, and for the same reason: retry, never re-consent, never send.
    if ((probe.pagesFetched ?? 0) <= 0) {
        return { verified: false, status: 'pending', code: 'outlook_inbound_sync_failed' }
    }

    return {
        verified: true,
        scopes: (mailbox.scopes as string[]) || [],
        gate: OUTLOOK_CAPABILITY_GATE,
    }
}

export async function sendMessageWithOutlook(input: OutlookSendInput) {
    const mailbox = await resolveOutlookMailboxForServer(input.organizationId, input.mailboxId)

    if (!mailbox) {
        throw new Error('No active Outlook mailbox found for this organization')
    }

    if (input.fromAddress.toLowerCase() !== mailbox.email.toLowerCase()) {
        throw new Error(`Outlook mailbox ${mailbox.email} can only send with its own address`)
    }

    const { accessToken, mailbox: activeMailbox } = await getValidOutlookAccessToken(mailbox)

    const bodyContent = input.htmlBody || input.plainBody || ''
    const contentType = input.htmlBody ? 'HTML' : 'Text'

    const response = await fetch(`${GRAPH_BASE_URL}/me/sendMail`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            message: {
                subject: input.subject,
                body: {
                    contentType,
                    content: bodyContent,
                },
                toRecipients: mapRecipients(input.to),
                ccRecipients: mapRecipients(input.cc),
                bccRecipients: mapRecipients(input.bcc),
                attachments: (input.attachments || []).map((attachment) => ({
                    '@odata.type': '#microsoft.graph.fileAttachment',
                    name: attachment.filename,
                    contentType: attachment.contentType,
                    contentBytes: attachment.content,
                })),
            },
            saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(20_000),
    })

    if (!response.ok) {
        const errorBody = await response.text()
        throw new Error(errorBody || 'Outlook sendMail failed')
    }

    await db
        .update(outlookMailboxes)
        .set({
            lastSendAt: new Date(),
            lastSyncedAt: new Date(),
            status: 'active',
            updatedAt: new Date(),
        })
        .where(eq(outlookMailboxes.id, activeMailbox.id))

    return sanitizeOutlookMailbox(activeMailbox)
}
