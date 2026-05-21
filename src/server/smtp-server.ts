/**
 * Native SMTP Submission Server
 *
 * Listens on SMTP_SUBMISSION_PORT (default 2587 for dev, 587 for prod).
 * Authenticated users can submit email for delivery.
 *
 * Auth: PLAIN/LOGIN against users.passwordHash (bcrypt) — same password as web login.
 */

import { SMTPServer } from 'smtp-server'
import nodemailer from 'nodemailer'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db'
import { mailboxes, mailFolders, mailMessages } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { parseRawEmail } from './lib/mail'
import { authenticateNativeUser, findLocalUser } from './lib/native-mail'
import { processInboundEmail, deliverViaRoutes, type MatchedRoute } from './lib/route-matcher'
import { getMailTLSOptions } from './lib/mail-tls'
import { isIpLocked, recordAuthFailure, clearAuthFailures } from './lib/auth-throttle'
import { emitFolderChange } from './lib/mail-events'
import { allocateNextUid, recomputeFolderCounts } from './lib/folder-counts'
import { getDkimConfigForEmail, toNodemailerDkim } from './lib/dkim'

// Find the companion mailboxes entry (for folder/message storage)
async function getCompanionMailbox(email: string, userId: string) {
    return db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.email, email.toLowerCase()),
            eq(mailboxes.userId, userId)
        ),
    })
}

// Store a message in the given folder type for the mailbox
async function storeMessage(
    mailboxId: string,
    folderType: string,
    parsed: Awaited<ReturnType<typeof parseRawEmail>>,
    isRead = false
) {
    const folder = await db.query.mailFolders.findFirst({
        where: and(
            eq(mailFolders.mailboxId, mailboxId),
            eq(mailFolders.type, folderType)
        ),
    })

    if (!folder) {
        console.error(`[SMTP] Folder type '${folderType}' not found for mailboxId: ${mailboxId}`)
        return
    }

    const messageId = parsed.messageId || `<${uuidv4()}@skaleclub.mail>`
    const assignedUid = await allocateNextUid(folder.id)

    await db.insert(mailMessages).values({
        mailboxId,
        folderId: folder.id,
        messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        subject: parsed.subject,
        fromAddress: parsed.from.address,
        fromName: parsed.from.name,
        toAddresses: parsed.to as object[],
        ccAddresses: parsed.cc as object[],
        bccAddresses: parsed.bcc as object[],
        plainBody: parsed.plainBody,
        htmlBody: parsed.htmlBody,
        headers: parsed.headers as object,
        hasAttachments: parsed.hasAttachments,
        attachments: parsed.attachments.map(a => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
        })) as object[],
        isRead,
        isDraft: false,
        remoteUid: assignedUid,
        remoteDate: parsed.date,
        receivedAt: parsed.date || new Date(),
    }).onConflictDoNothing()

    await recomputeFolderCounts(folder.id)
    emitFolderChange({ folderId: folder.id, mailboxId, kind: 'new' })
}

// Relay outbound email through configured SMTP relay or direct
async function relayMessage(
    fromAddress: string,
    toAddresses: string[],
    rawEmail: Buffer
): Promise<void> {
    // DKIM signing config (per-sender-domain). Falls through to unsigned if
    // the domain has no key or isn't registered.
    const dkimConfig = await getDkimConfigForEmail(fromAddress)
    const dkim = dkimConfig ? toNodemailerDkim(dkimConfig) : undefined
    if (dkim) {
        console.log(`[SMTP:Relay] DKIM enabled: selector=${dkim.keySelector} domain=${dkim.domainName}`)
    } else {
        console.warn(`[SMTP:Relay] ⚠️  No DKIM key for ${fromAddress} — message will be unsigned`)
    }

    // Use system SMTP relay if configured, otherwise try direct delivery
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        console.log(`[SMTP:Relay] Using SMTP relay: host=${process.env.SMTP_HOST} port=${process.env.SMTP_PORT || '587'} user=${process.env.SMTP_USER}`)
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            dkim,
        })

        const info = await transporter.sendMail({
            envelope: { from: fromAddress, to: toAddresses },
            raw: rawEmail,
        })
        console.log(`[SMTP:Relay] SUCCESS:`, info.response || info.messageId)
    } else {
        console.log(`[SMTP:Relay] ⚠️  NO SMTP_HOST/SMTP_USER — attempting DIRECT delivery from=${fromAddress} to=[${toAddresses.join(', ')}]`)
        // Direct delivery (requires proper MX setup)
        const transporter = nodemailer.createTransport({
            direct: true,
            name: process.env.MAIL_DOMAIN || 'localhost',
            dkim,
        } as nodemailer.TransportOptions)

        try {
            const info = await transporter.sendMail({
                envelope: { from: fromAddress, to: toAddresses },
                raw: rawEmail,
            })
            console.log(`[SMTP:Relay] Direct delivery SUCCESS:`, info.response || info.messageId)
        } catch (directErr) {
            console.error(`[SMTP:Relay] Direct delivery FAILED:`, directErr)
            throw directErr
        }
    }
}

// Check if an address is a local (native) user on this server
async function isLocalAddress(email: string): Promise<string | null> {
    const result = await findLocalUser(email)
    return result ? result.userId : null
}

