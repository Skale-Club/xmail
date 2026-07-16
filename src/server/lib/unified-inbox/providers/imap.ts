/**
 * IMAP provider adapter (Phase 21 UIF-02).
 *
 * Maps a fully parsed raw MIME message (`mailparser` ParsedMail, fetched for one bounded UID
 * batch) onto the shared provider-neutral `NormalizedInboundMessage`.
 *
 * Field parity with native/Graph: the Phase 19 IMAP path retained only a fixed 6-header subset,
 * so a materialized IMAP message was missing the Subject/Date/Message-ID/From/To/... that
 * native and Graph messages carried. This adapter extracts the FULL safe-header allow-list from
 * the raw header lines, so the retained header set matches the other providers. Attachment
 * BYTES are never read here — only the metadata descriptor — so nothing binary reaches Postgres.
 */
import type { ParsedMail } from 'mailparser'
import type { OutreachProviderAttachment } from '@/db/schema'
import {
    imapProviderMessageId,
    normalizeMessageId,
    type NormalizedInboundMessage,
} from '../../outreach-inbound'
import { SAFE_HEADER_ALLOW_LIST } from '../normalize'
import { MAX_HEADER_VALUE_LENGTH, truncate } from './shared'

/**
 * Extracts the safe-header allow-list from the raw header lines, lower-cased so the shared
 * classifier and `sanitizeHeaders` see the same keys the native/Graph paths produce.
 */
export function imapSafeHeaders(parsed: ParsedMail): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const headerLine of parsed.headerLines ?? []) {
        const key = headerLine.key.toLowerCase()
        if (!SAFE_HEADER_ALLOW_LIST.has(key) || headers[key] !== undefined) continue
        const separator = headerLine.line.indexOf(':')
        const value = separator >= 0 ? headerLine.line.slice(separator + 1).trim() : ''
        if (value) headers[key] = value.slice(0, MAX_HEADER_VALUE_LENGTH)
    }
    // mailparser exposes the structured content type separately; ensure it is always present.
    if (!headers['content-type']) {
        const contentType = parsed.headers?.get('content-type')
        if (contentType) headers['content-type'] = String(contentType).slice(0, MAX_HEADER_VALUE_LENGTH)
    }
    return headers
}

function addressesOf(field: ParsedMail['to']): string[] {
    if (!field) return []
    if (Array.isArray(field)) {
        return field.flatMap((entry) => entry.value.map((address) => address.address ?? '')).filter(Boolean)
    }
    return field.value.map((address) => address.address ?? '').filter(Boolean)
}

/** Projects a parsed raw MIME message into the shared normalized event shape. */
export function imapEventFromParsedMail(
    parsed: ParsedMail,
    uid: number,
    uidValidity: number,
): NormalizedInboundMessage {
    const references = Array.isArray(parsed.references)
        ? parsed.references.join(' ')
        : (parsed.references ?? null)

    return {
        provider: 'smtp',
        providerMessageId: imapProviderMessageId({
            messageId: parsed.messageId ?? null,
            uidValidity,
            uid,
        }),
        messageId: normalizeMessageId(parsed.messageId),
        inReplyTo: parsed.inReplyTo ?? null,
        references,
        fromAddress: parsed.from?.value?.[0]?.address ?? null,
        toAddresses: addressesOf(parsed.to),
        ccAddresses: addressesOf(parsed.cc),
        subject: parsed.subject ?? null,
        textBody: truncate(parsed.text),
        htmlBody: truncate(typeof parsed.html === 'string' ? parsed.html : null),
        headers: imapSafeHeaders(parsed),
        attachments: (parsed.attachments ?? []).map((attachment) => {
            const normalized: OutreachProviderAttachment = {
                providerId: attachment.checksum ?? null,
                name: attachment.filename ?? null,
                mimeType: attachment.contentType ?? null,
                size: attachment.size ?? null,
                inline: attachment.contentDisposition === 'inline' || Boolean(attachment.cid),
                contentId: attachment.cid ?? null,
            }
            return normalized
        }),
        receivedAt: parsed.date ?? new Date(),
    }
}
