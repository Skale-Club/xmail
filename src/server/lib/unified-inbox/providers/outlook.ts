/**
 * Outlook / Microsoft Graph provider adapter (Phase 21 UIF-02).
 *
 * Maps a Graph delta message (with its body/header/recipient/attachment metadata already
 * requested by the reader) onto the shared provider-neutral `NormalizedInboundMessage`. Graph
 * exposes exactly one body, whichever the message carried; the reply/bounce consumers and the
 * materializer already fall back across text/html, so nothing is lost by leaving the other side
 * null rather than inventing a conversion. Attachment BYTES are never read here — only the
 * metadata descriptor (id/name/mime/size/inline/contentId) — so nothing binary reaches Postgres.
 */
import type { OutreachProviderAttachment } from '@/db/schema'
import {
    graphProviderMessageId,
    normalizeMessageId,
    type NormalizedInboundMessage,
} from '../../outreach-inbound'
import type { OutlookGraphMessage } from '../../outlook'
import { MAX_HEADER_VALUE_LENGTH, truncate } from './shared'

/** Cap on retained headers so a long Received chain cannot write kilobytes per event. */
const MAX_RETAINED_HEADERS = 100

/**
 * Keep ALL headers (bounded), not a fixed subset: the delta response is the only view of the
 * message we will ever have, and the classifier needs Content-Type (DSN), Auto-Submitted /
 * Precedence (auto-reply) and In-Reply-To / References (threading). `sanitizeHeaders` narrows to
 * the allow-list at materialization, so retaining the full bounded set here matches native.
 */
function graphHeaderRecord(message: OutlookGraphMessage): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const header of (message.internetMessageHeaders ?? []).slice(0, MAX_RETAINED_HEADERS)) {
        if (!header?.name) continue
        headers[header.name.toLowerCase()] = String(header.value ?? '').slice(0, MAX_HEADER_VALUE_LENGTH)
    }
    return headers
}

function graphAddresses(
    recipients: Array<{ emailAddress?: { address?: string | null } | null }> | null | undefined,
): string[] {
    return (recipients ?? [])
        .map((entry) => entry?.emailAddress?.address ?? '')
        .filter((address): address is string => Boolean(address))
}

/**
 * Projects a Graph delta message into the shared normalized event shape. Returns null for a
 * message with no usable identity (the reader already drops tombstones and drafts).
 */
export function outlookEventFromGraphMessage(message: OutlookGraphMessage): NormalizedInboundMessage | null {
    if (!message?.id) return null

    const headers = graphHeaderRecord(message)
    const isHtml = (message.body?.contentType ?? '').toLowerCase() === 'html'
    const content = message.body?.content ?? null

    const textBody = isHtml ? null : truncate(content)
    const htmlBody = isHtml ? truncate(content) : null

    const receivedMs = message.receivedDateTime ? Date.parse(message.receivedDateTime) : NaN

    return {
        provider: 'outlook',
        providerMessageId: graphProviderMessageId({
            messageId: message.internetMessageId ?? null,
            graphId: message.id,
        }),
        messageId: normalizeMessageId(message.internetMessageId),
        inReplyTo: headers['in-reply-to'] ?? null,
        references: headers['references'] ?? null,
        fromAddress: message.from?.emailAddress?.address ?? null,
        toAddresses: graphAddresses(message.toRecipients),
        ccAddresses: graphAddresses(message.ccRecipients),
        subject: message.subject ?? null,
        textBody,
        htmlBody,
        headers,
        attachments: (message.attachments ?? []).map((attachment) => {
            const normalized: OutreachProviderAttachment = {
                providerId: attachment.id ? String(attachment.id) : null,
                name: attachment.name ? String(attachment.name) : null,
                mimeType: attachment.contentType ? String(attachment.contentType) : null,
                size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
                inline: Boolean(attachment.isInline),
                contentId: attachment.contentId ? String(attachment.contentId) : null,
            }
            return normalized
        }),
        receivedAt: Number.isFinite(receivedMs) ? new Date(receivedMs) : new Date(),
    }
}
