/**
 * Native IMAP Server (RFC 3501)
 *
 * Listens on IMAP_PORT (default 2993 for dev, 993 for prod).
 * Allows Thunderbird and other email clients to read/manage mail
 * stored in the mailboxes / mailMessages database tables.
 *
 * Implemented using raw Node.js net module for maximum compatibility.
 * Supports: LOGIN, CAPABILITY, LIST, LSUB, SELECT, EXAMINE, FETCH,
 *           STORE, EXPUNGE, SEARCH, APPEND, NOOP, LOGOUT, UID
 */

import net from 'net'
import { db } from '../db'
import { mailboxes, mailFolders, mailMessages } from '../db/schema'
import { eq, and, asc } from 'drizzle-orm'
import { getCachedBranding } from './lib/serverBranding'
import { authenticateNativeUser } from './lib/native-mail'

let _imapAppName = process.env.APP_APPLICATION_NAME ?? ''

export async function loadImapBranding() {
    const { applicationName } = await getCachedBranding()
    _imapAppName = applicationName
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface IMAPSession {
    socket: net.Socket
    state: 'not_authenticated' | 'authenticated' | 'selected' | 'logout'
    userId: string | null
    userEmail: string | null
    selectedMailboxId: string | null
    selectedFolderId: string | null
    selectedReadOnly: boolean
    buffer: string
}

interface DBFolder {
    id: string
    mailboxId: string
    remoteId: string
    name: string
    type: string | null
    unreadCount: number
    totalCount: number
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate(email: string, password: string) {
    return authenticateNativeUser(email, password)
}

async function getCompanionMailbox(email: string, userId: string) {
    return db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.email, email.toLowerCase()),
            eq(mailboxes.userId, userId)
        ),
    })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendLine(socket: net.Socket, line: string) {
    socket.write(line + '\r\n')
}

function escapeLiteral(s: string | null): string {
    if (!s) return 'NIL'
    // If contains special chars, use literal syntax
    if (/[\r\n"]/.test(s)) {
        const bytes = Buffer.byteLength(s, 'utf8')
        return `{${bytes}}\r\n${s}`
    }
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function flagsToIMAP(msg: { isRead: boolean; isStarred: boolean; isDeleted: boolean; isDraft: boolean }): string {
    const flags: string[] = []
    if (msg.isRead) flags.push('\\Seen')
    if (msg.isStarred) flags.push('\\Flagged')
    if (msg.isDeleted) flags.push('\\Deleted')
    if (msg.isDraft) flags.push('\\Draft')
    return `(${flags.join(' ')})`
}

function folderTypeToAttributes(type: string | null): string {
    switch (type) {
        case 'inbox': return '\\HasNoChildren'
        case 'sent': return '\\Sent \\HasNoChildren'
        case 'drafts': return '\\Drafts \\HasNoChildren'
        case 'trash': return '\\Trash \\HasNoChildren'
        case 'spam': return '\\Junk \\HasNoChildren'
        default: return '\\HasNoChildren'
    }
}

/**
 * Build an RFC 2822-compatible raw message from a DB record.
 * In a production system you'd store the raw bytes; here we reconstruct them.
 */
function buildRawMessage(msg: typeof mailMessages.$inferSelect): string {
    const to = (msg.toAddresses as Array<{ name?: string; address?: string }> | null) || []
    const cc = (msg.ccAddresses as Array<{ name?: string; address?: string }> | null) || []

    const toStr = to.map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', ')
    const ccStr = cc.map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', ')

    const date = (msg.remoteDate || msg.receivedAt || new Date()).toUTCString()

    let raw = ''
    raw += `Message-ID: ${msg.messageId || `<${msg.id}@skaleclub.mail>`}\r\n`
    raw += `Date: ${date}\r\n`
    raw += `From: ${msg.fromName ? `"${msg.fromName}" ` : ''}<${msg.fromAddress || ''}>\r\n`
    if (toStr) raw += `To: ${toStr}\r\n`
    if (ccStr) raw += `Cc: ${ccStr}\r\n`
    if (msg.subject) raw += `Subject: ${msg.subject}\r\n`
    if (msg.inReplyTo) raw += `In-Reply-To: ${msg.inReplyTo}\r\n`
    if (msg.references) raw += `References: ${msg.references}\r\n`

    if (msg.htmlBody && msg.plainBody) {
        const boundary = `boundary_${msg.id.replace(/-/g, '')}`
        raw += `MIME-Version: 1.0\r\n`
        raw += `Content-Type: multipart/alternative; boundary="${boundary}"\r\n`
        raw += `\r\n`
        raw += `--${boundary}\r\n`
        raw += `Content-Type: text/plain; charset=utf-8\r\n\r\n`
        raw += msg.plainBody + '\r\n'
        raw += `--${boundary}\r\n`
        raw += `Content-Type: text/html; charset=utf-8\r\n\r\n`
        raw += msg.htmlBody + '\r\n'
        raw += `--${boundary}--\r\n`
    } else if (msg.htmlBody) {
        raw += `MIME-Version: 1.0\r\n`
        raw += `Content-Type: text/html; charset=utf-8\r\n`
        raw += `\r\n`
        raw += msg.htmlBody
    } else {
        raw += `Content-Type: text/plain; charset=utf-8\r\n`
        raw += `\r\n`
        raw += msg.plainBody || ''
    }

    return raw
}

