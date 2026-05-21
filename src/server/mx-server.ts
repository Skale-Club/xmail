/**
 * Inbound MX receiver.
 *
 * Listens on MX_PORT (default 25 in prod, 2525 in dev) for unauthenticated
 * inbound mail from the public internet. Only accepts recipients that are:
 *   - local native mailbox users (stored in the DB, delivered to INBOX), or
 *   - recipients matched by an org's inbound route (processed via route-matcher).
 *
 * All other recipients are rejected at RCPT TO. This prevents this server
 * from being used as an open relay.
 *
 * Disabled by default; enable with ENABLE_MX_RECEIVER=true.
 */

import { SMTPServer } from 'smtp-server'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../db'
import { mailboxes, mailFolders, mailMessages, messages } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { parseRawEmail } from './lib/mail'
import { findLocalUser } from './lib/native-mail'
import { processInboundEmail, type MatchedRoute } from './lib/route-matcher'
import { getMailTLSOptions } from './lib/mail-tls'
import { emitFolderChange } from './lib/mail-events'
import { allocateNextUid, recomputeFolderCounts } from './lib/folder-counts'
import { incrementStat } from './lib/tracking'
import { verifyInbound, sealWithAuthHeader } from './lib/mail-auth'
import {
    checkConnectRate,
    isSpamhausListed,
    shouldGreylist,
    hasValidFromHeader,
    isDateTooOld,
} from './lib/mx-guard'

async function storeInbound(
    mailboxId: string,
    parsed: Awaited<ReturnType<typeof parseRawEmail>>,
    opts: { isSpam?: boolean } = {},
) {
    const targetType = opts.isSpam ? 'spam' : 'inbox'
    const folder = await db.query.mailFolders.findFirst({
        where: and(
            eq(mailFolders.mailboxId, mailboxId),
            eq(mailFolders.type, targetType),
        ),
    })
    if (!folder) {
        console.error(`[MX] ${targetType.toUpperCase()} folder not found for mailbox ${mailboxId}`)
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
        isRead: false,
        isDraft: false,
        remoteUid: assignedUid,
        remoteDate: parsed.date,
        receivedAt: parsed.date || new Date(),
    }).onConflictDoNothing()

    await recomputeFolderCounts(folder.id)
    emitFolderChange({ folderId: folder.id, mailboxId, kind: 'new' })
}

async function deliverViaRoutes(
    recipient: string,
    rawEmail: Buffer,
    matchedRoutes: MatchedRoute[],
    organizationId: string,
): Promise<void> {
    for (const { route, endpoint } of matchedRoutes) {
        if (endpoint.type === 'hold') {
            await db.insert(messages).values({
                organizationId,
                token: uuidv4(),
                direction: 'incoming',
                fromAddress: '',
                toAddresses: [recipient],
                subject: '(held)',
                status: 'held',
                held: true,
                holdExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                heldReason: `Route: ${route.name}`,
            }).onConflictDoNothing()
            await incrementStat(organizationId, 'messagesHeld')
            continue
        }

        if (endpoint.type === 'http' && endpoint.config) {
            const cfg = endpoint.config as { url: string; method?: string; headers?: Record<string, string>; includeOriginal?: boolean }
            const body = cfg.includeOriginal
                ? { recipient, raw: rawEmail.toString('base64') }
                : { recipient }
            await fetch(cfg.url, {
                method: cfg.method || 'POST',
                headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            }).catch((err) => console.error('[MX] HTTP route error:', err?.message))
        }
        // Other endpoint types (smtp, address) require outbound auth; skip in MX.
    }
}

