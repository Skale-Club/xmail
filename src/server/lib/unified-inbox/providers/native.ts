/**
 * Native provider adapter (Phase 21 UIF-02).
 *
 * Maps an already-parsed native `mail_messages` row onto the shared provider-neutral
 * `NormalizedInboundMessage`. Native mail is stored with full bodies, headers, and attachment
 * descriptors already, so this is a pure field projection — attachment BYTES are never touched
 * (only id/name/mime/size/inline/contentId), so nothing binary flows toward Postgres.
 */
import type { OutreachProviderAttachment } from '@/db/schema'
import {
    nativeProviderMessageId,
    normalizeMessageId,
    type NormalizedInboundMessage,
} from '../../outreach-inbound'
import { addressList, truncate } from './shared'

/** The subset of a `mail_messages` row the native adapter reads. */
export interface NativeMailRow {
    id: string
    messageId: string | null
    inReplyTo: string | null
    references: string | null
    fromAddress: string | null
    toAddresses: unknown
    ccAddresses: unknown
    subject: string | null
    plainBody: string | null
    htmlBody: string | null
    headers: unknown
    attachments: unknown
    receivedAt: Date | null
    createdAt: Date
}

/** Projects one native mailbox row into the shared normalized event shape. */
export function nativeEventFromMailRow(row: NativeMailRow): NormalizedInboundMessage {
    const headers = (row.headers as Record<string, string> | null) ?? {}
    const attachments = ((row.attachments as unknown[] | null) ?? []).map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>
        const attachment: OutreachProviderAttachment = {
            providerId: item.id ? String(item.id) : null,
            name: item.filename ? String(item.filename) : null,
            mimeType: item.contentType ? String(item.contentType) : null,
            size: Number.isFinite(Number(item.size)) ? Number(item.size) : null,
            inline: item.contentDisposition === 'inline' || Boolean(item.cid),
            contentId: item.cid ? String(item.cid) : null,
        }
        return attachment
    })

    return {
        provider: 'native',
        providerMessageId: nativeProviderMessageId(row.id),
        messageId: normalizeMessageId(row.messageId),
        inReplyTo: row.inReplyTo,
        references: row.references,
        fromAddress: row.fromAddress,
        toAddresses: addressList(row.toAddresses),
        ccAddresses: addressList(row.ccAddresses),
        subject: row.subject,
        textBody: truncate(row.plainBody),
        htmlBody: truncate(row.htmlBody),
        headers,
        attachments,
        receivedAt: row.receivedAt ?? row.createdAt,
    }
}