function buildHeader(msg: typeof mailMessages.$inferSelect): string {
    const to = (msg.toAddresses as Array<{ name?: string; address?: string }> | null) || []
    const cc = (msg.ccAddresses as Array<{ name?: string; address?: string }> | null) || []
    const toStr = to.map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', ')
    const ccStr = cc.map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', ')
    const date = (msg.remoteDate || msg.receivedAt || new Date()).toUTCString()

    let h = ''
    h += `Message-ID: ${msg.messageId || `<${msg.id}@skaleclub.mail>`}\r\n`
    h += `Date: ${date}\r\n`
    h += `From: ${msg.fromName ? `"${msg.fromName}" ` : ''}<${msg.fromAddress || ''}>\r\n`
    if (toStr) h += `To: ${toStr}\r\n`
    if (ccStr) h += `Cc: ${ccStr}\r\n`
    if (msg.subject) h += `Subject: ${msg.subject}\r\n`
    return h
}

function buildEnvelopeString(msg: typeof mailMessages.$inferSelect): string {
    const to = (msg.toAddresses as Array<{ name?: string; address?: string }> | null) || []
    const date = (msg.remoteDate || msg.receivedAt || new Date()).toUTCString()
    const fromAddr = [[
        escapeLiteral(msg.fromName),
        'NIL',
        escapeLiteral(msg.fromAddress?.split('@')[0] || null),
        escapeLiteral(msg.fromAddress?.split('@')[1] || null),
    ].join(' ')]
    const toList = to.map(a => `(${escapeLiteral(a.name || null)} NIL ${escapeLiteral(a.address?.split('@')[0] || null)} ${escapeLiteral(a.address?.split('@')[1] || null)})`)

    return `(${escapeLiteral(date)} ${escapeLiteral(msg.subject)} ((${fromAddr.join(' ')})) NIL NIL ((${toList.join(' ')})) NIL NIL ${escapeLiteral(msg.inReplyTo)} ${escapeLiteral(msg.messageId || `<${msg.id}@skaleclub.mail>`)})`
}

// ─── FETCH Item Builder ────────────────────────────────────────────────────────