export function createMXServer() {
    const port = parseInt(process.env.MX_PORT || (process.env.NODE_ENV === 'production' ? '25' : '2525'))
    const tlsOpts = getMailTLSOptions()

    const server = new SMTPServer({
        name: process.env.MAIL_DOMAIN || 'skaleclub.mail',
        banner: `${process.env.MAIL_DOMAIN || 'skaleclub.mail'} ESMTP`,
        authOptional: true,
        hidePIPELINING: false,
        hideSTARTTLS: !tlsOpts,
        key: tlsOpts?.key,
        cert: tlsOpts?.cert,
        size: 25 * 1024 * 1024,
        maxClients: 200,
        disableReverseLookup: false,

        async onConnect(session, callback) {
            const ip = session.remoteAddress || 'unknown'

            if (!checkConnectRate(ip)) {
                console.log(`[MX] Rate-limited: ${ip}`)
                return callback(new Error('421 4.7.0 Too many connections from your IP'))
            }

            if (await isSpamhausListed(ip)) {
                console.log(`[MX] Spamhaus-listed IP rejected: ${ip}`)
                return callback(new Error('554 5.7.1 Blacklisted by Spamhaus'))
            }

            callback()
        },

        async onRcptTo(address, session, callback) {
            const rcpt = address.address
            const ip = session.remoteAddress || 'unknown'
            const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : ''

            try {
                const localUser = await findLocalUser(rcpt)
                const hasRoute = localUser
                    ? true
                    : await (async () => {
                        const r = await processInboundEmail(rcpt)
                        if (r.action === 'reject') return 'reject' as const
                        return r.action !== 'none' && r.routes.length > 0
                    })()

                if (hasRoute === 'reject') {
                    return callback(new Error('550 5.1.1 Recipient rejected by policy'))
                }
                if (!hasRoute) {
                    return callback(new Error('550 5.1.1 User unknown in virtual mailbox table'))
                }

                // Greylist new (ip, from, to) triples. Legit MTAs retry; most bots don't.
                if (shouldGreylist(ip, from, rcpt)) {
                    console.log(`[MX] Greylisted: ${ip} ${from} -> ${rcpt}`)
                    return callback(new Error('451 4.7.1 Greylisted; please retry in 5 minutes'))
                }

                callback()
            } catch (err) {
                console.error('[MX] onRcptTo error:', err)
                callback(new Error('451 4.3.0 Temporary failure'))
            }
        },

        onData(stream, session, callback) {
            const chunks: Buffer[] = []
            let totalSize = 0
            stream.on('data', (chunk: Buffer) => {
                totalSize += chunk.length
                chunks.push(chunk)
            })
            stream.on('end', async () => {
                const raw = Buffer.concat(chunks)
                try {
                    // Authenticate (SPF/DKIM/DMARC) before any header parsing
                    const ip = session.remoteAddress || '0.0.0.0'
                    const helo = session.hostNameAppearsAs || 'unknown'
                    const sender = session.envelope.mailFrom ? session.envelope.mailFrom.address : ''
                    const rcpts = session.envelope.rcptTo.map(r => r.address)

                    const auth = await verifyInbound(raw, { ip, helo, sender, recipients: rcpts })

                    if (auth?.verdict === 'reject') {
                        console.log(`[MX] AUTH REJECT ${sender} -> ${rcpts.join(',')}: ${auth.reason}`)
                        return callback(new Error('550 5.7.1 DMARC policy violation'))
                    }

                    const sealed = auth ? sealWithAuthHeader(raw, auth.headers) : raw
                    const isSpam = auth?.verdict === 'quarantine'

                    const parsed = await parseRawEmail(sealed)

                    // Basic header sanity
                    if (!hasValidFromHeader(parsed)) {
                        return callback(new Error('550 5.6.0 Missing or invalid From header'))
                    }
                    if (isDateTooOld(parsed)) {
                        return callback(new Error('550 5.6.0 Message Date header older than 30 days'))
                    }

                    for (const rcpt of rcpts) {
                        const localUser = await findLocalUser(rcpt)
                        if (localUser) {
                            const companion = await db.query.mailboxes.findFirst({
                                where: and(
                                    eq(mailboxes.email, rcpt.toLowerCase()),
                                    eq(mailboxes.userId, localUser.userId),
                                ),
                            })
                            if (companion) {
                                await storeInbound(companion.id, parsed, { isSpam })
                                const tag = isSpam ? 'SPAM' : 'INBOX'
                                console.log(`[MX] Delivered to ${tag}: ${rcpt} (${totalSize}B) spf=${auth?.spfPass} dkim=${auth?.dkimPass} dmarc=${auth?.dmarcPass}`)
                            }
                            continue
                        }

                        const routing = await processInboundEmail(rcpt)
                        if (routing.action !== 'none' && routing.routes.length > 0 && routing.organizationId) {
                            await deliverViaRoutes(rcpt, sealed, routing.routes, routing.organizationId)
                            console.log(`[MX] Routed: ${rcpt}`)
                        }
                    }

                    callback()
                } catch (err) {
                    console.error('[MX] Processing error:', err)
                    callback(new Error('451 4.3.0 Temporary failure, try again later'))
                }
            })
            stream.on('error', (err: Error) => {
                console.error('[MX] Stream error:', err)
                callback(err)
            })
        },
    })

    server.on('error', (err: Error) => {
        console.error('[MX] Server error:', err.message)
    })

    return {
        start() {
            server.listen(port, '0.0.0.0', () => {
                const mode = tlsOpts ? 'plaintext + STARTTLS' : 'plaintext only (dev)'
                console.log(`[MX] Inbound MX receiver listening on port ${port} — ${mode}`)
            })
        },
        close(): Promise<void> {
            return new Promise((resolve) => server.close(() => resolve()))
        },
    }
}
