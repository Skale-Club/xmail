import { Router, Request, Response } from 'express'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import Imap from 'imap'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../../../db'
import { mailboxes, mailFolders, mailMessages, contacts } from '../../../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { decryptSecret } from '../../lib/crypto'
import { checkUserMailboxAccess } from './mailboxes'
import { createMultipartEmail } from '../../lib/html-to-text'
import { findLocalUser } from '../../lib/native-mail'
import { processInboundEmail, deliverViaRoutes } from '../../lib/route-matcher'
import { relayMessage, storeMessage } from '../../lib/native-send'
import { jsonbParam } from '../../lib/jsonb'

const router = Router()

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

        const schema = z.object({
            to: z.array(z.object({
                address: z.string().email(),
                name: z.string().optional(),
            })).min(1),
            cc: z.array(z.object({
                address: z.string().email(),
                name: z.string().optional(),
            })).optional(),
            bcc: z.array(z.object({
                address: z.string().email(),
                name: z.string().optional(),
            })).optional(),
            subject: z.string().min(1).max(998),
            plainBody: z.string().optional(),
            htmlBody: z.string().optional(),
            inReplyTo: z.string().optional(),
            references: z.string().optional(),
            attachments: z.array(z.object({
                filename: z.string(),
                content: z.string(),
                contentType: z.string().optional(),
            })).optional(),
            saveToSent: z.boolean().default(true),
        })

        const data = schema.parse(req.body)

        if (!data.plainBody && !data.htmlBody) {
            return res.status(400).json({ error: 'Message body is required' })
        }

        const allRecipients = [
            ...data.to.map(t => t.address),
            ...(data.cc?.map(c => c.address) || []),
            ...(data.bcc?.map(b => b.address) || []),
        ]

        console.log(`[Send] from=${mailbox.email} native=${isNative} to=[${allRecipients.join(',')}] subject="${data.subject.substring(0, 50)}"`)

        const messageId = `<${uuidv4()}@${mailbox.email.split('@')[1] || 'mail.local'}>`
        const fromAddress = mailbox.displayName
            ? `${mailbox.displayName} <${mailbox.email}>`
            : mailbox.email

        const messageData = {
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
            hasAttachments: (data.attachments?.length || 0) > 0,
            attachments: data.attachments?.map(att => ({
                filename: att.filename,
                contentType: att.contentType || 'application/octet-stream',
                size: Math.ceil(att.content.length * 0.75),
            })) || [],
        }

        let localDelivered = 0
        let externalRelayed = 0

        if (isNative) {
            // Native mailbox: bypass SMTP server, do direct delivery
            // 1. Build raw email for relay
            const { headers: contentHeaders, body: contentBody } = createMultipartEmail(data.plainBody, data.htmlBody)

            const toHeader = data.to.map(t => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')
            const ccHeader = data.cc?.map(c => c.name ? `${c.name} <${c.address}>` : c.address).join(', ')

            const rawEmailParts = [
                `From: ${fromAddress}`,
                `To: ${toHeader}`,
                ccHeader ? `Cc: ${ccHeader}` : '',
                `Subject: ${data.subject}`,
                `Date: ${new Date().toUTCString()}`,
                `Message-ID: ${messageId}`,
                data.inReplyTo ? `In-Reply-To: ${data.inReplyTo}` : '',
                data.references ? `References: ${data.references}` : '',
                ...contentHeaders,
                contentBody,
            ].filter(Boolean).join('\r\n')
            const rawEmailBuffer = Buffer.from(rawEmailParts)

            // 2. Store in sender's Sent folder
            if (data.saveToSent) {
                await storeMessage(mailboxId, 'sent', messageData, true)
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

            // 4. Deliver to local recipients (store directly in their INBOX)
            for (const { email: recipientEmail, userId: recipientUserId } of localRecipients) {
                const recipientMailbox = await db.query.mailboxes.findFirst({
                    where: and(
                        eq(mailboxes.email, recipientEmail.toLowerCase()),
                        eq(mailboxes.userId, recipientUserId)
                    ),
                })
                if (recipientMailbox) {
                    await storeMessage(recipientMailbox.id, 'inbox', messageData, false)
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
                attachments: data.attachments?.map(att => ({
                    filename: att.filename,
                    content: Buffer.from(att.content, 'base64'),
                    contentType: att.contentType,
                })),
            })

            // Store in Sent folder + append to remote IMAP Sent
            if (data.saveToSent) {
                await storeMessage(mailboxId, 'sent', messageData, true)

                const { headers: contentHeaders, body: contentBody } = createMultipartEmail(data.plainBody, data.htmlBody)

                const toHeader = data.to.map(t => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')
                const ccHeader = data.cc?.map(c => c.name ? `${c.name} <${c.address}>` : c.address).join(', ')

                const rawEmail = [
                    `From: ${fromAddress}`,
                    `To: ${toHeader}`,
                    ccHeader ? `Cc: ${ccHeader}` : '',
                    `Subject: ${data.subject}`,
                    `Date: ${new Date().toUTCString()}`,
                    `Message-ID: ${messageId}`,
                    data.inReplyTo ? `In-Reply-To: ${data.inReplyTo}` : '',
                    data.references ? `References: ${data.references}` : '',
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

        const draftRecipientSchema = z.object({
            address: z.string().trim().min(1),
            name: z.string().trim().optional(),
        })

        const schema = z.object({
            to: z.array(draftRecipientSchema).optional(),
            cc: z.array(draftRecipientSchema).optional(),
            bcc: z.array(draftRecipientSchema).optional(),
            subject: z.string().optional(),
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
        const normalizedAttachments = data.attachments?.map(att => ({
            filename: att.filename,
            contentType: att.contentType || 'application/octet-stream',
            size: Math.ceil(att.content.length * 0.75),
        })) || []

        const existingDraft = data.draftId
            ? await db.query.mailMessages.findFirst({
                where: and(
                    eq(mailMessages.id, data.draftId),
                    eq(mailMessages.mailboxId, mailboxId),
                    eq(mailMessages.isDraft, true)
                ),
            })
            : null

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
            [savedMessage] = await db.insert(mailMessages).values({
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
