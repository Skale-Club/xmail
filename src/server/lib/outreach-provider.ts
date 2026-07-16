/**
 * Outreach provider adapters — compose once, ship the same bytes everywhere.
 *
 * Why this module exists (PROV-03 / PROV-05): each provider used to build its own message.
 * The SMTP path handed Nodemailer a subject/html/text/headers object; the native path
 * re-composed that same object into MIME; the Outlook path threw the headers away entirely
 * and posted Graph's JSON `message` shape, which has nowhere to put List-Unsubscribe and
 * returns no Message-ID. The result was a recipient's experience — and our ability to match
 * their reply — silently depending on which inbox happened to be assigned.
 *
 * The contract, once:
 *
 *   composeOutreachMime(input) -> { raw, messageId, envelope, content }
 *          |                  |                    |
 *        SMTP               native               Outlook
 *      raw + envelope    relay(raw) + file     Graph MIME send
 *
 * Every adapter receives the *same* `raw` buffer and returns the *same* precomposed
 * `messageId`. No adapter re-composes, re-encodes, or invents an id. That is what makes
 * "provider choice does not change outreach compliance headers or attempt history" a
 * property of the code rather than a hope.
 *
 * Ownership boundaries:
 *   - Content decisions (templates, tracking injection, unsubscribe URL minting) stay in
 *     outreach-sender.ts. This module does not know what a campaign is.
 *   - Attempt/lease/policy state stays in outreach-dispatch.ts. This module performs one
 *     send and reports a normalized outcome; it never writes dispatch state.
 *   - SMTP TLS semantics stay in smtp-security.ts (PROV-01). This module must not re-derive
 *     them.
 */

import nodemailer from 'nodemailer'
import type { EmailAccount } from '../../db/schema'
import { decryptSecret } from './crypto'
import { createLogger } from './logger'
import { getNativeMailboxByEmail, relayMessage, storeMessage } from './native-send'
import { sendMimeMessageWithOutlook } from './outlook'
import {
    normalizeProviderFailure,
    type ProviderAcceptance,
    type ProviderDispatchResult,
    type ProviderFailure,
} from './outreach-dispatch'
import { buildSmtpTransportOptions } from './smtp-security'

const log = createLogger('outreach.provider')

export interface OutreachMimeAddress {
    address: string
    name?: string | null
}

export interface OutreachUnsubscribeOptions {
    /** One-click unsubscribe endpoint (POST-safe). Becomes the first List-Unsubscribe target. */
    url: string
    /** Optional mailto fallback, without the `mailto:` scheme (e.g. `a@b.com?subject=unsubscribe`). */
    mailto?: string | null
    /** RFC 8058 one-click. Defaults to true; set false for a link-only List-Unsubscribe. */
    oneClick?: boolean
}

export interface OutreachAttachmentInput {
    filename: string
    content: Buffer | string
    contentType?: string
    encoding?: string
    /** Content-ID for inline images referenced from the HTML alternative. */
    cid?: string
}

export interface OutreachMimeInput {
    from: OutreachMimeAddress
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    text?: string | null
    html?: string | null
    replyTo?: string | null
    /**
     * Stable Message-ID, normally minted by the dispatcher from (org, idempotencyKey) so a
     * retried attempt reuses it. Omitted only by callers with no durable attempt row; the
     * composer then lets Nodemailer generate one and reports it back either way.
     */
    messageId?: string | null
    inReplyTo?: string | null
    /** Existing References chain (raw header value or list). The parent is appended. */
    references?: string | string[] | null
    unsubscribe?: OutreachUnsubscribeOptions | null
    attachments?: OutreachAttachmentInput[]
    date?: Date
}

/** Structured echo of what was composed, used to file the native Sent copy without re-parsing MIME. */
export interface ComposedOutreachContent {
    subject: string
    text: string | null
    html: string | null
    from: OutreachMimeAddress
    to: string[]
    cc: string[]
    bcc: string[]
    inReplyTo: string | null
    references: string | null
    hasAttachments: boolean
}