export function createSMTPServer() {
    const port = parseInt(process.env.SMTP_SUBMISSION_PORT || '2587')
    const tlsOpts = getMailTLSOptions()

    const server = new SMTPServer({
        name: process.env.MAIL_DOMAIN || 'skaleclub.mail',
        // Implicit TLS only when binding to port 465; on 587 we offer STARTTLS
        // when certs are present, otherwise plaintext (dev mode).
        secure: port === 465 && !!tlsOpts,
        key: tlsOpts?.key,
        cert: tlsOpts?.cert,
        // Offer STARTTLS upgrade when certs present; force plaintext only when absent.
        hideSTARTTLS: !tlsOpts,
        // In prod (certs present), refuse plaintext AUTH. In dev (no certs), allow it.
        allowInsecureAuth: !tlsOpts,
        authOptional: false,
        size: 25 * 1024 * 1024, // 25 MB max message size

        onConnect(session, callback) {
            const ip = session.remoteAddress || 'unknown'
            if (isIpLocked(ip)) {
                return callback(new Error('Too many failed auth attempts from this IP, try again later'))
            }
            callback()
        },

        onAuth(auth, session, callback) {
            const ip = session.remoteAddress || 'unknown'
            if (isIpLocked(ip)) {
                return callback(new Error('Too many failed attempts'))
            }

            const username = auth.username?.toLowerCase()
            const password = auth.password

            if (!username || !password) {
                recordAuthFailure(ip)
                return callback(new Error('Username and password required'))
            }

            authenticateNativeUser(username, password)
                .then(account => {
                    if (!account) {
                        recordAuthFailure(ip)
                        return callback(new Error('Invalid credentials'))
                    }
                    clearAuthFailures(ip)
                    console.log(`[SMTP] Auth ok: ${username} (ip=${ip} tls=${session.secure})`)
                    callback(null, { user: JSON.stringify({ email: account.email, userId: account.id }) })
                })
                .catch(err => {
                    recordAuthFailure(ip)
                    console.error('[SMTP] Auth error:', err)
                    callback(new Error('Authentication failed'))
                })
        },

        onData(stream, session, callback) {
            const chunks: Buffer[] = []

            stream.on('data', (chunk: Buffer) => chunks.push(chunk))

            stream.on('end', async () => {
                const raw = Buffer.concat(chunks)
                const userStr = session.user as string | undefined

                if (!userStr) {
                    return callback(new Error('Unauthenticated'))
                }

                const user = JSON.parse(userStr) as { email: string; userId: string }
                try {
                    const parsed = await parseRawEmail(raw)
                    const senderEmail = user.email

                    // Get sender's companion mailbox for Sent storage
                    const senderMailbox = await getCompanionMailbox(senderEmail, user.userId)
                    if (senderMailbox) {
                        await storeMessage(senderMailbox.id, 'sent', parsed, true)
                        console.log(`[SMTP] Saved to Sent: ${senderEmail} → ${parsed.to.map(t => t.address).join(', ')}`)
                    }

                    // Determine recipient list from envelope
                    const rcptAddresses = session.envelope.rcptTo.map(r => r.address)

                    // Separate local vs external recipients
                    const localRecipients: Array<{ email: string; userId: string }> = []
                    const externalRecipients: string[] = []

                    for (const addr of rcptAddresses) {
                        const recipientUserId = await isLocalAddress(addr)
                        if (recipientUserId) {
                            localRecipients.push({ email: addr, userId: recipientUserId })
                        } else {
                            externalRecipients.push(addr)
                        }
                    }

                    // Deliver to local recipients (store directly in DB)
                    for (const { email: recipientEmail, userId: recipientUserId } of localRecipients) {
                        const recipientMailbox = await getCompanionMailbox(recipientEmail, recipientUserId)
                        if (recipientMailbox) {
                            await storeMessage(recipientMailbox.id, 'inbox', parsed, false)
                            console.log(`[SMTP] Local delivery: ${senderEmail} → ${recipientEmail}`)
                        }
                    }

                    // Relay external recipients
                    if (externalRecipients.length > 0) {
                        try {
                            // Check for route-based delivery for each external recipient
                            const routedRecipients: string[] = []
                            const directRelayRecipients: string[] = []

                            for (const addr of externalRecipients) {
                                const routing = await processInboundEmail(addr)
                                if (routing.action === 'reject') {
                                    console.log(`[SMTP] Rejected by route: ${addr}`)
                                    continue
                                }
                                if (routing.action !== 'none' && routing.routes.length > 0) {
                                    routedRecipients.push(addr)
                                    await deliverViaRoutes(addr, raw, routing.routes, routing.organizationId!)
                                } else {
                                    directRelayRecipients.push(addr)
                                }
                            }

                            if (directRelayRecipients.length > 0) {
                                await relayMessage(senderEmail, directRelayRecipients, raw)
                                console.log(`[SMTP] Relayed: ${senderEmail} → ${directRelayRecipients.join(', ')}`)
                            }

                            if (routedRecipients.length > 0) {
                                console.log(`[SMTP] Route-delivered: ${senderEmail} → ${routedRecipients.join(', ')}`)
                            }
                        } catch (relayErr) {
                            console.error('[SMTP] Relay error:', relayErr)
                            // Don't fail the whole transaction if relay fails
                        }
                    }

                    callback()
                } catch (error) {
                    console.error('[SMTP] Processing error:', error)
                    callback(new Error('Failed to process message'))
                }
            })

            stream.on('error', (err: Error) => {
                console.error('[SMTP] Stream error:', err)
                callback(err)
            })
        },
    })

    server.on('error', (err: Error) => {
        console.error('[SMTP] Server error:', err.message)
    })

    return {
        start() {
            server.listen(port, '0.0.0.0', () => {
                const mode = port === 465 && tlsOpts
                    ? 'implicit TLS (SMTPS)'
                    : tlsOpts
                        ? 'plaintext + STARTTLS'
                        : 'plaintext only (dev)'
                console.log(`[SMTP] Submission server listening on port ${port} — ${mode}`)
            })
        },
        close(): Promise<void> {
            return new Promise((resolve) => {
                server.close(() => resolve())
            })
        },
    }
}
