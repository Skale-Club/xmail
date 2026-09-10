import { Router, Request, Response } from 'express'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import Imap from 'imap'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../../../db'
import { mailboxes, mailFolders, mailMessages, contacts, INBOX_ATTACHMENTS_BUCKET } from '../../../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { decryptSecret } from '../../lib/crypto'
import { checkUserMailboxAccess } from './mailboxes'
import { createMultipartEmail, MultipartAttachment } from '../../lib/html-to-text'
import { findLocalUser } from '../../lib/native-mail'
import { processInboundEmail, deliverViaRoutes } from '../../lib/route-matcher'
import { relayMessage, storeMessage } from '../../lib/native-send'
import { jsonbParam } from '../../lib/jsonb'
import { allocateUidForNewMessage } from '../../lib/move-messages'
import { sanitizeAttachmentFilename, InboxAttachmentError } from '../../lib/inbox-attachments'
import { createObjectStorage } from '../../lib/object-storage'
// nodemailer's own RFC 2047 header-word encoder — used so the manually-built native raw
// email matches what nodemailer does automatically for the external-relay path below.
import { encodeWords } from 'nodemailer/lib/mime-funcs'
import { createHash } from 'node:crypto'

const router = Router()

// Decoded attachment bytes, not the base64 wire size — this bounds the same content the
// 10MB express.json() body limit (src/server/index.ts) is meant to cap; a request under
// that ceiling can still decode to less than this, so it is a second, content-level check.
const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024

// Every header value below is already validated by the Zod schemas (`.regex(NO_CRLF)`)
// before it reaches here. These two helpers are a second, defense-in-depth layer applied
// at the point the raw RFC822 headers are actually assembled, so a future schema change
// (or a caller that bypasses Zod) can never reintroduce header injection via embedded
// CR/LF in a subject, display name, In-Reply-To or References value.
const NO_CRLF = /^[^\r\n]*$/

/** Strip any CR/LF that slipped through validation. Never wrap in RFC 2047 — used for
 * tokens (Message-ID references) that must stay literal, not for display names/subjects. */
function stripCrlf(value: string): string {
    return value.replace(/[\r\n]+/g, ' ')
}

/**
 * RFC 2047-encode a header value if it contains non-ASCII or otherwise unsafe characters,
 * matching what nodemailer does automatically for header values it builds (the external
 * SMTP relay path below, via `transporter.sendMail`). The native path builds its raw
 * RFC822 text by hand, so without this a non-ASCII subject or display name would go out
 * unencoded — this keeps both paths byte-for-byte consistent for the same input.
 */
function encodeHeaderValue(value: string): string {
    return encodeWords(stripCrlf(value))
}

interface DecodedAttachment {
    filename: string
    contentType: string
    buffer: Buffer
    /** sha256 of `buffer`, computed once at decode time — see `hashBuffer`. */
    contentHash: string
}

interface StoredAttachment {
    filename: string
    contentType: string
    size: number
    storageKey: string
    /** sha256 of the decoded bytes at upload time. Lets a later save/send recognize an
     * attachment came back byte-identical and reuse the existing `storageKey` instead of
     * re-uploading — see `uploadMailAttachments`'s `reuseFrom` param. Optional because rows
     * written before this field existed won't have it (they just never match). */
    contentHash?: string
}

function hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Uploads each attachment under a path scoped to the DESTINATION mailbox
 * (`mail-attachments/<mailboxId>/<messageUuid>/<index>-<filename>`). Native sends fan
 * out to the Sent copy plus one INBOX copy per local recipient, each a distinct
 * mailbox, so this is called once per destination — the download route's
 * `checkUserMailboxAccess` scoping then needs no cross-mailbox sharing to reason about.
 *
 * `reuseFrom` (default none) is a set of previously-stored attachments scoped to this SAME
 * mailbox — e.g. the draft this send/save originated from. When a decoded attachment's
 * content hash matches one of them, its `storageKey` is reused verbatim and the byte upload
 * is skipped; this is what keeps repeat draft autosaves (and a draft's eventual send) from
 * re-uploading files that haven't changed. Never pass another mailbox's attachments here —
 * reuse must stay within the mailbox that already owns the object.
 */
async function uploadMailAttachments(
    mailboxId: string,
    messageUuid: string,
    attachments: DecodedAttachment[],
    reuseFrom: StoredAttachment[] = [],
): Promise<StoredAttachment[]> {
    if (attachments.length === 0) return []
    const storage = createObjectStorage()
    const stored: StoredAttachment[] = []
    for (let index = 0; index < attachments.length; index++) {
        const attachment = attachments[index]
        const reusable = reuseFrom.find(existing => existing.contentHash === attachment.contentHash)
        if (reusable) {
            stored.push(reusable)
            continue
        }
        const storageKey = `mail-attachments/${mailboxId}/${messageUuid}/${index}-${attachment.filename}`
        await storage.upload(INBOX_ATTACHMENTS_BUCKET, storageKey, attachment.buffer, attachment.contentType, { upsert: true })
        stored.push({
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.buffer.length,
            storageKey,
            contentHash: attachment.contentHash,
        })
    }
    return stored
}

async function appendToSentFolder(
    mailbox: any,
    rawEmail: string
): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
        const imapConfig = {
            user: mailbox.imapUsername,
            password: decryptSecret(mailbox.imapPasswordEncrypted),
            host: mailbox.imapHost,
            port: mailbox.imapPort,
            tls: mailbox.imapSecure,
            tlsOptions: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
        }

        const imap = new Imap(imapConfig)

        imap.once('ready', () => {
            imap.append(rawEmail, { mailbox: 'Sent' }, (err: any) => {
                imap.end()
                if (err) {
                    resolve({ success: false, error: err.message })
                } else {
                    resolve({ success: true })
                }
            })
        })

        imap.once('error', (err: any) => {
            resolve({ success: false, error: err.message })
        })

        imap.connect()
    })
}

