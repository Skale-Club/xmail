/**
 * Native SMTP Submission Server
 *
 * Listens on SMTP_SUBMISSION_PORT (default 2587 for dev, 587 for prod).
 * Authenticated users can submit email for delivery.
 *
 * Auth: PLAIN/LOGIN against users.passwordHash (bcrypt) — same password as web login.
 */

import { SMTPServer } from 'smtp-server'
import { v4 as uuidv4 } from 'uuid'
import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { mailboxes, mailFolders, mailMessages, INBOX_ATTACHMENTS_BUCKET } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { parseRawEmail } from './lib/mail'
import { authenticateNativeUser, findLocalUser } from './lib/native-mail'
import { processInboundEmail, deliverViaRoutes } from './lib/route-matcher'
import { getMailTLSOptions } from './lib/mail-tls'
import { isIpLocked, recordAuthFailure, clearAuthFailures } from './lib/auth-throttle'
import { emitFolderChange } from './lib/mail-events'
import { allocateNextUid, recomputeFolderCounts } from './lib/folder-counts'
import { getDkimConfigForEmail, toNodemailerDkim } from './lib/dkim'
import { shouldSkipOwnDkimForRelay } from './lib/relay-dkim-policy'
import { describeOutbound, describeSendFailure, isRelayConfigured, sendOutbound } from './lib/outbound-transport'
import { signAndSelfVerify } from './lib/dkim-self-verify'
import { jsonbParam } from './lib/jsonb'
import { sanitizeAttachmentFilename } from './lib/inbox-attachments'
import { createObjectStorage } from './lib/object-storage'
import { createLogger } from './lib/logger'

const log = createLogger('smtp.submission')

/** Mirrors mx-server.ts's helper of the same shape: smtp-server reads `err.responseCode`
 * off the callback's error (falling back to a per-command default — 450 for a DATA-stage
 * error) to pick the SMTP status line it sends the client. */
function smtpError(message: string, responseCode: number): Error {
    const err = new Error(message) as Error & { responseCode?: number }
    err.responseCode = responseCode
    return err
}

/**
 * Uploads attachment bytes under a key scoped to the destination mailbox
 * (`mail-attachments/<mailboxId>/<groupId>/<index>-<filename>`) and returns the metadata
 * shape stored in `mail_messages.attachments`. Mirrors mx-server.ts's helper of the same
 * shape; kept local since the two servers already duplicate storeMessage/storeInbound
 * rather than share it. A per-attachment failure never blocks storing the message.
 */