export interface ComposedOutreachMessage {
    /** RFC 5322 bytes. This exact buffer is what every provider transmits. */
    raw: Buffer
    /** Canonical bracketed form, e.g. `<xmail-abc@outreach.local>`. Known before dispatch. */
    messageId: string
    /** SMTP envelope. `to` includes cc and bcc; the Bcc header is deliberately not in `raw`. */
    envelope: { from: string; to: string[] }
    content: ComposedOutreachContent
}

export type OutreachProviderKind = 'smtp' | 'native' | 'outlook'

export interface OutreachProviderResult {
    accepted: boolean
    acceptance: ProviderAcceptance
    /** The precomposed Message-ID, echoed on acceptance. Never a transport-invented id. */
    messageId?: string
    /**
     * Provider-side correlation handle when one exists (Graph request-id, SMTP queue
     * response). Diagnostic only — reply/bounce matching keys off `messageId`.
     */
    providerId?: string
    /** Rendered bodies as actually composed, for the dispatcher's attempt record. */
    finalHtml?: string
    finalText?: string
    failure?: ProviderFailure
}

export interface OutreachProviderAdapter {
    readonly kind: OutreachProviderKind
    send(message: ComposedOutreachMessage): Promise<OutreachProviderResult>
}

/** Seams for tests. Production callers use the defaults. */
export interface OutreachProviderDependencies {
    createSmtpTransport?: (account: EmailAccount) => nodemailer.Transporter
    relayNativeMessage?: typeof relayMessage
    storeNativeMessage?: typeof storeMessage
    findNativeMailbox?: typeof getNativeMailboxByEmail
    sendOutlookMime?: typeof sendMimeMessageWithOutlook
}

// ---------------------------------------------------------------------------
// MIME header reading
// ---------------------------------------------------------------------------

/**
 * Headers without which a message is not a deliverable outreach email. Checked against the
 * composed bytes before a provider is called, so a compose regression fails as a terminal
 * classification here rather than as an opaque provider rejection (or worse, an accepted
 * send of a malformed message).
 */
export const REQUIRED_OUTREACH_MIME_HEADERS: readonly string[] = ['From', 'To', 'Subject', 'Message-ID']

function headerBlock(raw: Buffer | string): string {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    // Headers end at the first blank line. Tolerate bare-LF composers.
    const boundary = text.search(/\r?\n\r?\n/)
    return boundary === -1 ? text : text.slice(0, boundary)
}

/**
 * Read one header from composed MIME, unfolding RFC 5322 continuation lines.
 *
 * Unfolding is not optional: Nodemailer folds a long List-Unsubscribe across lines, so a
 * naive `raw.includes('List-Unsubscribe: <https://...')` reports a missing header on exactly
 * the messages we care most about.
 */
export function readMimeHeader(raw: Buffer | string, name: string): string | null {
    const target = name.toLowerCase()
    const lines = headerBlock(raw).split(/\r?\n/)

    let value: string | null = null
    for (const line of lines) {
        if (/^[ \t]/.test(line)) {
            // Continuation of the header we are currently reading. A folded value whose first
            // line is empty (`List-Unsubscribe:\r\n <url>`) must not gain a leading space.
            if (value !== null) value = value ? `${value} ${line.trim()}` : line.trim()
            continue
        }

        if (value !== null) break

        const separator = line.indexOf(':')
        if (separator === -1) continue
        if (line.slice(0, separator).trim().toLowerCase() === target) {
            value = line.slice(separator + 1).trim()
        }
    }

    return value
}