router.post('/:mailboxId/send', async (req: Request, res: Response) => {
    const startTime = Date.now()
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const isNative = mailbox.isNative === true

        // Every field here can end up interpolated into a raw RFC822 header line (Subject,
        // From/To/Cc display name, In-Reply-To, References). Without the no-CRLF regex a
        // caller could smuggle extra headers (e.g. an extra "Bcc:" line) into the outgoing
        // message by embedding \r\n in any of these strings — Zod's max-length check alone
        // does not catch that.
        const noHeaderInjection = z.string().regex(NO_CRLF, 'must not contain line breaks')
        const schema = z.object({
            to: z.array(z.object({
                address: z.string().email(),
                name: noHeaderInjection.optional(),
            })).min(1),
            cc: z.array(z.object({
                address: z.string().email(),
                name: noHeaderInjection.optional(),
            })).optional(),
            bcc: z.array(z.object({
                address: z.string().email(),
                name: noHeaderInjection.optional(),
            })).optional(),
            subject: z.string().min(1).max(998).regex(NO_CRLF, 'must not contain line breaks'),
            plainBody: z.string().optional(),
            htmlBody: z.string().optional(),
            inReplyTo: noHeaderInjection.optional(),
            references: noHeaderInjection.optional(),
            attachments: z.array(z.object({
                filename: z.string(),
                content: z.string(),
                contentType: z.string().optional(),
            })).optional(),
            saveToSent: z.boolean().default(true),
            // Optional: the draft this send originated from. When set (and it resolves to a
            // real draft owned by this same mailbox), byte-identical attachments reuse that
            // draft's already-uploaded storage objects instead of being re-uploaded — see
            // `uploadMailAttachments`'s `reuseFrom` param below.
            draftId: z.string().uuid().optional(),
        })

        const data = schema.parse(req.body)

        if (!data.plainBody && !data.htmlBody) {
            return res.status(400).json({ error: 'Message body is required' })
        }

        // Sanitize filenames and decode base64 up front so every downstream use (MIME
        // build, nodemailer, object storage) sees the same bytes and the same name.
        let decodedAttachments: DecodedAttachment[]
        try {
            decodedAttachments = (data.attachments ?? []).map(att => {
                const buffer = Buffer.from(att.content, 'base64')
                return {
                    filename: sanitizeAttachmentFilename(att.filename),
                    contentType: att.contentType || 'application/octet-stream',
                    buffer,
                    contentHash: hashBuffer(buffer),
                }
            })
        } catch (attachmentError) {
            if (attachmentError instanceof InboxAttachmentError) {
                return res.status(attachmentError.status).json({ error: attachmentError.message })
            }
            throw attachmentError
        }

        const totalAttachmentBytes = decodedAttachments.reduce((sum, att) => sum + att.buffer.length, 0)
        if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
            return res.status(413).json({ error: `Attachments exceed the ${MAX_ATTACHMENT_TOTAL_BYTES}-byte total limit` })
        }

        // Scoped to this same mailbox on purpose — `uploadMailAttachments`'s reuse-by-hash
        // must never cross mailboxes. Only feeds the Sent-folder upload below, never the
        // per-recipient INBOX uploads (those target other mailboxes entirely).
        const sourceDraft = data.draftId
            ? await db.query.mailMessages.findFirst({
                where: and(
                    eq(mailMessages.id, data.draftId),
                    eq(mailMessages.mailboxId, mailboxId),
                    eq(mailMessages.isDraft, true)
                ),
                columns: { attachments: true },
            })
            : null
        const draftAttachments = ((sourceDraft?.attachments as StoredAttachment[] | null) || [])

        const allRecipients = [
            ...data.to.map(t => t.address),
            ...(data.cc?.map(c => c.address) || []),
            ...(data.bcc?.map(b => b.address) || []),
        ]

        console.log(`[Send] from=${mailbox.email} native=${isNative} to=[${allRecipients.join(',')}] subject="${data.subject.substring(0, 50)}"`)

        // messageUuid also grounds the attachment storage key — it is server-generated
        // (never taken from caller-controlled headers), so it is always safe as a path
        // component.
        const messageUuid = uuidv4()
        const messageId = `<${messageUuid}@${mailbox.email.split('@')[1] || 'mail.local'}>`
        const fromAddress = mailbox.displayName
            ? `${mailbox.displayName} <${mailbox.email}>`
            : mailbox.email
        // Used only where we hand-build raw RFC822 header text ourselves (below). nodemailer
        // does its own RFC 2047 encoding when we pass it `fromAddress` directly, so that one
        // stays unencoded — pre-encoding it there would make nodemailer double-encode it.
        const fromHeaderValue = mailbox.displayName
            ? `${encodeHeaderValue(mailbox.displayName)} <${mailbox.email}>`
            : mailbox.email

        const mimeAttachments: MultipartAttachment[] = decodedAttachments.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            content: att.buffer,
        }))

        const baseMessageData = {
            messageId,
            inReplyTo: data.inReplyTo,
            references: data.references,
            subject: data.subject,
            fromAddress: mailbox.email,
            fromName: mailbox.displayName || null,
            toAddresses: data.to.map(t => ({ name: t.name || null, address: t.address })),
            ccAddresses: data.cc?.map(c => ({ name: c.name || null, address: c.address })) || [],
            bccAddresses: data.bcc?.map(b => ({ name: b.name || null, address: b.address })) || [],
            plainBody: data.plainBody,
            htmlBody: data.htmlBody,
        }

        let localDelivered = 0
        let externalRelayed = 0

        if (isNative) {
            // Native mailbox: bypass SMTP server, do direct delivery
            // 1. Build raw email for relay (attachments become real MIME parts, not
            // just metadata — this is the buffer that goes out over the wire).
            const { headers: contentHeaders, body: contentBody } = createMultipartEmail(data.plainBody, data.htmlBody, mimeAttachments)

            const toHeader = data.to.map(t => t.name ? `${encodeHeaderValue(t.name)} <${t.address}>` : t.address).join(', ')
            const ccHeader = data.cc?.map(c => c.name ? `${encodeHeaderValue(c.name)} <${c.address}>` : c.address).join(', ')

            const rawEmailParts = [
                `From: ${fromHeaderValue}`,
                `To: ${toHeader}`,
                ccHeader ? `Cc: ${ccHeader}` : '',
                `Subject: ${encodeHeaderValue(data.subject)}`,
                `Date: ${new Date().toUTCString()}`,
                `Message-ID: ${messageId}`,
                data.inReplyTo ? `In-Reply-To: ${stripCrlf(data.inReplyTo)}` : '',
                data.references ? `References: ${stripCrlf(data.references)}` : '',
                ...contentHeaders,
                contentBody,
            ].filter(Boolean).join('\r\n')
            const rawEmailBuffer = Buffer.from(rawEmailParts)

            // 2. Store in sender's Sent folder (attachment bytes uploaded under this
            // mailbox's own storage key so the download route's per-mailbox access
            // check is sufficient authorization).
            if (data.saveToSent) {
                const sentAttachments = await uploadMailAttachments(mailboxId, messageUuid, decodedAttachments, draftAttachments)
                await storeMessage(mailboxId, 'sent', {
                    ...baseMessageData,
                    hasAttachments: sentAttachments.length > 0,
                    attachments: sentAttachments,
                }, true)
            }

            // 3. Separate local vs external recipients
            const localRecipients: Array<{ email: string; userId: string }> = []
            const externalRecipients: string[] = []

            for (const addr of allRecipients) {
                const recipientUserId = await findLocalUser(addr)
                if (recipientUserId) {
                    localRecipients.push({ email: addr, userId: recipientUserId.userId })
                    console.log(`[Send] ${addr} → LOCAL (userId=${recipientUserId.userId})`)
                } else {
                    externalRecipients.push(addr)
                    console.log(`[Send] ${addr} → EXTERNAL`)
                }
            }

            // 4. Deliver to local recipients (store directly in their INBOX). Each
            // recipient is a different mailbox, so attachments are uploaded again
            // under that mailbox's own key rather than shared across tenants.
            for (const { email: recipientEmail, userId: recipientUserId } of localRecipients) {
                const recipientMailbox = await db.query.mailboxes.findFirst({
                    where: and(
                        eq(mailboxes.email, recipientEmail.toLowerCase()),
                        eq(mailboxes.userId, recipientUserId)
                    ),
                })
                if (recipientMailbox) {
                    const recipientAttachments = await uploadMailAttachments(recipientMailbox.id, messageUuid, decodedAttachments)
                    await storeMessage(recipientMailbox.id, 'inbox', {
                        ...baseMessageData,
                        hasAttachments: recipientAttachments.length > 0,
                        attachments: recipientAttachments,
                    }, false)
                    localDelivered++
                    console.log(`[Send] Local delivery to ${recipientEmail}: stored in inbox`)
                } else {
                    console.warn(`[Send] Local delivery to ${recipientEmail}: NO MAILBOX FOUND`)
                }
            }

            // 5. Relay external recipients
            if (externalRecipients.length > 0) {
                console.log(`[Send] Relaying to ${externalRecipients.length} external recipient(s)...`)
                try {
                    const routedRecipients: string[] = []
                    const directRelayRecipients: string[] = []

                    for (const addr of externalRecipients) {
                        const routing = await processInboundEmail(addr)
                        if (routing.action === 'reject') {
                            console.log(`[Send] ${addr} → REJECTED by route`)
                            continue
                        }
                        if (routing.action !== 'none' && routing.routes.length > 0) {
                            routedRecipients.push(addr)
                            await deliverViaRoutes(addr, rawEmailBuffer, routing.routes, routing.organizationId!)
                            externalRelayed++
                            console.log(`[Send] ${addr} → ROUTED via ${routing.routes.length} route(s)`)
                        } else {
                            directRelayRecipients.push(addr)
                            console.log(`[Send] ${addr} → DIRECT RELAY (no routes)`)
                        }
                    }

                    if (directRelayRecipients.length > 0) {
                        await relayMessage(mailbox.email, directRelayRecipients, rawEmailBuffer)
                        externalRelayed += directRelayRecipients.length
                        console.log(`[Send] Direct relay completed for ${directRelayRecipients.length} recipient(s)`)
                    }
                } catch (relayErr) {
                    console.error('[Send] Relay FAILED:', relayErr)
                }
            }
        } else {
            // External mailbox: send via user's SMTP credentials
            const transporter = nodemailer.createTransport({
                host: mailbox.smtpHost,
                port: mailbox.smtpPort,
                secure: mailbox.smtpSecure,
                auth: {
                    user: mailbox.smtpUsername,
                    pass: decryptSecret(mailbox.smtpPasswordEncrypted),
                },
            })

            await transporter.sendMail({
                from: fromAddress,
                to: data.to.map(t => t.address),
                cc: data.cc?.map(c => c.address),
                bcc: data.bcc?.map(b => b.address),
                subject: data.subject,
                text: data.plainBody,
                html: data.htmlBody,
                messageId,
                inReplyTo: data.inReplyTo,
                references: data.references,
                attachments: decodedAttachments.map(att => ({
                    filename: att.filename,
                    content: att.buffer,
                    contentType: att.contentType,
                })),
            })

            // Store in Sent folder + append to remote IMAP Sent
            if (data.saveToSent) {
                const sentAttachments = await uploadMailAttachments(mailboxId, messageUuid, decodedAttachments, draftAttachments)
                await storeMessage(mailboxId, 'sent', {
                    ...baseMessageData,
                    hasAttachments: sentAttachments.length > 0,
                    attachments: sentAttachments,
                }, true)

                const { headers: contentHeaders, body: contentBody } = createMultipartEmail(data.plainBody, data.htmlBody, mimeAttachments)

                const toHeader = data.to.map(t => t.name ? `${encodeHeaderValue(t.name)} <${t.address}>` : t.address).join(', ')
                const ccHeader = data.cc?.map(c => c.name ? `${encodeHeaderValue(c.name)} <${c.address}>` : c.address).join(', ')

                const rawEmail = [
                    `From: ${fromHeaderValue}`,
                    `To: ${toHeader}`,
                    ccHeader ? `Cc: ${ccHeader}` : '',
                    `Subject: ${encodeHeaderValue(data.subject)}`,
                    `Date: ${new Date().toUTCString()}`,
                    `Message-ID: ${messageId}`,
                    data.inReplyTo ? `In-Reply-To: ${stripCrlf(data.inReplyTo)}` : '',
                    data.references ? `References: ${stripCrlf(data.references)}` : '',
                    ...contentHeaders,
                    contentBody,
                ].filter(Boolean).join('\r\n')

                const appendResult = await appendToSentFolder(mailbox, rawEmail)
                if (!appendResult.success) {
                    console.warn('Failed to append to IMAP Sent folder:', appendResult.error)
                }
            }
        }

        // Contact sync is secondary. It should never turn a successful send into a visible failure.
        try {
            const recipientEntries = [
                ...data.to,
                ...(data.cc || []),
                ...(data.bcc || []),
            ]

            for (const recipient of recipientEntries) {
                const nameParts = recipient.name?.split(' ') || []
                const firstName = nameParts[0] || null
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null

                await db.insert(contacts).values({
                    userId,
                    email: recipient.address.toLowerCase(),
                    firstName,
                    lastName,
                    company: null,
                    emailedCount: 1,
                    lastEmailedAt: new Date(),
                }).onConflictDoUpdate({
                    target: [contacts.userId, contacts.email],
                    set: {
                        emailedCount: sql`${contacts.emailedCount} + 1`,
                        lastEmailedAt: new Date(),
                        updatedAt: new Date(),
                    },
                })
            }
        } catch (contactSyncError) {
            console.warn('[Send] Contact sync skipped:', contactSyncError instanceof Error ? contactSyncError.message : contactSyncError)
        }

        const duration = Date.now() - startTime
        console.log(`[Send] Completed in ${duration}ms — local=${localDelivered} external=${externalRelayed}`)

        res.json({
            success: true,
            messageId,
            message: 'Email sent successfully',
            delivery: {
                sentFolder: data.saveToSent,
                localDelivered,
                externalRelayed,
            }
        })

    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('[Send] Error:', error)
        res.status(500).json({ error: 'Failed to send email' })
    }
})

