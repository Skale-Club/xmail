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

    constructor(message: string, statusCode: number, requestId?: string) {
        super(message)
        this.name = 'OutlookGraphError'
        this.statusCode = statusCode
        this.requestId = requestId
    }
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