/** Names from `required` that the buffer does not carry, in the order given. */
export function findMissingMimeHeaders(
    raw: Buffer | string,
    required: readonly string[] = REQUIRED_OUTREACH_MIME_HEADERS,
): string[] {
    return required.filter((name) => {
        const value = readMimeHeader(raw, name)
        return value === null || value.length === 0
    })
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function bracket(messageId: string): string {
    const trimmed = messageId.trim()
    if (!trimmed) return trimmed
    return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed.replace(/[<>]/g, '')}>`
}

function referenceList(references: string | string[] | null | undefined): string[] {
    if (!references) return []
    const parts = Array.isArray(references) ? references : references.split(/\s+/)
    return parts.map((part) => part.trim()).filter(Boolean).map(bracket)
}

/**
 * Build the References chain: everything the parent already referenced, plus the parent
 * itself, de-duplicated and order-preserving (RFC 5322 §3.6.4).
 */
function buildReferences(
    references: string | string[] | null | undefined,
    inReplyTo: string | null | undefined,
): string | null {
    const chain = referenceList(references)
    if (inReplyTo) {
        const parent = bracket(inReplyTo)
        if (!chain.includes(parent)) chain.push(parent)
    }
    return chain.length > 0 ? chain.join(' ') : null
}

function listUnsubscribeHeader(unsubscribe: OutreachUnsubscribeOptions): string {
    const targets = [`<${unsubscribe.url}>`]
    if (unsubscribe.mailto) {
        const mailto = unsubscribe.mailto.replace(/^mailto:/i, '')
        targets.push(`<mailto:${mailto}>`)
    }
    return targets.join(', ')
}

/**
 * Compose the single MIME representation of an outreach message.
 *
 * Uses Nodemailer's stream transport (buffered — never touches the network) so the bytes we
 * hand to SMTP are produced by the same composer that produced the bytes we hand to Graph.
 */
export async function composeOutreachMime(input: OutreachMimeInput): Promise<ComposedOutreachMessage> {
    const to = input.to.filter(Boolean)
    const cc = (input.cc ?? []).filter(Boolean)
    const bcc = (input.bcc ?? []).filter(Boolean)

    if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
        throw new Error('Cannot compose an outreach message with no recipients')
    }

    const headers: Record<string, string> = {}

    if (input.unsubscribe) {
        headers['List-Unsubscribe'] = listUnsubscribeHeader(input.unsubscribe)
        if (input.unsubscribe.oneClick !== false) {
            headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
        }
    }

    const references = buildReferences(input.references, input.inReplyTo)
    if (input.inReplyTo) headers['In-Reply-To'] = bracket(input.inReplyTo)
    if (references) headers['References'] = references

    // The envelope is set explicitly because Nodemailer's stream composer always writes a
    // Bcc header into the message, and only its SMTP transport strips it. We transmit the
    // composed bytes verbatim to three different providers, so a Bcc header in `raw` would
    // disclose every blind recipient. Omitting `bcc` from the message while naming all
    // recipients in the envelope is the only shape that is correct for all three.
    const envelope = { from: input.from.address, to: [...to, ...cc, ...bcc] }

    const mailOptions: nodemailer.SendMailOptions = {
        from: input.from.name ? { name: input.from.name, address: input.from.address } : input.from.address,
        to,
        subject: input.subject,
        text: input.text ?? undefined,
        html: input.html ?? undefined,
        replyTo: input.replyTo ?? undefined,
        headers,
        envelope,
        attachments: input.attachments,
        date: input.date,
    }

    if (cc.length > 0) mailOptions.cc = cc
    if (input.messageId) mailOptions.messageId = bracket(input.messageId)

    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true })
    const composed = await composer.sendMail(mailOptions)

    const raw = composed.message as Buffer
    // Prefer the id we asked for; fall back to the composer's when the caller had none.
    const messageId = bracket(input.messageId || (composed.messageId as string))

    return {
        raw,
        messageId,
        envelope,
        content: {
            subject: input.subject,
            text: input.text ?? null,
            html: input.html ?? null,
            from: input.from,
            to,
            cc,
            bcc,
            inReplyTo: input.inReplyTo ? bracket(input.inReplyTo) : null,
            references,
            hasAttachments: (input.attachments?.length ?? 0) > 0,
        },
    }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function terminal(code: string, message: string): OutreachProviderResult {
    return {
        accepted: false,
        acceptance: 'rejected',
        failure: {
            code,
            classification: 'terminal',
            acceptance: 'rejected',
            retryable: false,
            message: message.slice(0, 500),
        },
    }
}

function accepted(message: ComposedOutreachMessage, providerId?: string): OutreachProviderResult {
    return {
        accepted: true,
        acceptance: 'accepted',
        messageId: message.messageId,
        providerId,
        finalHtml: message.content.html ?? undefined,
        finalText: message.content.text ?? undefined,
    }
}

/**
 * Bridge the adapter outcome onto the dispatcher's `ProviderDispatchResult`.
 *
 * The two shapes are deliberately distinct: an adapter reports what a provider did, while
 * the dispatcher's union drives lease finalization. Converting in one place keeps a provider
 * from having to know about attempt state — and keeps `accepted: true` from being read as a
 * missing `success`, which silently routes a delivered message into the failure branch.
 */
export function toDispatchResult(result: OutreachProviderResult): ProviderDispatchResult {
    if (result.accepted) {
        return {
            success: true,
            acceptance: 'accepted',
            messageId: result.messageId,
            finalHtml: result.finalHtml,
            finalText: result.finalText,
        }
    }

    const failure = result.failure
        ?? normalizeProviderFailure(new Error('Provider rejected the message without detail'))
    return { success: false, acceptance: failure.acceptance, failure }
}

/**
 * Build the SMTP transport for a stored outreach account.
 *
 * PROV-01: the port/flag → transport mapping lives only in smtp-security.ts, shared with the
 * verification transporter in routes/outreach/email-accounts.ts, so an inbox cannot verify
 * under one TLS mode and then send under another.
 */
export function createSmtpTransporter(account: EmailAccount): nodemailer.Transporter {
    if (!account.smtpHost || !account.smtpPassword || !account.smtpUsername) {
        throw new Error('SMTP account missing required fields')
    }

    const { options, resolution } = buildSmtpTransportOptions({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecure,
        username: account.smtpUsername,
        password: decryptSecret(account.smtpPassword),
    })

    if (resolution.warning) {
        // Account id and mode only — never the host credentials or the decrypted password.
        log.warn({ emailAccountId: account.id, mode: resolution.mode }, resolution.warning)
    }

    return nodemailer.createTransport(options)
}

function smtpAdapter(account: EmailAccount, deps: OutreachProviderDependencies): OutreachProviderAdapter {
    return {
        kind: 'smtp',
        async send(message) {
            const transporter = (deps.createSmtpTransport ?? createSmtpTransporter)(account)
            // `raw` + explicit envelope: Nodemailer transmits our bytes untouched instead of
            // recompiling from subject/html/text and minting its own Message-ID.
            const info = await transporter.sendMail({ raw: message.raw, envelope: message.envelope })
            return accepted(message, info?.response ?? undefined)
        },
    }
}

function nativeAdapter(account: EmailAccount, deps: OutreachProviderDependencies): OutreachProviderAdapter {
    const relay = deps.relayNativeMessage ?? relayMessage
    const store = deps.storeNativeMessage ?? storeMessage
    const findMailbox = deps.findNativeMailbox ?? getNativeMailboxByEmail

    return {
        kind: 'native',
        async send(message) {
            const mailbox = await findMailbox(account.email)
            if (!mailbox) {
                return terminal(
                    'native_mailbox_missing',
                    'Native mailbox not found for outreach account — was it deleted?',
                )
            }

            await relay(message.envelope.from, message.envelope.to, message.raw)

            try {
                await store(mailbox.id, 'sent', {
                    messageId: message.messageId,
                    inReplyTo: message.content.inReplyTo ?? undefined,
                    references: message.content.references ?? undefined,
                    subject: message.content.subject,
                    fromAddress: account.email,
                    fromName: account.displayName || null,
                    toAddresses: message.content.to.map((address) => ({ address, name: null })),
                    ccAddresses: message.content.cc.map((address) => ({ address, name: null })),
                    bccAddresses: message.content.bcc.map((address) => ({ address, name: null })),
                    plainBody: message.content.text ?? undefined,
                    htmlBody: message.content.html ?? undefined,
                    hasAttachments: message.content.hasAttachments,
                    attachments: [],
                }, true)
            } catch (error) {
                // Best-effort: the message is already relayed. Failing the send here would
                // re-send it on the next attempt — a filing problem must not become a
                // duplicate email. (Mirrors how the SMTP path never fails over IMAP append.)
                log.warn({
                    action: 'outreach.provider.sent_copy_failed',
                    emailAccountId: account.id,
                    error: { message: error instanceof Error ? error.message : String(error) },
                }, 'failed to file native Sent copy')
            }

            return accepted(message)
        },
    }
}

function outlookAdapter(account: EmailAccount, deps: OutreachProviderDependencies): OutreachProviderAdapter {
    const send = deps.sendOutlookMime ?? sendMimeMessageWithOutlook

    return {
        kind: 'outlook',
        async send(message) {
            if (!account.outlookMailboxId) {
                return terminal(
                    'outlook_mailbox_unlinked',
                    'Outreach account is marked Outlook but has no linked Outlook mailbox',
                )
            }

            // Graph accepts opaque bytes; a compose regression would be delivered as-is.
            const missing = findMissingMimeHeaders(message.raw)
            if (missing.length > 0) {
                return terminal('mime_headers_missing', `Composed message is missing headers: ${missing.join(', ')}`)
            }

            // Graph's MIME sendMail takes no envelope — it derives recipients from the
            // headers — and the composer deliberately keeps Bcc out of the headers so blind
            // recipients are not disclosed to everyone else. A bcc address would therefore
            // exist nowhere Graph can see: it would return 202 and simply never deliver it,
            // while SMTP and native deliver the same bytes via RCPT TO.
            //
            // Fail closed. Adding the Bcc header instead would trade a silent
            // non-delivery for a silent disclosure, which is strictly worse.
            if ((message.content?.bcc?.length ?? 0) > 0) {
                return terminal(
                    'outlook_bcc_unsupported',
                    'Outlook sends MIME through Graph, which takes recipients from the message headers only. '
                    + 'A blind recipient cannot be delivered without disclosing it, so this message is refused '
                    + 'rather than sent with the bcc silently dropped.',
                )
            }

            const result = await send({
                organizationId: account.organizationId,
                mailboxId: account.outlookMailboxId,
                fromAddress: account.email,
                raw: message.raw,
            })

            // Graph returns 202 with no body, so the id we already composed is the only
            // Message-ID that exists — and, because it is in the bytes Graph relayed, it is
            // the one the recipient's reply will thread against.
            return accepted(message, result?.requestId)
        },
    }
}

export function createOutreachProviderAdapter(
    account: EmailAccount,
    deps: OutreachProviderDependencies = {},
): OutreachProviderAdapter {
    switch (account.provider) {
        case 'outlook':
            return outlookAdapter(account, deps)
        case 'native':
            return nativeAdapter(account, deps)
        default:
            return smtpAdapter(account, deps)
    }
}

/**
 * Compose once, dispatch through the account's provider, and report a normalized outcome.
 *
 * Every thrown provider error funnels through `normalizeProviderFailure`, so the dispatcher's
 * retry policy sees the same shape whether the failure came from an SMTP response code or a
 * Graph HTTP status.
 */
export async function sendComposedOutreachMessage(
    account: EmailAccount,
    input: OutreachMimeInput,
    deps: OutreachProviderDependencies = {},
): Promise<OutreachProviderResult> {
    try {
        const message = await composeOutreachMime(input)
        return await createOutreachProviderAdapter(account, deps).send(message)
    } catch (error) {
        const failure = normalizeProviderFailure(error)
        return { accepted: false, acceptance: failure.acceptance, failure }
    }
}