router.post('/:mailboxId/save-draft', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        // A draft is stored as structured data today, but it becomes raw RFC822 header text
        // the moment it is sent (via the send route above) or appended to a remote Sent
        // folder, so it needs the same no-CRLF guard as the send schema — see the comment
        // there for why max-length alone is not enough.
        const draftRecipientSchema = z.object({
            address: z.string().trim().min(1).regex(NO_CRLF, 'must not contain line breaks'),
            name: z.string().trim().regex(NO_CRLF, 'must not contain line breaks').optional(),
        })

        const schema = z.object({
            to: z.array(draftRecipientSchema).optional(),
            cc: z.array(draftRecipientSchema).optional(),
            bcc: z.array(draftRecipientSchema).optional(),
            subject: z.string().regex(NO_CRLF, 'must not contain line breaks').optional(),
            plainBody: z.string().optional(),
            htmlBody: z.string().optional(),
            draftId: z.string().uuid().optional(),
            attachments: z.array(z.object({
                filename: z.string(),
                content: z.string(),
                contentType: z.string().optional(),
            })).optional(),
        })

        const data = schema.parse(req.body)

        // Sanitize filenames and decode base64 up front, same as the send route — every
        // downstream use (hashing, object storage) must see the same bytes and name.
        let decodedAttachments: DecodedAttachment[]
        try {
            decodedAttachments = (data.attachments ?? []).map(att => {
                const buffer = Buffer.from(att.content, 'base64')
                return {
                    filename: sanitizeAttachmentFilename(att.filename),
                    contentType: att.contentType || 'application/octet-stream',
                    buffer,
                    contentHash: hashBuffer(buffer),
                }
            })
        } catch (attachmentError) {
            if (attachmentError instanceof InboxAttachmentError) {
                return res.status(attachmentError.status).json({ error: attachmentError.message })
            }
            throw attachmentError
        }

        const totalAttachmentBytes = decodedAttachments.reduce((sum, att) => sum + att.buffer.length, 0)
        if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
            return res.status(413).json({ error: `Attachments exceed the ${MAX_ATTACHMENT_TOTAL_BYTES}-byte total limit` })
        }

        let draftsFolder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, mailboxId),
                eq(mailFolders.remoteId, 'Drafts')
            ),
        })

        if (!draftsFolder) {
            const [createdDraftsFolder] = await db.insert(mailFolders).values({
                mailboxId,
                remoteId: 'Drafts',
                name: 'Drafts',
                type: 'drafts',
                unreadCount: 0,
                totalCount: 0,
            }).returning()

            draftsFolder = createdDraftsFolder
        }

        const normalizedTo = data.to?.map(t => ({ name: t.name || null, address: t.address.trim() })) || []
        const normalizedCc = data.cc?.map(c => ({ name: c.name || null, address: c.address.trim() })) || []
        const normalizedBcc = data.bcc?.map(b => ({ name: b.name || null, address: b.address.trim() })) || []

        const existingDraft = data.draftId
            ? await db.query.mailMessages.findFirst({
                where: and(
                    eq(mailMessages.id, data.draftId),
                    eq(mailMessages.mailboxId, mailboxId),
                    eq(mailMessages.isDraft, true)
                ),
            })
            : null

        // Fixed up front (rather than left to the DB's default) because it doubles as the
        // object-storage key prefix below, so uploads for a brand-new draft land under the
        // same id the row is about to be inserted with.
        const draftId = existingDraft?.id || uuidv4()
        const existingAttachments = ((existingDraft?.attachments as StoredAttachment[] | null) || [])
        // Bytes actually persisted this time — this is the fix for the bug where drafts only
        // ever stored {filename, contentType, size} and the real attachment content was
        // silently dropped. Byte-identical attachments (matched by content hash) reuse the
        // existing draft's storageKey instead of re-uploading, which is what keeps repeated
        // autosaves of an unchanged attachment cheap.
        const normalizedAttachments = await uploadMailAttachments(mailboxId, `draft-${draftId}`, decodedAttachments, existingAttachments)

        const messageId = existingDraft?.messageId || `<${uuidv4()}@${mailbox.email.split('@')[1] || 'mail.local'}>`
        let savedMessage

        if (existingDraft) {
            [savedMessage] = await db.update(mailMessages).set({
                folderId: draftsFolder.id,
                messageId,
                subject: data.subject || null,
                fromAddress: mailbox.email,
                fromName: mailbox.displayName,
                // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação.
                toAddresses: jsonbParam(normalizedTo),
                ccAddresses: jsonbParam(normalizedCc),
                bccAddresses: jsonbParam(normalizedBcc),
                plainBody: data.plainBody,
                htmlBody: data.htmlBody,
                headers: jsonbParam({}),
                hasAttachments: normalizedAttachments.length > 0,
                attachments: jsonbParam(normalizedAttachments),
                isDraft: true,
                remoteDate: new Date(),
                receivedAt: existingDraft.receivedAt || new Date(),
                updatedAt: new Date(),
            }).where(eq(mailMessages.id, existingDraft.id)).returning()
        } else {
            // A draft is served over IMAP like any other message, so it needs a
            // folder-scoped UID — a NULL one is unaddressable by UID EXPUNGE.
            const draftUid = await allocateUidForNewMessage(mailboxId, draftsFolder.id)

            // TODO(mail-attachments cleanup): when a draft with uploaded attachments is
            // permanently deleted, nothing removes its objects from object storage. The
            // delete path is DELETE /:mailboxId/messages/:messageId in
            // src/server/routes/mail/messages.ts, which calls deleteMessagesPermanently()
            // in src/server/lib/move-messages.ts once a message leaves Trash — neither file
            // is in scope for this change (see the MAIL-SERVER task's file allowlist), and
            // the same gap already exists for every other message type's attachments, not
            // just drafts'. A fix belongs in deleteMessagesPermanently(): read each doomed
            // row's `attachments[].storageKey` before the DB delete and call
            // createObjectStorage().delete(INBOX_ATTACHMENTS_BUCKET, storageKey) for each.
            ;[savedMessage] = await db.insert(mailMessages).values({
                id: draftId,
                mailboxId,
                folderId: draftsFolder.id,
                messageId,
                subject: data.subject || null,
                fromAddress: mailbox.email,
                fromName: mailbox.displayName,
                // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação.
                toAddresses: jsonbParam(normalizedTo),
                ccAddresses: jsonbParam(normalizedCc),
                bccAddresses: jsonbParam(normalizedBcc),
                plainBody: data.plainBody,
                htmlBody: data.htmlBody,
                headers: jsonbParam({}),
                hasAttachments: normalizedAttachments.length > 0,
                attachments: jsonbParam(normalizedAttachments),
                isDraft: true,
                remoteUid: draftUid,
                remoteDate: new Date(),
                receivedAt: new Date(),
            }).returning()
        }

        res.json({
            success: true,
            messageId,
            draftId: savedMessage.id,
            message: 'Draft saved',
        })

    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error saving draft:', error)
        res.status(500).json({ error: 'Failed to save draft' })
    }
})

export default router