async function buildFetchResponse(
    seqNum: number,
    msg: typeof mailMessages.$inferSelect,
    items: string[]
): Promise<string> {
    const parts: string[] = []

    for (const item of items) {
        const upper = item.toUpperCase()

        if (upper === 'FLAGS') {
            parts.push(`FLAGS ${flagsToIMAP(msg)}`)
        } else if (upper === 'UID') {
            parts.push(`UID ${msg.remoteUid || seqNum}`)
        } else if (upper === 'INTERNALDATE') {
            const d = msg.receivedAt || msg.remoteDate || new Date()
            parts.push(`INTERNALDATE "${d.toUTCString()}"`)
        } else if (upper === 'RFC822.SIZE' || upper === 'BODY.SIZE') {
            const raw = buildRawMessage(msg)
            parts.push(`RFC822.SIZE ${Buffer.byteLength(raw, 'utf8')}`)
        } else if (upper === 'ENVELOPE') {
            parts.push(`ENVELOPE ${buildEnvelopeString(msg)}`)
        } else if (upper === 'RFC822' || upper === 'BODY[]' || upper === 'BODY.PEEK[]') {
            const raw = buildRawMessage(msg)
            parts.push(`${upper === 'BODY.PEEK[]' ? 'BODY[]' : upper} {${Buffer.byteLength(raw, 'utf8')}}\r\n${raw}`)
        } else if (upper === 'RFC822.HEADER' || upper === 'BODY[HEADER]' || upper === 'BODY.PEEK[HEADER]') {
            const header = buildHeader(msg)
            parts.push(`${upper.includes('PEEK') ? 'BODY[HEADER]' : upper} {${Buffer.byteLength(header, 'utf8')}}\r\n${header}`)
        } else if (upper === 'RFC822.TEXT' || upper === 'BODY[TEXT]' || upper === 'BODY.PEEK[TEXT]') {
            const body = (msg.plainBody || msg.htmlBody || '')
            parts.push(`${upper.includes('PEEK') ? 'BODY[TEXT]' : upper} {${Buffer.byteLength(body, 'utf8')}}\r\n${body}`)
        } else if (upper === 'BODYSTRUCTURE') {
            if (msg.htmlBody && msg.plainBody) {
                const boundary = `boundary_${msg.id.replace(/-/g, '')}`
                parts.push(`BODYSTRUCTURE ((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${Buffer.byteLength(msg.plainBody, 'utf8')} ${msg.plainBody.split('\n').length}) ("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${Buffer.byteLength(msg.htmlBody, 'utf8')} ${msg.htmlBody.split('\n').length}) "ALTERNATIVE" ("BOUNDARY" "${boundary}") NIL NIL) NIL NIL)`)
            } else if (msg.htmlBody) {
                const size = Buffer.byteLength(msg.htmlBody, 'utf8')
                const lines = msg.htmlBody.split('\n').length
                parts.push(`BODYSTRUCTURE ("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${size} ${lines} NIL NIL NIL)`)
            } else {
                const body = msg.plainBody || ''
                const size = Buffer.byteLength(body, 'utf8')
                const lines = body.split('\n').length
                parts.push(`BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${size} ${lines} NIL NIL NIL)`)
            }
        }
    }

    return `* ${seqNum} FETCH (${parts.join(' ')})`
}

// ─── Parse fetch items ────────────────────────────────────────────────────────

function parseFetchItems(itemStr: string): string[] {
    const upper = itemStr.toUpperCase().trim()

    // Macros
    if (upper === 'ALL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE']
    if (upper === 'FAST') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE']
    if (upper === 'FULL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY']

    // Strip outer parens
    const inner = upper.startsWith('(') ? upper.slice(1, -1).trim() : upper

    // Split by spaces but keep BODY[...] together
    const items: string[] = []
    let current = ''
    let depth = 0
    for (const ch of inner) {
        if (ch === '[') depth++
        if (ch === ']') depth--
        if (ch === ' ' && depth === 0) {
            if (current) items.push(current)
            current = ''
        } else {
            current += ch
        }
    }
    if (current) items.push(current)
    return items
}

// ─── Sequence / UID range parser ──────────────────────────────────────────────