async function persistSubmissionAttachments(
    mailboxId: string,
    groupId: string,
    attachments: Awaited<ReturnType<typeof parseRawEmail>>['attachments'],
): Promise<Array<{ filename: string; contentType: string; size: number; storageKey?: string }>> {
    if (attachments.length === 0) return []
    const storage = createObjectStorage()
    return Promise.all(attachments.map(async (attachment, index) => {
        const base = { filename: attachment.filename, contentType: attachment.contentType, size: attachment.size }
        try {
            const filename = sanitizeAttachmentFilename(attachment.filename || `attachment-${index}`)
            const storageKey = `mail-attachments/${mailboxId}/${groupId}/${index}-${filename}`
            await storage.upload(INBOX_ATTACHMENTS_BUCKET, storageKey, attachment.content, attachment.contentType || 'application/octet-stream', { upsert: true })
            return { ...base, storageKey }
        } catch (err) {
            console.error(`[SMTP] Failed to persist attachment "${attachment.filename}":`, err)
            return base
        }
    }))
}

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
    // Server-generated grouping id for the attachment storage path — parsed.messageId
    // is not trustworthy here (submission clients can put anything in it) and must
    // never be used as a path component.
    const attachmentGroupId = randomUUID()
    const storedAttachments = await persistSubmissionAttachments(mailboxId, attachmentGroupId, parsed.attachments)

    await db.insert(mailMessages).values({
        mailboxId,
        folderId: folder.id,
        messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        subject: parsed.subject,
        fromAddress: parsed.from.address,
        fromName: parsed.from.name,
        // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação do pooler.
        toAddresses: jsonbParam(parsed.to ?? []),
        ccAddresses: jsonbParam(parsed.cc ?? []),
        bccAddresses: jsonbParam(parsed.bcc ?? []),
        plainBody: parsed.plainBody,
        htmlBody: parsed.htmlBody,
        headers: jsonbParam(parsed.headers ?? {}),
        hasAttachments: parsed.hasAttachments,
        attachments: jsonbParam(storedAttachments),
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
    // DKIM signing config (per-sender-domain). Falls through to unsigned if the domain has no
    // key or isn't registered. Skipped when the relay rewrites the body (see
    // shouldSkipOwnDkimForRelay) — the relay signs on its own and ours would fail the body hash.
    const skipOwnDkim = isRelayConfigured() && shouldSkipOwnDkimForRelay(process.env.SMTP_HOST)
    const dkimConfig = skipOwnDkim ? null : await getDkimConfigForEmail(fromAddress)
    const dkim = dkimConfig ? toNodemailerDkim(dkimConfig) : undefined
    if (skipOwnDkim) {
        console.log(`[SMTP:Relay] Own DKIM skipped: relay ${process.env.SMTP_HOST} rewrites the body and signs on its own (NATIVE_DKIM_SIGN=always to override)`)
    } else if (!dkim) {
        console.warn(`[SMTP:Relay] ⚠️  No DKIM key for ${fromAddress} — message will be unsigned`)
    }

    // Fase 2 (docs/outbound-authentication-audit.md): this used to log "DKIM enabled:
    // selector=... domain=..." as soon as a key was found — before the message was signed,
    // let alone verified. That line recorded INTENT, and production showed it for all 11
    // domains while 11.4% of native mail to Gmail still landed in spam. signAndSelfVerify
    // signs with the same Nodemailer DKIM signer the transport would otherwise use, then
    // verifies the exact result with mailauth's dkimVerify — mirrors native-send.ts's
    // relayMessage, the other half of this same DKIM-signing duplication.
    const selfCheck = await signAndSelfVerify(rawEmail, dkim)
    if (!selfCheck.verified) {
        console.error(`[SMTP:Relay] DKIM self-verification FAILED for ${fromAddress} (domain=${dkim?.domainName} selector=${dkim?.keySelector}): ${selfCheck.reason}`)
        throw new Error(`DKIM self-verification failed for ${fromAddress}: ${selfCheck.reason}`)
    }
    if (dkim) {
        console.log(`[SMTP:Relay] DKIM verified: d=${dkim.domainName} s=${dkim.keySelector} — ${selfCheck.reason}`)
    }

    console.log(`[SMTP:Relay] Using ${describeOutbound()} from=${fromAddress} to=[${toAddresses.join(', ')}]`)
    try {
        // dkim is intentionally NOT passed to sendOutbound: selfCheck.raw already carries our
        // signature (or is unsigned-by-design when dkim was undefined) — passing dkim again
        // would sign it a second time.
        const result = await sendOutbound(
            { envelope: { from: fromAddress, to: toAddresses }, raw: selfCheck.raw },
            toAddresses,
        )
        console.log(`[SMTP:Relay] SUCCESS via ${result.via}:`, result.response)
    } catch (sendErr) {
        console.error(`[SMTP:Relay] FAILED (${describeSendFailure(sendErr)}) via ${describeOutbound()}:`, sendErr)
        throw sendErr
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

                    // SEC (587 submission): this path runs no SPF/DKIM/DMARC on the client-supplied
                    // message, so its From address is not trustworthy for local storage or display.
                    // Force the stored/delivered From to the authenticated sender (display name kept)
                    // so an authenticated user cannot drop a message into another tenant's inbox that
                    // appears to come from someone else. Legitimate sends already match, so this is a
                    // no-op for them; it does not touch the raw bytes relayed externally.
                    if (parsed.from.address?.toLowerCase() !== senderEmail.toLowerCase()) {
                        parsed.from.address = senderEmail
                    }

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

                    // Relay external recipients. Recipients whose route delivery or direct
                    // relay actually throws are tracked separately from ones a route
                    // deliberately rejected (`routing.action === 'reject'` — a policy decision,
                    // not a failure).
                    const failedExternalRecipients: string[] = []

                    if (externalRecipients.length > 0) {
                        // Check for route-based delivery for each external recipient
                        const routedRecipients: string[] = []
                        const directRelayRecipients: string[] = []

                        for (const addr of externalRecipients) {
                            try {
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
                            } catch (routeErr) {
                                console.error(`[SMTP] Route delivery failed for ${addr}:`, routeErr)
                                failedExternalRecipients.push(addr)
                            }
                        }

                        if (directRelayRecipients.length > 0) {
                            try {
                                await relayMessage(senderEmail, directRelayRecipients, raw)
                                console.log(`[SMTP] Relayed: ${senderEmail} → ${directRelayRecipients.join(', ')}`)
                            } catch (relayErr) {
                                console.error('[SMTP] Direct relay failed:', relayErr)
                                failedExternalRecipients.push(...directRelayRecipients)
                            }
                        }

                        if (routedRecipients.length > 0) {
                            console.log(`[SMTP] Route-delivered: ${senderEmail} → ${routedRecipients.join(', ')}`)
                        }
                    }

                    if (failedExternalRecipients.length > 0) {
                        const storedLocally = localRecipients.length > 0
                        if (!storedLocally) {
                            // Nothing about this message was ever persisted — a 250 here would
                            // tell the submitting client its mail was accepted when every
                            // recipient's delivery actually failed. Respond 4xx so a compliant
                            // client queues a retry instead of treating the message as sent.
                            log.error({ action: 'smtp.submission.relay_failed', sender: senderEmail, failedRecipients: failedExternalRecipients, storedLocally }, 'Relay failed for every recipient; rejecting with 451 so the client retries')
                            return callback(smtpError('451 4.4.1 delivery failed, try again later', 451))
                        }
                        // Stored locally for at least one recipient — the submission overall
                        // succeeded from the client's point of view, so keep the 250, but this
                        // must not disappear into a console.error a human never greps for.
                        log.error({ action: 'smtp.submission.relay_failed', sender: senderEmail, failedRecipients: failedExternalRecipients, storedLocally }, 'Relay failed for some recipients after local delivery succeeded')
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

    // Same rotation strategy as mx-server.ts: getMailTLSOptions() reloads from disk on
    // mtime change (throttled to 60s in mail-tls.ts), and updateSecureContext() is
    // smtp-server's supported way to push a new cert into a running server without
    // dropping existing connections. Only relevant when TLS was available at boot —
    // hideSTARTTLS/secure are both fixed at construction time.
    let tlsRotationInterval: NodeJS.Timeout | null = null
    if (tlsOpts) {
        tlsRotationInterval = setInterval(() => {
            const latest = getMailTLSOptions()
            if (latest) {
                server.updateSecureContext({ key: latest.key, cert: latest.cert })
            }
        }, 60_000)
        tlsRotationInterval.unref()
    }

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
            if (tlsRotationInterval) clearInterval(tlsRotationInterval)
            return new Promise((resolve) => {
                server.close(() => resolve())
            })
        },
    }
}