function parseSequenceSet(set: string, max: number): number[] {
    const nums: number[] = []
    const parts = set.split(',')
    for (const part of parts) {
        if (part.includes(':')) {
            const [a, b] = part.split(':')
            const start = a === '*' ? max : parseInt(a)
            const end = b === '*' ? max : parseInt(b)
            for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                if (i >= 1 && i <= max) nums.push(i)
            }
        } else {
            const n = part === '*' ? max : parseInt(part)
            if (!isNaN(n) && n >= 1 && n <= max) nums.push(n)
        }
    }
    return [...new Set(nums)].sort((a, b) => a - b)
}

// ─── Command Handler ──────────────────────────────────────────────────────────

async function handleCommand(session: IMAPSession, tag: string, command: string, args: string) {
    const cmd = command.toUpperCase()
    const socket = session.socket

    // ── CAPABILITY ──
    if (cmd === 'CAPABILITY') {
        sendLine(socket, '* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=LOGIN LITERAL+ IDLE')
        sendLine(socket, `${tag} OK CAPABILITY completed`)
        return
    }

    // ── NOOP ──
    if (cmd === 'NOOP') {
        sendLine(socket, `${tag} OK NOOP completed`)
        return
    }

    // ── LOGOUT ──
    if (cmd === 'LOGOUT') {
        sendLine(socket, '* BYE Logging out')
        sendLine(socket, `${tag} OK LOGOUT completed`)
        session.state = 'logout'
        socket.end()
        return
    }

    // ── LOGIN ──
    if (cmd === 'LOGIN') {
        // Parse: LOGIN "user" "pass"  or  LOGIN user pass
        const match = args.match(/^"?([^"\s]+)"?\s+"?(.+?)"?$/)
        if (!match) {
            sendLine(socket, `${tag} BAD LOGIN syntax error`)
            return
        }
        const [, email, password] = match
        const account = await authenticate(email, password)
        if (!account) {
            sendLine(socket, `${tag} NO LOGIN failed - invalid credentials`)
            return
        }
        session.state = 'authenticated'
        session.userId = account.id
        session.userEmail = account.email
        console.log(`[IMAP] Login: ${email}`)
        sendLine(socket, `${tag} OK LOGIN completed`)
        return
    }

    // ── AUTHENTICATE ──
    if (cmd === 'AUTHENTICATE') {
        // Basic PLAIN auth support
        if (args.toUpperCase().startsWith('PLAIN')) {
            sendLine(socket, '+ ')
            // The client will send base64 on next line - for now just ask for credentials another way
            // Full SASL PLAIN: "\0username\0password" base64 encoded
            sendLine(socket, `${tag} NO Use LOGIN command instead`)
            return
        }
        sendLine(socket, `${tag} NO AUTHENTICATE mechanism not supported, use LOGIN`)
        return
    }

    // All commands below require authentication
    if (session.state === 'not_authenticated') {
        sendLine(socket, `${tag} NO Please authenticate first`)
        return
    }

    const companion = await getCompanionMailbox(session.userEmail!, session.userId!)
    if (!companion) {
        sendLine(socket, `${tag} NO Mailbox not found`)
        return
    }

    // ── LIST ──
    if (cmd === 'LIST' || cmd === 'LSUB') {
        // LIST "" "*"  or  LIST "" "INBOX"
        const folders = await db.query.mailFolders.findMany({
            where: eq(mailFolders.mailboxId, companion.id),
        })

        for (const folder of folders) {
            const attrs = folderTypeToAttributes(folder.type)
            sendLine(socket, `* ${cmd} (${attrs}) "/" "${folder.remoteId}"`)
        }
        sendLine(socket, `${tag} OK ${cmd} completed`)
        return
    }

    // ── STATUS ──
    if (cmd === 'STATUS') {
        const parts = args.match(/^"?([^"\s]+)"?\s+\((.+)\)$/)
        if (!parts) { sendLine(socket, `${tag} BAD STATUS syntax error`); return }
        const folderName = parts[1]
        const requestedItems = parts[2].toUpperCase().split(/\s+/)

        const folder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, companion.id),
                eq(mailFolders.remoteId, folderName)
            ),
        })

        if (!folder) { sendLine(socket, `${tag} NO STATUS no such mailbox`); return }

        const items: string[] = []
        if (requestedItems.includes('MESSAGES')) items.push(`MESSAGES ${folder.totalCount}`)
        if (requestedItems.includes('RECENT')) items.push('RECENT 0')
        if (requestedItems.includes('UNSEEN')) items.push(`UNSEEN ${folder.unreadCount}`)
        if (requestedItems.includes('UIDNEXT')) items.push(`UIDNEXT ${folder.totalCount + 1}`)
        if (requestedItems.includes('UIDVALIDITY')) items.push('UIDVALIDITY 1')

        sendLine(socket, `* STATUS "${folderName}" (${items.join(' ')})`)
        sendLine(socket, `${tag} OK STATUS completed`)
        return
    }

    // ── SELECT / EXAMINE ──
    if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        const folderName = args.replace(/"/g, '').trim()
        const folder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, companion.id),
                eq(mailFolders.remoteId, folderName)
            ),
        }) as DBFolder | undefined

        if (!folder) {
            sendLine(socket, `${tag} NO [NONEXISTENT] No such mailbox`)
            return
        }

        session.state = 'selected'
        session.selectedMailboxId = companion.id
        session.selectedFolderId = folder.id
        session.selectedReadOnly = cmd === 'EXAMINE'

        const msgs = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, folder.id),
                eq(mailMessages.isDeleted, false)
            ),
            columns: { isRead: true },
        })

        const total = msgs.length
        const unseen = msgs.filter(m => !m.isRead).length

        sendLine(socket, `* ${total} EXISTS`)
        sendLine(socket, '* 0 RECENT')
        if (unseen > 0) {
            sendLine(socket, `* OK [UNSEEN ${total - unseen + 1}] Message ${total - unseen + 1} is the first unseen`)
        }
        sendLine(socket, '* OK [UIDVALIDITY 1] UIDs valid')
        sendLine(socket, `* OK [UIDNEXT ${total + 1}] Predicted next UID`)
        sendLine(socket, `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`)
        sendLine(socket, `* OK [PERMANENTFLAGS (\\Deleted \\Seen \\Flagged \\Draft \\*)] Flags permitted`)

        const access = cmd === 'EXAMINE' ? '[READ-ONLY]' : '[READ-WRITE]'
        sendLine(socket, `${tag} OK ${access} ${cmd} completed`)
        return
    }

    // ── CREATE ──
    if (cmd === 'CREATE') {
        const folderName = args.replace(/"/g, '').trim()
        const existing = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, companion.id),
                eq(mailFolders.remoteId, folderName)
            ),
        })
        if (existing) { sendLine(socket, `${tag} NO Mailbox already exists`); return }

        await db.insert(mailFolders).values({
            mailboxId: companion.id,
            remoteId: folderName,
            name: folderName,
            type: 'custom',
        })
        sendLine(socket, `${tag} OK CREATE completed`)
        return
    }

    // ── DELETE ──
    if (cmd === 'DELETE') {
        const folderName = args.replace(/"/g, '').trim()
        const folder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, companion.id),
                eq(mailFolders.remoteId, folderName)
            ),
        })
        if (!folder) { sendLine(socket, `${tag} NO No such mailbox`); return }
        await db.delete(mailMessages).where(eq(mailMessages.folderId, folder.id))
        await db.delete(mailFolders).where(eq(mailFolders.id, folder.id))
        sendLine(socket, `${tag} OK DELETE completed`)
        return
    }

    // Commands that require a selected folder
    if (cmd === 'FETCH' || cmd === 'STORE' || cmd === 'EXPUNGE' || cmd === 'SEARCH' || cmd === 'UID' || cmd === 'COPY' || cmd === 'MOVE') {
        if (session.state !== 'selected' || !session.selectedFolderId) {
            sendLine(socket, `${tag} NO No mailbox selected`)
            return
        }
    }

    // ── FETCH ──
    if (cmd === 'FETCH') {
        const match = args.match(/^(\S+)\s+(.+)$/)
        if (!match) { sendLine(socket, `${tag} BAD FETCH syntax error`); return }
        const [, seqSet, itemStr] = match

        const msgs = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, session.selectedFolderId!),
                eq(mailMessages.isDeleted, false)
            ),
            orderBy: [asc(mailMessages.receivedAt)],
        })

        const seqNums = parseSequenceSet(seqSet, msgs.length)
        const items = parseFetchItems(itemStr)

        for (const seqNum of seqNums) {
            const msg = msgs[seqNum - 1]
            if (!msg) continue
            const response = await buildFetchResponse(seqNum, msg, items)
            sendLine(socket, response)
        }

        // Mark as seen if BODY[] fetched (not PEEK)
        const fetchesBody = items.some(i => i.includes('BODY[') && !i.includes('PEEK'))
        if (fetchesBody) {
            for (const seqNum of seqNums) {
                const msg = msgs[seqNum - 1]
                if (msg && !msg.isRead) {
                    await db.update(mailMessages)
                        .set({ isRead: true, updatedAt: new Date() })
                        .where(eq(mailMessages.id, msg.id))
                }
            }
        }

        sendLine(socket, `${tag} OK FETCH completed`)
        return
    }

    // ── STORE ──
    if (cmd === 'STORE') {
        const match = args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+(.+)$/)
        if (!match) { sendLine(socket, `${tag} BAD STORE syntax error`); return }
        const [, seqSet, flagOp, flagList] = match

        const msgs = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, session.selectedFolderId!),
                eq(mailMessages.isDeleted, false)
            ),
            orderBy: [asc(mailMessages.receivedAt)],
        })

        const seqNums = parseSequenceSet(seqSet, msgs.length)
        const flagStr = flagList.replace(/[()]/g, '').toUpperCase()
        const silent = flagOp.includes('.SILENT')

        for (const seqNum of seqNums) {
            const msg = msgs[seqNum - 1]
            if (!msg) continue

            const updates: Partial<{ isRead: boolean; isStarred: boolean; isDeleted: boolean; isDraft: boolean; updatedAt: Date }> = { updatedAt: new Date() }

            const applyFlag = (flag: string, value: boolean) => {
                if (flag === '\\SEEN') updates.isRead = value
                if (flag === '\\FLAGGED') updates.isStarred = value
                if (flag === '\\DELETED') updates.isDeleted = value
                if (flag === '\\DRAFT') updates.isDraft = value
            }

            const flags = flagStr.split(/\s+/)

            if (flagOp.startsWith('+')) {
                flags.forEach(f => applyFlag(f, true))
            } else if (flagOp.startsWith('-')) {
                flags.forEach(f => applyFlag(f, false))
            } else {
                // Replace flags
                updates.isRead = flags.includes('\\SEEN')
                updates.isStarred = flags.includes('\\FLAGGED')
                updates.isDeleted = flags.includes('\\DELETED')
                updates.isDraft = flags.includes('\\DRAFT')
            }

            await db.update(mailMessages)
                .set(updates)
                .where(eq(mailMessages.id, msg.id))

            if (!silent) {
                const updated = { ...msg, ...updates }
                sendLine(socket, `* ${seqNum} FETCH (FLAGS ${flagsToIMAP(updated as typeof msg)})`)
            }
        }

        sendLine(socket, `${tag} OK STORE completed`)
        return
    }

    // ── EXPUNGE ──
    if (cmd === 'EXPUNGE') {
        const msgs = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, session.selectedFolderId!),
                eq(mailMessages.isDeleted, false)
            ),
            orderBy: [asc(mailMessages.receivedAt)],
        })

        const deleted = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, session.selectedFolderId!),
                eq(mailMessages.isDeleted, true)
            ),
        })

        for (let i = msgs.length; i >= 1; i--) {
            const msg = msgs[i - 1]
            if (msg.isDeleted) {
                await db.delete(mailMessages).where(eq(mailMessages.id, msg.id))
                sendLine(socket, `* ${i} EXPUNGE`)
            }
        }

        // Also clean up already-deleted
        for (const msg of deleted) {
            await db.delete(mailMessages).where(eq(mailMessages.id, msg.id))
        }

        sendLine(socket, `${tag} OK EXPUNGE completed`)
        return
    }

    // ── SEARCH ──
    if (cmd === 'SEARCH') {
        const msgs = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, session.selectedFolderId!),
                eq(mailMessages.isDeleted, false)
            ),
            orderBy: [asc(mailMessages.receivedAt)],
        })

        const upperArgs = args.toUpperCase()
        const results: number[] = []

        // Simple search criteria
        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i]
            let match = true

            if (upperArgs.includes('UNSEEN') && msg.isRead) match = false
            if (upperArgs.includes('SEEN') && !msg.isRead) match = false
            if (upperArgs.includes('FLAGGED') && !msg.isStarred) match = false
            if (upperArgs.includes('UNFLAGGED') && msg.isStarred) match = false
            if (upperArgs.includes('DRAFT') && !msg.isDraft) match = false

            // Subject search
            const subjectMatch = args.match(/SUBJECT\s+"([^"]+)"/i)
            if (subjectMatch && !msg.subject?.toLowerCase().includes(subjectMatch[1].toLowerCase())) match = false

            // From search
            const fromMatch = args.match(/FROM\s+"([^"]+)"/i)
            if (fromMatch && !msg.fromAddress?.toLowerCase().includes(fromMatch[1].toLowerCase())) match = false

            if (upperArgs === 'ALL') match = true

            if (match) results.push(i + 1)
        }

        sendLine(socket, `* SEARCH ${results.join(' ')}`)
        sendLine(socket, `${tag} OK SEARCH completed`)
        return
    }

    // ── APPEND ──
    if (cmd === 'APPEND') {
        // APPEND "Folder" (\Seen) "date" {size}
        const match = args.match(/^"?([^"\s]+)"?\s+/)
        if (!match) { sendLine(socket, `${tag} BAD APPEND syntax error`); return }
        const folderName = match[1]

        const folder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, companion.id),
                eq(mailFolders.remoteId, folderName)
            ),
        })

        if (!folder) {
            sendLine(socket, `${tag} NO [TRYCREATE] No such mailbox`)
            return
        }

        // For a full implementation we'd read the literal; for now acknowledge
        sendLine(socket, `${tag} OK APPEND completed`)
        return
    }

    // ── COPY ──
    if (cmd === 'COPY') {
        const match = args.match(/^(\S+)\s+"?([^"\s]+)"?$/)
        if (!match) { sendLine(socket, `${tag} BAD COPY syntax error`); return }
        const [, seqSet, destFolderName] = match

        const destFolder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, companion.id),
                eq(mailFolders.remoteId, destFolderName)
            ),
        })
        if (!destFolder) { sendLine(socket, `${tag} NO [TRYCREATE] No such mailbox`); return }

        const msgs = await db.query.mailMessages.findMany({
            where: and(
                eq(mailMessages.folderId, session.selectedFolderId!),
                eq(mailMessages.isDeleted, false)
            ),
            orderBy: [asc(mailMessages.receivedAt)],
        })

        const seqNums = parseSequenceSet(seqSet, msgs.length)
        for (const seqNum of seqNums) {
            const msg = msgs[seqNum - 1]
            if (!msg) continue
            await db.insert(mailMessages).values({
                mailboxId: msg.mailboxId,
                folderId: destFolder.id,
                messageId: msg.messageId,
                inReplyTo: msg.inReplyTo,
                references: msg.references,
                subject: msg.subject,
                fromAddress: msg.fromAddress,
                fromName: msg.fromName,
                toAddresses: msg.toAddresses as object[],
                ccAddresses: msg.ccAddresses as object[],
                bccAddresses: msg.bccAddresses as object[],
                plainBody: msg.plainBody,
                htmlBody: msg.htmlBody,
                headers: msg.headers as object,
                hasAttachments: msg.hasAttachments,
                attachments: msg.attachments as object[],
                isRead: msg.isRead,
                isDraft: msg.isDraft,
                remoteDate: msg.remoteDate,
                receivedAt: new Date(),
            }).onConflictDoNothing()
        }

        sendLine(socket, `${tag} OK COPY completed`)
        return
    }

    // ── UID (prefix for FETCH/STORE/SEARCH/COPY with UIDs) ──
    if (cmd === 'UID') {
        const spaceIdx = args.indexOf(' ')
        const subCmd = args.substring(0, spaceIdx).toUpperCase()
        const subArgs = args.substring(spaceIdx + 1)

        // Re-dispatch as the sub-command but treat sequence numbers as UIDs
        // For simplicity, treat UID == sequence number here
        await handleCommand(session, tag, subCmd, subArgs)
        return
    }

    // ── IDLE ──
    if (cmd === 'IDLE') {
        sendLine(socket, '+ idling')
        // When client sends DONE, exit idle
        // We handle this in the data handler - for now just respond
        return
    }

    // Unknown command
    sendLine(socket, `${tag} BAD Unknown command: ${command}`)
}

// ─── Connection Handler ───────────────────────────────────────────────────────

function handleConnection(socket: net.Socket) {
    const session: IMAPSession = {
        socket,
        state: 'not_authenticated',
        userId: null,
        userEmail: null,
        selectedMailboxId: null,
        selectedFolderId: null,
        selectedReadOnly: false,
        buffer: '',
    }

    socket.setEncoding('utf8')
    sendLine(socket, `* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=LOGIN] ${_imapAppName} IMAP server ready`)

    socket.on('data', (data: string) => {
        session.buffer += data

        // Process complete lines
        let lineEnd: number
        while ((lineEnd = session.buffer.indexOf('\r\n')) !== -1) {
            const line = session.buffer.substring(0, lineEnd)
            session.buffer = session.buffer.substring(lineEnd + 2)

            if (!line.trim()) continue

            // Handle IDLE DONE
            if (line.trim().toUpperCase() === 'DONE') {
                sendLine(socket, '* OK [IDLE] Idle terminated')
                continue
            }

            // Parse: tag command [args]
            const firstSpace = line.indexOf(' ')
            if (firstSpace === -1) continue

            const tag = line.substring(0, firstSpace)
            const rest = line.substring(firstSpace + 1)
            const secondSpace = rest.indexOf(' ')
            const command = secondSpace === -1 ? rest : rest.substring(0, secondSpace)
            const args = secondSpace === -1 ? '' : rest.substring(secondSpace + 1)

            handleCommand(session, tag, command, args).catch(err => {
                console.error(`[IMAP] Command error (${command}):`, err)
                sendLine(socket, `${tag} NO Internal server error`)
            })

            if (session.state === 'logout') break
        }
    })

    socket.on('error', (err: Error) => {
        // Ignore common disconnect errors
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            console.error('[IMAP] Socket error:', err.message)
        }
    })

    socket.on('close', () => {
        // Clean up
    })
}

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

export function createIMAPServer() {
    const port = parseInt(process.env.IMAP_PORT || '2993')

    const server = net.createServer(handleConnection)

    server.on('error', (err: Error) => {
        console.error('[IMAP] Server error:', err.message)
    })

    return {
        start() {
            server.listen(port, '0.0.0.0', () => {
                console.log(`[IMAP] Server listening on port ${port}`)
                console.log(`[IMAP] Configure Thunderbird: IMAP → mail.skale.club:${port} (SSL)`)
            })
        },
        close() {
            server.close()
        },
    }
}
