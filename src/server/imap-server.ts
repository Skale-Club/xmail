/**
 * Native IMAP Server (RFC 3501 + STARTTLS + IDLE + LITERAL+).
 *
 * Listens on IMAP_PORT (993 prod, 2993 dev).
 * Uses implicit TLS when MAIL_TLS_CERT_PATH/MAIL_TLS_KEY_PATH are set,
 * otherwise plain text with STARTTLS offered when certs are available later.
 *
 * Allows Thunderbird and other email clients to read/manage mail
 * stored in the mailboxes / mailMessages database tables.
 */

import net from 'net'
import tls from 'tls'
import { randomUUID } from 'crypto'
import { db } from '../db'
import { mailboxes, mailFolders, mailMessages } from '../db/schema'
import { eq, and, asc, inArray, sql } from 'drizzle-orm'
import { getCachedBranding } from './lib/serverBranding'
import { authenticateNativeUser } from './lib/native-mail'
import { getMailTLSOptions } from './lib/mail-tls'
import { isIpLocked, recordAuthFailure, clearAuthFailures } from './lib/auth-throttle'
import { mailEvents, emitFolderChange, type MailEventPayload } from './lib/mail-events'
import { parseRawEmail } from './lib/mail'
import { allocateNextUid, recomputeFolderCounts } from './lib/folder-counts'
import { jsonbParam } from './lib/jsonb'

const MAX_BUFFER_BYTES = 10 * 1024 * 1024 // 10 MB hard cap per session

let _imapAppName = process.env.APP_APPLICATION_NAME ?? ''

export async function loadImapBranding() {
    const { applicationName } = await getCachedBranding()
    _imapAppName = applicationName
}

// ─── Types ────────────────────────────────────────────────────────────────────

type IMAPSocket = net.Socket | tls.TLSSocket

interface PendingLiteral {
    tag: string
    type: 'APPEND'
    folderName: string
    flags: string[]
    chunks: Buffer[]
    remaining: number
    noResponse: boolean
}

interface PendingAuth {
    tag: string
    mechanism: 'PLAIN' | 'LOGIN'
    step: number          // LOGIN: 0=waiting user, 1=waiting pass
    username: string | null
}

interface IMAPSession {
    socket: IMAPSocket
    ip: string
    isTLS: boolean
    state: 'not_authenticated' | 'authenticated' | 'selected' | 'logout'
    userId: string | null
    userEmail: string | null
    selectedMailboxId: string | null
    selectedFolderId: string | null
    selectedReadOnly: boolean
    selectedUidValidity: number
    selectedMessages: LightMailMessage[]
    selectedSync: Promise<void>
    buffer: Buffer
    pendingLiteral: PendingLiteral | null
    pendingAuth: PendingAuth | null
    idleTag: string | null
    idleListener: ((payload: MailEventPayload) => void) | null
    knownMessageCount: number
    processing: boolean
}

interface DBFolder {
    id: string
    mailboxId: string
    remoteId: string
    name: string
    type: string | null
    unreadCount: number
    totalCount: number
    uidValidity: number
    uidNext: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendLine(socket: IMAPSocket, line: string) {
    if (socket.writable) socket.write(line + '\r\n')
}

function escapeLiteral(s: string | null): string {
    if (s === null || s === undefined) return 'NIL'
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

function parseListArgs(args: string): { reference: string; mailbox: string } | null {
    const match = args.match(/^"([^"]*)"\s+"([^"]*)"$/) || args.match(/^(\S+)\s+(\S+)$/)
    if (!match) return null
    return {
        reference: match[1].replace(/^"|"$/g, ''),
        mailbox: match[2].replace(/^"|"$/g, ''),
    }
}

function listPatternToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/%/g, '[^/]*')
    return new RegExp(`^${escaped}$`, 'i')
}

function folderMatchesListPattern(remoteId: string, reference: string, mailbox: string): boolean {
    if (!mailbox) return false

    const normalizedReference = reference.replace(/^\/+|\/+$/g, '')
    const normalizedMailbox = mailbox.replace(/^\/+/, '')
    const pattern = normalizedReference && !normalizedMailbox.startsWith(normalizedReference)
        ? `${normalizedReference}/${normalizedMailbox}`
        : normalizedMailbox

    return listPatternToRegex(pattern).test(remoteId)
}

// ─── Message projections ──────────────────────────────────────────────────────
//
// Every command below has to read the whole folder to compute IMAP sequence
// numbers, but almost none of them need the message payload: plain_body,
// html_body, headers and attachments average ~14 kB per row and were being
// shipped out of Postgres on every FLAGS poll. That single pattern accounted
// for the bulk of the project's Supabase egress. Handlers now read the light
// projection to build the sequence/UID map, then hydrate payloads only for the
// messages a command actually returns or copies.

type MailMessageRow = typeof mailMessages.$inferSelect
type MailMessagePayload = Pick<MailMessageRow, 'plainBody' | 'htmlBody' | 'headers' | 'attachments'>
type LightMailMessage = Omit<MailMessageRow, keyof MailMessagePayload>
type FetchMailMessage = LightMailMessage & Pick<MailMessageRow, 'plainBody' | 'htmlBody'>

const IMAP_LIGHT_COLUMNS = {
    plainBody: false,
    htmlBody: false,
    headers: false,
    attachments: false,
} as const

/** Ordered, payload-free view of a folder — the basis for IMAP sequence numbers. */
async function loadFolderMessages(
    folderId: string,
): Promise<LightMailMessage[]> {
    return db.query.mailMessages.findMany({
        where: eq(mailMessages.folderId, folderId),
        columns: IMAP_LIGHT_COLUMNS,
        // Sequence numbers are positions in the selected mailbox. UIDs are
        // monotonically allocated, so UID order is the stable server order.
        orderBy: [asc(mailMessages.remoteUid), asc(mailMessages.receivedAt)],
    })
}

/** Loads the heavy columns for just `ids`, keyed by message id. */
async function loadMessagePayloads(ids: string[]): Promise<Map<string, MailMessagePayload>> {
    if (ids.length === 0) return new Map()
    const rows = await db.query.mailMessages.findMany({
        where: inArray(mailMessages.id, ids),
        columns: { id: true, plainBody: true, htmlBody: true, headers: true, attachments: true },
    })
    return new Map(rows.map(r => [r.id, r]))
}

/**
 * True when any requested item makes buildFetchResponse read a message body
 * (directly, or via buildRawMessage / BODYSTRUCTURE sizing).
 *
 * MUST stay in sync with buildFetchResponse: an item that reads plainBody or
 * htmlBody but is missing here gets a message whose bodies were never loaded,
 * and would silently serve an empty body.
 */
function needsBodies(items: string[]): boolean {
    return items.some(item => {
        const upper = item.toUpperCase()
        return upper === 'RFC822'
            || upper === 'RFC822.SIZE' || upper === 'BODY.SIZE'
            || upper === 'RFC822.TEXT'
            || upper === 'BODYSTRUCTURE'
            || upper === 'BODY[]' || upper === 'BODY.PEEK[]'
            || upper === 'BODY[TEXT]' || upper === 'BODY.PEEK[TEXT]'
    })
}

function withBodies(msg: LightMailMessage, payloads: Map<string, MailMessagePayload>): FetchMailMessage {
    const payload = payloads.get(msg.id)
    return { ...msg, plainBody: payload?.plainBody ?? null, htmlBody: payload?.htmlBody ?? null }
}

function buildRawMessage(msg: FetchMailMessage): string {
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

function buildHeader(msg: LightMailMessage): string {
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

function buildEnvelopeString(msg: LightMailMessage): string {
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
    msg: FetchMailMessage,
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
        } else if (upper.startsWith('BODY[HEADER.FIELDS') || upper.startsWith('BODY.PEEK[HEADER.FIELDS')) {
            const isPeek = upper.startsWith('BODY.PEEK')
            const fieldsMatch = upper.match(/HEADER\.FIELDS(?:\.NOT)?\s+\(([^)]+)\)/)
            const requestedFields = fieldsMatch ? fieldsMatch[1].split(/\s+/) : []
            const to = (msg.toAddresses as Array<{ name?: string; address?: string }> | null) || []
            const cc = (msg.ccAddresses as Array<{ name?: string; address?: string }> | null) || []
            const date = (msg.remoteDate || msg.receivedAt || new Date()).toUTCString()
            let header = ''
            for (const field of requestedFields) {
                if (field === 'DATE') header += `Date: ${date}\r\n`
                else if (field === 'FROM') header += `From: ${msg.fromName ? `"${msg.fromName}" ` : ''}<${msg.fromAddress || ''}>\r\n`
                else if (field === 'SUBJECT' && msg.subject) header += `Subject: ${msg.subject}\r\n`
                else if (field === 'TO') { const s = to.map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', '); if (s) header += `To: ${s}\r\n` }
                else if (field === 'CC') { const s = cc.map(a => a.name ? `"${a.name}" <${a.address}>` : a.address).join(', '); if (s) header += `Cc: ${s}\r\n` }
                else if (field === 'MESSAGE-ID') header += `Message-ID: ${msg.messageId || `<${msg.id}@skaleclub.mail>`}\r\n`
                else if (field === 'IN-REPLY-TO' && msg.inReplyTo) header += `In-Reply-To: ${msg.inReplyTo}\r\n`
                else if (field === 'REFERENCES' && msg.references) header += `References: ${msg.references}\r\n`
            }
            header += '\r\n'
            const responseKey = `BODY[HEADER.FIELDS (${fieldsMatch?.[1] || ''})]`
            parts.push(`${responseKey} {${Buffer.byteLength(header, 'utf8')}}\r\n${header}`)
            if (!isPeek && !msg.isRead) {
                await db.update(mailMessages).set({ isRead: true, updatedAt: new Date() }).where(eq(mailMessages.id, msg.id))
            }
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

function parseFetchItems(itemStr: string): string[] {
    const upper = itemStr.toUpperCase().trim()

    if (upper === 'ALL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE']
    if (upper === 'FAST') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE']
    if (upper === 'FULL') return ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY']

    const inner = upper.startsWith('(') ? upper.slice(1, -1).trim() : upper

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

// ─── Current message count (for IDLE delta detection) ────────────────────────

async function countFolderMessages(folderId: string): Promise<number> {
    const rows = await db.select({ c: sql<number>`count(*)::int` })
        .from(mailMessages)
        .where(eq(mailMessages.folderId, folderId))
    return rows[0]?.c ?? 0
}

function sameFlags(a: LightMailMessage, b: LightMailMessage): boolean {
    return a.isRead === b.isRead
        && a.isStarred === b.isStarred
        && a.isDeleted === b.isDeleted
        && a.isDraft === b.isDraft
}

/**
 * Reconciles a selected-mailbox snapshot with the database. IMAP forbids a
 * server from announcing a lower EXISTS value: removals must be reported as
 * EXPUNGE, while flag mutations are unsolicited FETCH responses.
 */
async function syncSelectedMailbox(session: IMAPSession): Promise<void> {
    if (session.state !== 'selected' || !session.selectedFolderId) return

    const previous = session.selectedMessages
    const current = await loadFolderMessages(session.selectedFolderId)
    const currentById = new Map(current.map(message => [message.id, message]))

    for (let index = previous.length - 1; index >= 0; index--) {
        if (!currentById.has(previous[index].id)) {
            sendLine(session.socket, `* ${index + 1} EXPUNGE`)
        }
    }

    const previousById = new Map(previous.map(message => [message.id, message]))
    for (let index = 0; index < current.length; index++) {
        const old = previousById.get(current[index].id)
        if (old && !sameFlags(old, current[index])) {
            sendLine(session.socket, `* ${index + 1} FETCH (FLAGS ${flagsToIMAP(current[index])})`)
        }
    }

    const added = current.filter(message => !previousById.has(message.id)).length
    if (added > 0) {
        sendLine(session.socket, `* ${current.length} EXISTS`)
        sendLine(session.socket, `* ${added} RECENT`)
    }

    session.selectedMessages = current
    session.knownMessageCount = current.length
}

function queueSelectedSync(session: IMAPSession): Promise<void> {
    const next = session.selectedSync.then(() => syncSelectedMailbox(session))
    session.selectedSync = next.catch(() => undefined)
    return next
}

function updateSelectedSnapshot(
    session: IMAPSession,
    messageId: string,
    updates: Partial<LightMailMessage>,
) {
    const selected = session.selectedMessages.find(message => message.id === messageId)
    if (selected) Object.assign(selected, updates)
}

// ─── Capability ──────────────────────────────────────────────────────────────

function capabilities(session: IMAPSession): string {
    const caps = ['IMAP4rev1', 'LITERAL+', 'IDLE', 'UIDPLUS', 'MOVE', 'UNSELECT']
    if (session.state === 'not_authenticated') {
        caps.push('AUTH=PLAIN', 'AUTH=LOGIN')
        if (!session.isTLS && getMailTLSOptions()) caps.push('STARTTLS')
    } else {
        caps.push('AUTH=PLAIN', 'AUTH=LOGIN')
    }
    return caps.join(' ')
}

// ─── Command Handler ──────────────────────────────────────────────────────────

async function handleCommand(session: IMAPSession, tag: string, command: string, args: string) {
    const cmd = command.toUpperCase()
    const socket = session.socket

    // ── CAPABILITY ──
    if (cmd === 'CAPABILITY') {
        sendLine(socket, `* CAPABILITY ${capabilities(session)}`)
        sendLine(socket, `${tag} OK CAPABILITY completed`)
        return
    }

    // ── NOOP / CHECK ──
    // RFC 3501 §6.1.2 / §6.4.1: servers SHOULD send any pending untagged
    // responses (EXISTS, RECENT, EXPUNGE, FETCH) before the tagged OK.
    // Thunderbird uses NOOP and CHECK to poll for new mail when not in IDLE.
    if (cmd === 'NOOP' || cmd === 'CHECK') {
        if (session.state === 'selected' && session.selectedFolderId) {
            await queueSelectedSync(session)
        }
        sendLine(socket, `${tag} OK ${cmd} completed`)
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

    // ── STARTTLS ──
    if (cmd === 'STARTTLS') {
        const opts = getMailTLSOptions()
        if (!opts) { sendLine(socket, `${tag} NO TLS not available`); return }
        if (session.isTLS) { sendLine(socket, `${tag} NO Already using TLS`); return }
        sendLine(socket, `${tag} OK Begin TLS negotiation now`)
        upgradeToTLS(session, opts)
        return
    }

    // ── LOGIN ──
    if (cmd === 'LOGIN') {
        if (isIpLocked(session.ip)) {
            sendLine(socket, `${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts, try again later`)
            return
        }
        const match = args.match(/^"?([^"\s]+)"?\s+"?(.+?)"?$/)
        if (!match) {
            sendLine(socket, `${tag} BAD LOGIN syntax error`)
            return
        }
        const [, email, password] = match
        const account = await authenticateNativeUser(email, password)
        if (!account) {
            recordAuthFailure(session.ip)
            sendLine(socket, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
            return
        }
        clearAuthFailures(session.ip)
        session.state = 'authenticated'
        session.userId = account.id
        session.userEmail = account.email
        console.log(`[IMAP] Login ok: ${email} (ip=${session.ip} tls=${session.isTLS})`)
        sendLine(socket, `${tag} OK [CAPABILITY ${capabilities(session)}] LOGIN completed`)
        return
    }

    // ── AUTHENTICATE PLAIN / LOGIN ──
    if (cmd === 'AUTHENTICATE') {
        if (isIpLocked(session.ip)) {
            sendLine(socket, `${tag} NO [AUTHENTICATIONFAILED] Too many failed attempts`)
            return
        }
        const mech = args.trim().toUpperCase().split(/\s+/)[0]
        if (mech === 'PLAIN') {
            // RFC 4616 — base64("\0user\0pass"). Can be inlined as initial response.
            const initialMatch = args.match(/^\S+\s+(\S+)$/)
            if (initialMatch) {
                await completeAuthPlain(session, tag, initialMatch[1])
                return
            }
            session.pendingAuth = { tag, mechanism: 'PLAIN', step: 0, username: null }
            sendLine(socket, '+ ')
            return
        }
        if (mech === 'LOGIN') {
            session.pendingAuth = { tag, mechanism: 'LOGIN', step: 0, username: null }
            sendLine(socket, '+ ' + Buffer.from('Username:').toString('base64'))
            return
        }
        sendLine(socket, `${tag} NO AUTHENTICATE mechanism not supported`)
        return
    }

    if (session.state === 'not_authenticated') {
        sendLine(socket, `${tag} NO Please authenticate first`)
        return
    }

    const companion = await db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.email, session.userEmail!.toLowerCase()),
            eq(mailboxes.userId, session.userId!)
        ),
    })
    if (!companion) {
        sendLine(socket, `${tag} NO Mailbox not found`)
        return
    }

    // ── LIST / LSUB ──
    if (cmd === 'LIST' || cmd === 'LSUB') {
        const listArgs = parseListArgs(args)
        if (!listArgs) { sendLine(socket, `${tag} BAD ${cmd} syntax error`); return }

        const folders = await db.query.mailFolders.findMany({
            where: eq(mailFolders.mailboxId, companion.id),
        })
        for (const folder of folders.filter(folder => folderMatchesListPattern(folder.remoteId, listArgs.reference, listArgs.mailbox))) {
            const attrs = folderTypeToAttributes(folder.type)
            sendLine(socket, `* ${cmd} (${attrs}) "/" "${folder.remoteId}"`)
        }
        sendLine(socket, `${tag} OK ${cmd} completed`)
        return
    }

    // ── NAMESPACE ──
    if (cmd === 'NAMESPACE') {
        sendLine(socket, '* NAMESPACE (("" "/")) NIL NIL')
        sendLine(socket, `${tag} OK NAMESPACE completed`)
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
        }) as DBFolder | undefined

        if (!folder) { sendLine(socket, `${tag} NO STATUS no such mailbox`); return }

        const totalCount = await countFolderMessages(folder.id)
        const unreadRows = await db.select({ c: sql<number>`count(*)::int` })
            .from(mailMessages)
            .where(and(
                eq(mailMessages.folderId, folder.id),
                eq(mailMessages.isDeleted, false),
                eq(mailMessages.isRead, false)
            ))
        const unread = unreadRows[0]?.c ?? 0

        const items: string[] = []
        if (requestedItems.includes('MESSAGES')) items.push(`MESSAGES ${totalCount}`)
        if (requestedItems.includes('RECENT')) items.push('RECENT 0')
        if (requestedItems.includes('UNSEEN')) items.push(`UNSEEN ${unread}`)
        if (requestedItems.includes('UIDNEXT')) items.push(`UIDNEXT ${folder.uidNext || totalCount + 1}`)
        if (requestedItems.includes('UIDVALIDITY')) items.push(`UIDVALIDITY ${folder.uidValidity || 1}`)

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
        session.selectedUidValidity = folder.uidValidity || 1

        const msgs = await loadFolderMessages(folder.id)
        const total = msgs.length
        const unseen = msgs.filter(m => !m.isRead).length
        session.selectedMessages = msgs
        session.knownMessageCount = total

        sendLine(socket, `* ${total} EXISTS`)
        sendLine(socket, '* 0 RECENT')
        const firstUnseen = msgs.findIndex(m => !m.isRead) + 1
        if (unseen > 0 && firstUnseen > 0) {
            sendLine(socket, `* OK [UNSEEN ${firstUnseen}] Message ${firstUnseen} is the first unseen`)
        }
        sendLine(socket, `* OK [UIDVALIDITY ${session.selectedUidValidity}] UIDs valid`)
        sendLine(socket, `* OK [UIDNEXT ${folder.uidNext || total + 1}] Predicted next UID`)
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
            uidValidity: Math.floor(Date.now() / 1000),
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

        const msgs = await loadFolderMessages(session.selectedFolderId!)

        const seqNums = parseSequenceSet(seqSet, msgs.length)
        const items = parseFetchItems(itemStr)

        const payloads = needsBodies(items)
            ? await loadMessagePayloads(seqNums.map(n => msgs[n - 1]?.id).filter((id): id is string => !!id))
            : new Map()

        for (const seqNum of seqNums) {
            const msg = msgs[seqNum - 1]
            if (!msg) continue
            const response = await buildFetchResponse(seqNum, withBodies(msg, payloads), items)
            sendLine(socket, response)
        }

        // Mark as seen if BODY[] fetched (not PEEK)
        const fetchesBody = items.some(i => /BODY\[(?!.*PEEK)/.test(i.toUpperCase()) || i.toUpperCase() === 'RFC822')
        if (fetchesBody && !session.selectedReadOnly) {
            let updated = false
            for (const seqNum of seqNums) {
                const msg = msgs[seqNum - 1]
                if (msg && !msg.isRead) {
                    await db.update(mailMessages)
                        .set({ isRead: true, updatedAt: new Date() })
                        .where(eq(mailMessages.id, msg.id))
                    updateSelectedSnapshot(session, msg.id, { isRead: true })
                    updated = true
                }
            }
            if (updated) await recomputeFolderCounts(session.selectedFolderId!)
        }

        sendLine(socket, `${tag} OK FETCH completed`)
        return
    }

    // ── STORE ──
    if (cmd === 'STORE') {
        if (session.selectedReadOnly) { sendLine(socket, `${tag} NO Folder is read-only`); return }
        const match = args.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+(.+)$/)
        if (!match) { sendLine(socket, `${tag} BAD STORE syntax error`); return }
        const [, seqSet, flagOp, flagList] = match

        const msgs = await loadFolderMessages(session.selectedFolderId!)

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
                updates.isRead = flags.includes('\\SEEN')
                updates.isStarred = flags.includes('\\FLAGGED')
                updates.isDeleted = flags.includes('\\DELETED')
                updates.isDraft = flags.includes('\\DRAFT')
            }

            await db.update(mailMessages)
                .set(updates)
                .where(eq(mailMessages.id, msg.id))
            updateSelectedSnapshot(session, msg.id, updates)

            if (!silent) {
                const updated = { ...msg, ...updates }
                sendLine(socket, `* ${seqNum} FETCH (FLAGS ${flagsToIMAP(updated as typeof msg)})`)
            }
        }

        await recomputeFolderCounts(session.selectedFolderId!)
        emitFolderChange({
            folderId: session.selectedFolderId!,
            mailboxId: session.selectedMailboxId!,
            kind: 'flags',
        })

        sendLine(socket, `${tag} OK STORE completed`)
        return
    }

    // ── EXPUNGE ──
    if (cmd === 'EXPUNGE') {
        if (session.selectedReadOnly) { sendLine(socket, `${tag} NO Folder is read-only`); return }
        // \Deleted remains in the selected view until this command. Walk from
        // high to low so every emitted sequence number stays valid.
        const allMsgs = await loadFolderMessages(session.selectedFolderId!)
        for (let i = allMsgs.length - 1; i >= 0; i--) {
            const msg = allMsgs[i]
            if (!msg.isDeleted) continue
            await db.delete(mailMessages).where(eq(mailMessages.id, msg.id))
            sendLine(socket, `* ${i + 1} EXPUNGE`)
        }

        session.selectedMessages = allMsgs.filter(message => !message.isDeleted)
        session.knownMessageCount = session.selectedMessages.length

        await recomputeFolderCounts(session.selectedFolderId!)
        emitFolderChange({
            folderId: session.selectedFolderId!,
            mailboxId: session.selectedMailboxId!,
            kind: 'expunge',
        })

        sendLine(socket, `${tag} OK EXPUNGE completed`)
        return
    }

    // ── SEARCH ──
    // CLOSE expunges every \Deleted message without sending untagged EXPUNGE
    // responses. UNSELECT leaves all flags untouched. Both leave selected state.
    if (cmd === 'CLOSE' || cmd === 'UNSELECT') {
        if (session.state !== 'selected' || !session.selectedFolderId) {
            sendLine(socket, `${tag} NO No mailbox selected`)
            return
        }

        const folderId = session.selectedFolderId
        const mailboxId = session.selectedMailboxId!
        if (cmd === 'CLOSE') {
            if (session.selectedReadOnly) { sendLine(socket, `${tag} NO Folder is read-only`); return }
            const deleted = await db.query.mailMessages.findMany({
                where: and(eq(mailMessages.folderId, folderId), eq(mailMessages.isDeleted, true)),
                columns: { id: true },
            })
            if (deleted.length > 0) {
                await db.delete(mailMessages).where(inArray(mailMessages.id, deleted.map(message => message.id)))
                await recomputeFolderCounts(folderId)
                emitFolderChange({ folderId, mailboxId, kind: 'expunge' })
            }
        }

        session.state = 'authenticated'
        session.selectedMailboxId = null
        session.selectedFolderId = null
        session.selectedReadOnly = false
        session.selectedMessages = []
        session.knownMessageCount = 0
        sendLine(socket, `${tag} OK ${cmd} completed`)
        return
    }

    if (cmd === 'SEARCH') {
        const msgs = await loadFolderMessages(session.selectedFolderId!)

        const upperArgs = args.toUpperCase()
        const results: number[] = []

        for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i]
            let match = true

            if (upperArgs.includes('UNSEEN') && msg.isRead) match = false
            if (upperArgs.includes('SEEN') && !msg.isRead) match = false
            if (upperArgs.includes('FLAGGED') && !msg.isStarred) match = false
            if (upperArgs.includes('UNFLAGGED') && msg.isStarred) match = false
            if (upperArgs.includes('DRAFT') && !msg.isDraft) match = false

            const subjectMatch = args.match(/SUBJECT\s+"([^"]+)"/i)
            if (subjectMatch && !msg.subject?.toLowerCase().includes(subjectMatch[1].toLowerCase())) match = false

            const fromMatch = args.match(/FROM\s+"([^"]+)"/i)
            if (fromMatch && !msg.fromAddress?.toLowerCase().includes(fromMatch[1].toLowerCase())) match = false

            if (upperArgs === 'ALL') match = true

            if (match) results.push(i + 1)
        }

        sendLine(socket, `* SEARCH ${results.join(' ')}`)
        sendLine(socket, `${tag} OK SEARCH completed`)
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

        const msgs = await loadFolderMessages(session.selectedFolderId!)

        const seqNums = parseSequenceSet(seqSet, msgs.length)
        const payloads = await loadMessagePayloads(
            seqNums.map(n => msgs[n - 1]?.id).filter((id): id is string => !!id)
        )
        const sourceUids: number[] = []
        const copiedUids: number[] = []
        for (const seqNum of seqNums) {
            const msg = msgs[seqNum - 1]
            if (!msg) continue
            const payload = payloads.get(msg.id)
            const newUid = await allocateNextUid(destFolder.id)
            await db.insert(mailMessages).values({
                mailboxId: msg.mailboxId,
                folderId: destFolder.id,
                messageId: msg.messageId,
                inReplyTo: msg.inReplyTo,
                references: msg.references,
                subject: msg.subject,
                fromAddress: msg.fromAddress,
                fromName: msg.fromName,
                // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação.
                toAddresses: jsonbParam(msg.toAddresses ?? []),
                ccAddresses: jsonbParam(msg.ccAddresses ?? []),
                bccAddresses: jsonbParam(msg.bccAddresses ?? []),
                plainBody: payload?.plainBody ?? null,
                htmlBody: payload?.htmlBody ?? null,
                headers: jsonbParam(payload?.headers ?? {}),
                hasAttachments: msg.hasAttachments,
                attachments: jsonbParam(payload?.attachments ?? []),
                isRead: msg.isRead,
                isStarred: msg.isStarred,
                isDeleted: msg.isDeleted,
                isDraft: msg.isDraft,
                remoteUid: newUid,
                remoteDate: msg.remoteDate,
                receivedAt: msg.receivedAt,
                size: msg.size,
            })
            sourceUids.push(msg.remoteUid ?? seqNum)
            copiedUids.push(newUid)
        }

        await recomputeFolderCounts(destFolder.id)
        emitFolderChange({ folderId: destFolder.id, mailboxId: companion.id, kind: 'new' })

        sendLine(socket, `${tag} OK [COPYUID ${destFolder.uidValidity || 1} ${sourceUids.join(',')} ${copiedUids.join(',')}] COPY completed`)
        return
    }

    // ── UID ──
    if (cmd === 'MOVE') {
        const match = args.match(/^(\S+)\s+"?([^"\s]+)"?$/)
        if (!match) { sendLine(socket, `${tag} BAD MOVE syntax error`); return }
        const [, sequenceSet, destination] = match
        const messages = await loadFolderMessages(session.selectedFolderId!)
        const sourceUids = parseSequenceSet(sequenceSet, messages.length)
            .map(sequence => messages[sequence - 1]?.remoteUid)
            .filter((uid): uid is number => uid != null)
        if (sourceUids.length === 0) {
            sendLine(socket, `${tag} OK MOVE completed`)
            return
        }
        await handleUidCommand(session, tag, 'MOVE', `${sourceUids.join(',')} "${destination}"`, 'MOVE')
        return
    }

    if (cmd === 'UID') {
        const spaceIdx = args.indexOf(' ')
        if (spaceIdx === -1) { sendLine(socket, `${tag} BAD UID syntax error`); return }
        const subCmd = args.substring(0, spaceIdx).toUpperCase()
        const subArgs = args.substring(spaceIdx + 1)
        await handleUidCommand(session, tag, subCmd, subArgs)
        return
    }

    // ── IDLE ──
    if (cmd === 'IDLE') {
        if (session.state !== 'selected' || !session.selectedFolderId) {
            sendLine(socket, `${tag} NO No mailbox selected`)
            return
        }
        sendLine(socket, '+ idling')
        session.idleTag = tag

        const listener = async (payload: MailEventPayload) => {
            if (payload.folderId !== session.selectedFolderId) return
            try {
                await queueSelectedSync(session)
            } catch (err) {
                console.error('[IMAP] IDLE listener error:', err)
            }
        }
        session.idleListener = listener
        mailEvents.on('folder-change', listener)
        return
    }

    sendLine(socket, `${tag} BAD Unknown command: ${command}`)
}

// ─── AUTHENTICATE completion ──────────────────────────────────────────────────

async function tryAuthenticate(session: IMAPSession, tag: string, email: string, password: string): Promise<boolean> {
    const account = await authenticateNativeUser(email, password)
    if (!account) {
        recordAuthFailure(session.ip)
        sendLine(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`)
        return false
    }
    clearAuthFailures(session.ip)
    session.state = 'authenticated'
    session.userId = account.id
    session.userEmail = account.email
    console.log(`[IMAP] Auth ok (SASL): ${email} (ip=${session.ip} tls=${session.isTLS})`)
    sendLine(session.socket, `${tag} OK [CAPABILITY ${capabilities(session)}] AUTHENTICATE completed`)
    return true
}

async function completeAuthPlain(session: IMAPSession, tag: string, b64: string) {
    try {
        const decoded = Buffer.from(b64, 'base64').toString('utf8')
        // Expected: "\0user\0pass" or "authzid\0user\0pass"
        const parts = decoded.split('\0')
        if (parts.length < 3) {
            recordAuthFailure(session.ip)
            sendLine(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Malformed SASL PLAIN`)
            return
        }
        const [, username, password] = parts
        await tryAuthenticate(session, tag, username, password)
    } catch {
        recordAuthFailure(session.ip)
        sendLine(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Bad base64`)
    }
    session.pendingAuth = null
}

async function completeAuthLoginUsername(session: IMAPSession, b64: string) {
    try {
        session.pendingAuth!.username = Buffer.from(b64, 'base64').toString('utf8')
        session.pendingAuth!.step = 1
        sendLine(session.socket, '+ ' + Buffer.from('Password:').toString('base64'))
    } catch {
        const tag = session.pendingAuth!.tag
        session.pendingAuth = null
        recordAuthFailure(session.ip)
        sendLine(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Bad base64`)
    }
}

async function completeAuthLoginPassword(session: IMAPSession, b64: string) {
    const tag = session.pendingAuth!.tag
    const username = session.pendingAuth!.username || ''
    try {
        const password = Buffer.from(b64, 'base64').toString('utf8')
        await tryAuthenticate(session, tag, username, password)
    } catch {
        recordAuthFailure(session.ip)
        sendLine(session.socket, `${tag} NO [AUTHENTICATIONFAILED] Bad base64`)
    }
    session.pendingAuth = null
}

// ─── UID command dispatch ─────────────────────────────────────────────────────

async function handleUidCommand(
    session: IMAPSession,
    tag: string,
    subCmd: string,
    subArgs: string,
    completionCommand = `UID ${subCmd}`,
) {
    const socket = session.socket

    if (session.state !== 'selected' || !session.selectedFolderId) {
        sendLine(socket, `${tag} NO No mailbox selected`)
        return
    }

    const msgs = await loadFolderMessages(session.selectedFolderId!)

    // Build UID ↔ sequence number map. For legacy rows with remote_uid=null,
    // fall back to sequence number as UID.
    const byUid = new Map<number, { msg: LightMailMessage; seqNum: number }>()
    let maxUid = 0
    msgs.forEach((m, i) => {
        const uid = m.remoteUid ?? (i + 1)
        byUid.set(uid, { msg: m, seqNum: i + 1 })
        if (uid > maxUid) maxUid = uid
    })

    function uidSetToEntries(set: string) {
        const uids = parseSequenceSet(set, maxUid || 1)
        return uids
            .map(u => byUid.get(u))
            .filter((e): e is NonNullable<typeof e> => !!e)
    }

    if (subCmd === 'FETCH') {
        const match = subArgs.match(/^(\S+)\s+(.+)$/)
        if (!match) { sendLine(socket, `${tag} BAD UID FETCH syntax error`); return }
        const [, uidSet, itemStr] = match
        const items = parseFetchItems(itemStr)
        if (!items.map(i => i.toUpperCase()).includes('UID')) items.push('UID')
        const entries = uidSetToEntries(uidSet)
        const payloads = needsBodies(items)
            ? await loadMessagePayloads(entries.map(e => e.msg.id))
            : new Map()
        for (const { msg, seqNum } of entries) {
            sendLine(socket, await buildFetchResponse(seqNum, withBodies(msg, payloads), items))
        }
        // Mark as seen for non-PEEK BODY fetches
        const fetchesBody = items.some(i => /BODY\[(?!.*PEEK)/.test(i.toUpperCase()) || i.toUpperCase() === 'RFC822')
        if (fetchesBody && !session.selectedReadOnly) {
            for (const { msg } of entries) {
                if (!msg.isRead) {
                    await db.update(mailMessages)
                        .set({ isRead: true, updatedAt: new Date() })
                        .where(eq(mailMessages.id, msg.id))
                    updateSelectedSnapshot(session, msg.id, { isRead: true })
                }
            }
            await recomputeFolderCounts(session.selectedFolderId!)
        }
        sendLine(socket, `${tag} OK UID FETCH completed`)
        return
    }

    if (subCmd === 'STORE') {
        if (session.selectedReadOnly) { sendLine(socket, `${tag} NO Folder is read-only`); return }
        const match = subArgs.match(/^(\S+)\s+([+-]?FLAGS(?:\.SILENT)?)\s+(.+)$/)
        if (!match) { sendLine(socket, `${tag} BAD UID STORE syntax error`); return }
        const [, uidSet, flagOp, flagList] = match
        const flagStr = flagList.replace(/[()]/g, '').toUpperCase()
        const silent = flagOp.includes('.SILENT')
        const flags = flagStr.split(/\s+/)

        for (const { msg, seqNum } of uidSetToEntries(uidSet)) {
            const updates: Partial<{ isRead: boolean; isStarred: boolean; isDeleted: boolean; isDraft: boolean; updatedAt: Date }> = { updatedAt: new Date() }
            const applyFlag = (flag: string, value: boolean) => {
                if (flag === '\\SEEN') updates.isRead = value
                if (flag === '\\FLAGGED') updates.isStarred = value
                if (flag === '\\DELETED') updates.isDeleted = value
                if (flag === '\\DRAFT') updates.isDraft = value
            }
            if (flagOp.startsWith('+')) flags.forEach(f => applyFlag(f, true))
            else if (flagOp.startsWith('-')) flags.forEach(f => applyFlag(f, false))
            else {
                updates.isRead = flags.includes('\\SEEN')
                updates.isStarred = flags.includes('\\FLAGGED')
                updates.isDeleted = flags.includes('\\DELETED')
                updates.isDraft = flags.includes('\\DRAFT')
            }
            await db.update(mailMessages).set(updates).where(eq(mailMessages.id, msg.id))
            updateSelectedSnapshot(session, msg.id, updates)
            if (!silent) {
                const updated = { ...msg, ...updates }
                sendLine(socket, `* ${seqNum} FETCH (UID ${msg.remoteUid ?? seqNum} FLAGS ${flagsToIMAP(updated as typeof msg)})`)
            }
        }
        await recomputeFolderCounts(session.selectedFolderId!)
        emitFolderChange({
            folderId: session.selectedFolderId!,
            mailboxId: session.selectedMailboxId!,
            kind: 'flags',
        })
        sendLine(socket, `${tag} OK UID STORE completed`)
        return
    }

    if (subCmd === 'COPY') {
        const match = subArgs.match(/^(\S+)\s+"?([^"\s]+)"?$/)
        if (!match) { sendLine(socket, `${tag} BAD UID COPY syntax error`); return }
        const [, uidSet, destFolderName] = match

        const destFolder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, session.selectedMailboxId!),
                eq(mailFolders.remoteId, destFolderName),
            ),
        })
        if (!destFolder) { sendLine(socket, `${tag} NO [TRYCREATE] No such mailbox`); return }

        const copiedUids: number[] = []
        const srcUids: number[] = []
        const copyEntries = uidSetToEntries(uidSet)
        const copyPayloads = await loadMessagePayloads(copyEntries.map(e => e.msg.id))
        for (const { msg } of copyEntries) {
            const payload = copyPayloads.get(msg.id)
            const newUid = await allocateNextUid(destFolder.id)
            await db.insert(mailMessages).values({
                mailboxId: msg.mailboxId,
                folderId: destFolder.id,
                messageId: msg.messageId,
                inReplyTo: msg.inReplyTo,
                references: msg.references,
                subject: msg.subject,
                fromAddress: msg.fromAddress,
                fromName: msg.fromName,
                // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação.
                toAddresses: jsonbParam(msg.toAddresses ?? []),
                ccAddresses: jsonbParam(msg.ccAddresses ?? []),
                bccAddresses: jsonbParam(msg.bccAddresses ?? []),
                plainBody: payload?.plainBody ?? null,
                htmlBody: payload?.htmlBody ?? null,
                headers: jsonbParam(payload?.headers ?? {}),
                hasAttachments: msg.hasAttachments,
                attachments: jsonbParam(payload?.attachments ?? []),
                isRead: msg.isRead,
                isStarred: msg.isStarred,
                isDeleted: msg.isDeleted,
                isDraft: msg.isDraft,
                remoteUid: newUid,
                remoteDate: msg.remoteDate,
                receivedAt: msg.receivedAt,
                size: msg.size,
            })
            copiedUids.push(newUid)
            srcUids.push(msg.remoteUid ?? 0)
        }
        await recomputeFolderCounts(destFolder.id)
        emitFolderChange({ folderId: destFolder.id, mailboxId: session.selectedMailboxId!, kind: 'new' })

        const uidValidity = destFolder.uidValidity || 1
        sendLine(socket, `${tag} OK [COPYUID ${uidValidity} ${srcUids.join(',')} ${copiedUids.join(',')}] UID COPY completed`)
        return
    }

    if (subCmd === 'MOVE') {
        if (session.selectedReadOnly) { sendLine(socket, `${tag} NO Folder is read-only`); return }
        const match = subArgs.match(/^(\S+)\s+"?([^"\s]+)"?$/)
        if (!match) { sendLine(socket, `${tag} BAD UID MOVE syntax error`); return }
        const [, uidSet, destFolderName] = match

        const destFolder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, session.selectedMailboxId!),
                eq(mailFolders.remoteId, destFolderName),
            ),
        })
        if (!destFolder) { sendLine(socket, `${tag} NO [TRYCREATE] No such mailbox`); return }
        if (destFolder.id === session.selectedFolderId) {
            sendLine(socket, `${tag} NO Source and destination mailboxes are the same`)
            return
        }

        const moveEntries = uidSetToEntries(uidSet)
        const payloads = await loadMessagePayloads(moveEntries.map(entry => entry.msg.id))

        const moved = await db.transaction(async (tx) => {
            const destinationUids: number[] = []

            for (const { msg } of moveEntries) {
                const [allocated] = await tx.update(mailFolders)
                    .set({ uidNext: sql`${mailFolders.uidNext} + 1`, updatedAt: new Date() })
                    .where(eq(mailFolders.id, destFolder.id))
                    .returning({ next: mailFolders.uidNext })
                if (!allocated) throw new Error(`Destination folder ${destFolder.id} disappeared during MOVE`)
                const newUid = allocated.next - 1
                const payload = payloads.get(msg.id)

                await tx.insert(mailMessages).values({
                    mailboxId: msg.mailboxId,
                    folderId: destFolder.id,
                    messageId: msg.messageId,
                    inReplyTo: msg.inReplyTo,
                    references: msg.references,
                    subject: msg.subject,
                    fromAddress: msg.fromAddress,
                    fromName: msg.fromName,
                    // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação.
                    toAddresses: jsonbParam(msg.toAddresses ?? []),
                    ccAddresses: jsonbParam(msg.ccAddresses ?? []),
                    bccAddresses: jsonbParam(msg.bccAddresses ?? []),
                    plainBody: payload?.plainBody ?? null,
                    htmlBody: payload?.htmlBody ?? null,
                    headers: jsonbParam(payload?.headers ?? {}),
                    hasAttachments: msg.hasAttachments,
                    attachments: jsonbParam(payload?.attachments ?? []),
                    isRead: msg.isRead,
                    isStarred: msg.isStarred,
                    isDeleted: false,
                    isDraft: msg.isDraft,
                    remoteUid: newUid,
                    remoteDate: msg.remoteDate,
                    receivedAt: msg.receivedAt,
                    size: msg.size,
                })
                destinationUids.push(newUid)
            }

            if (moveEntries.length > 0) {
                await tx.delete(mailMessages).where(inArray(mailMessages.id, moveEntries.map(entry => entry.msg.id)))
            }
            return destinationUids
        })

        for (const { seqNum } of [...moveEntries].sort((a, b) => b.seqNum - a.seqNum)) {
            sendLine(socket, `* ${seqNum} EXPUNGE`)
        }
        const movedIds = new Set(moveEntries.map(({ msg }) => msg.id))
        session.selectedMessages = msgs.filter(message => !movedIds.has(message.id))
        session.knownMessageCount = session.selectedMessages.length

        await recomputeFolderCounts(session.selectedFolderId!)
        await recomputeFolderCounts(destFolder.id)
        emitFolderChange({
            folderId: session.selectedFolderId!,
            mailboxId: session.selectedMailboxId!,
            kind: 'expunge',
        })
        emitFolderChange({ folderId: destFolder.id, mailboxId: session.selectedMailboxId!, kind: 'new' })

        const sourceUids = moveEntries.map(({ msg }) => msg.remoteUid ?? 0)
        sendLine(socket, `${tag} OK [COPYUID ${destFolder.uidValidity || 1} ${sourceUids.join(',')} ${moved.join(',')}] ${completionCommand} completed`)
        return
    }

    if (subCmd === 'SEARCH') {
        const upperArgs = subArgs.toUpperCase()
        const results: number[] = []
        for (const { msg } of Array.from(byUid.values()).sort((a, b) => a.seqNum - b.seqNum)) {
            let match = true
            if (upperArgs.includes('UNSEEN') && msg.isRead) match = false
            if (upperArgs.includes('SEEN') && !msg.isRead) match = false
            if (upperArgs.includes('FLAGGED') && !msg.isStarred) match = false
            if (upperArgs.includes('UNFLAGGED') && msg.isStarred) match = false
            if (upperArgs.includes('DRAFT') && !msg.isDraft) match = false
            const subjectMatch = subArgs.match(/SUBJECT\s+"([^"]+)"/i)
            if (subjectMatch && !msg.subject?.toLowerCase().includes(subjectMatch[1].toLowerCase())) match = false
            const fromMatch = subArgs.match(/FROM\s+"([^"]+)"/i)
            if (fromMatch && !msg.fromAddress?.toLowerCase().includes(fromMatch[1].toLowerCase())) match = false
            if (upperArgs === 'ALL') match = true
            if (match) results.push(msg.remoteUid ?? 0)
        }
        sendLine(socket, `* SEARCH ${results.filter(u => u > 0).join(' ')}`)
        sendLine(socket, `${tag} OK UID SEARCH completed`)
        return
    }

    if (subCmd === 'EXPUNGE') {
        // RFC 4315 (UIDPLUS): permanently remove messages that BOTH carry \Deleted AND have a
        // UID in the given set. We advertise UIDPLUS in CAPABILITY, so clients (Thunderbird)
        // prefer this over plain EXPUNGE to avoid expunging messages another session just
        // flagged. Without this branch the command fell through to "BAD Unknown UID subcommand",
        // which is the error the user saw and which left folders uncompactable over IMAP.
        if (session.selectedReadOnly) { sendLine(socket, `${tag} NO Folder is read-only`); return }
        const set = subArgs.trim()
        if (!set) { sendLine(socket, `${tag} BAD UID EXPUNGE requires a UID set`); return }

        // Size `*` against the largest UID in the selected mailbox.
        const withDeleted = await loadFolderMessages(session.selectedFolderId!)
        let maxUidAll = maxUid
        for (const m of withDeleted) { if ((m.remoteUid ?? 0) > maxUidAll) maxUidAll = m.remoteUid ?? 0 }
        const targetUids = new Set(parseSequenceSet(set, maxUidAll || 1))

        const removed = withDeleted
            .map((msg, index) => ({ msg, seqNum: index + 1 }))
            .filter(({ msg }) => msg.isDeleted && msg.remoteUid != null && targetUids.has(msg.remoteUid))
            .sort((a, b) => b.seqNum - a.seqNum)

        if (removed.length > 0) {
            await db.delete(mailMessages).where(inArray(mailMessages.id, removed.map(({ msg }) => msg.id)))
            for (const { seqNum } of removed) sendLine(socket, `* ${seqNum} EXPUNGE`)
            session.selectedMessages = withDeleted.filter(message => !removed.some(({ msg }) => msg.id === message.id))
            session.knownMessageCount = session.selectedMessages.length
            await recomputeFolderCounts(session.selectedFolderId!)
            emitFolderChange({
                folderId: session.selectedFolderId!,
                mailboxId: session.selectedMailboxId!,
                kind: 'expunge',
            })
        }
        sendLine(socket, `${tag} OK UID EXPUNGE completed`)
        return
    }

    sendLine(socket, `${tag} BAD Unknown UID subcommand: ${subCmd}`)
}

// ─── APPEND literal completion ────────────────────────────────────────────────

async function completeAppend(session: IMAPSession, pending: PendingLiteral, literal: Buffer) {
    const socket = session.socket
    if (session.state === 'not_authenticated') {
        sendLine(socket, `${pending.tag} NO Authenticate first`)
        return
    }

    const companion = await db.query.mailboxes.findFirst({
        where: and(
            eq(mailboxes.email, session.userEmail!.toLowerCase()),
            eq(mailboxes.userId, session.userId!)
        ),
    })
    if (!companion) {
        sendLine(socket, `${pending.tag} NO Mailbox not found`)
        return
    }

    const folder = await db.query.mailFolders.findFirst({
        where: and(
            eq(mailFolders.mailboxId, companion.id),
            eq(mailFolders.remoteId, pending.folderName)
        ),
    }) as DBFolder | undefined

    if (!folder) {
        sendLine(socket, `${pending.tag} NO [TRYCREATE] No such mailbox`)
        return
    }

    try {
        const parsed = await parseRawEmail(literal)
        const messageId = parsed.messageId || `<${randomUUID()}@skaleclub.mail>`
        const flags = pending.flags
        const assignedUid = await allocateNextUid(folder.id)

        await db.insert(mailMessages).values({
            mailboxId: companion.id,
            folderId: folder.id,
            messageId,
            inReplyTo: parsed.inReplyTo,
            references: parsed.references,
            subject: parsed.subject,
            fromAddress: parsed.from.address,
            fromName: parsed.from.name,
            // jsonbParam: ver lib/jsonb.ts — o cast via text impede a segunda codificação.
            toAddresses: jsonbParam(parsed.to ?? []),
            ccAddresses: jsonbParam(parsed.cc ?? []),
            bccAddresses: jsonbParam(parsed.bcc ?? []),
            plainBody: parsed.plainBody,
            htmlBody: parsed.htmlBody,
            headers: jsonbParam(parsed.headers ?? {}),
            hasAttachments: parsed.hasAttachments,
            attachments: jsonbParam(parsed.attachments.map(a => ({
                filename: a.filename,
                contentType: a.contentType,
                size: a.size,
            }))),
            isRead: flags.includes('\\SEEN'),
            isStarred: flags.includes('\\FLAGGED'),
            isDeleted: flags.includes('\\DELETED'),
            isDraft: flags.includes('\\DRAFT') || folder.type === 'drafts',
            remoteUid: assignedUid,
            remoteDate: parsed.date,
            receivedAt: parsed.date || new Date(),
            size: literal.length,
        }).onConflictDoNothing()

        await recomputeFolderCounts(folder.id)
        emitFolderChange({ folderId: folder.id, mailboxId: companion.id, kind: 'new' })

        sendLine(socket, `${pending.tag} OK [APPENDUID ${folder.uidValidity || 1} ${assignedUid}] APPEND completed`)
    } catch (err) {
        console.error('[IMAP] APPEND error:', (err as Error).message)
        sendLine(socket, `${pending.tag} NO APPEND failed: ${(err as Error).message}`)
    }
}

// ─── Buffer processor ─────────────────────────────────────────────────────────

async function processBuffer(session: IMAPSession) {
    if (session.processing) return
    session.processing = true
    try {
        while (true) { // eslint-disable-line no-constant-condition
            if (session.pendingLiteral) {
                const need = session.pendingLiteral.remaining
                if (session.buffer.length >= need) {
                    session.pendingLiteral.chunks.push(session.buffer.subarray(0, need))
                    session.buffer = session.buffer.subarray(need)
                    const full = Buffer.concat(session.pendingLiteral.chunks)
                    const pending = session.pendingLiteral
                    session.pendingLiteral = null
                    await completeAppend(session, pending, full)
                    // After literal, consume optional trailing CRLF
                    if (session.buffer.length >= 2 && session.buffer[0] === 0x0D && session.buffer[1] === 0x0A) {
                        session.buffer = session.buffer.subarray(2)
                    }
                    continue
                } else {
                    session.pendingLiteral.chunks.push(session.buffer)
                    session.pendingLiteral.remaining -= session.buffer.length
                    session.buffer = Buffer.alloc(0)
                    break
                }
            }

            const crlfIdx = session.buffer.indexOf('\r\n')
            if (crlfIdx === -1) break
            const line = session.buffer.subarray(0, crlfIdx).toString('utf8')
            session.buffer = session.buffer.subarray(crlfIdx + 2)

            if (!line.trim()) continue

            // IDLE DONE
            if (session.idleListener && line.trim().toUpperCase() === 'DONE') {
                mailEvents.off('folder-change', session.idleListener)
                session.idleListener = null
                sendLine(session.socket, `${session.idleTag} OK IDLE terminated`)
                session.idleTag = null
                continue
            }

            // SASL continuation (AUTHENTICATE in-flight)
            if (session.pendingAuth) {
                const trimmed = line.trim()
                // Client cancellation per RFC 3501 §6.2.2
                if (trimmed === '*') {
                    const tag = session.pendingAuth.tag
                    session.pendingAuth = null
                    sendLine(session.socket, `${tag} BAD AUTHENTICATE cancelled`)
                    continue
                }
                if (session.pendingAuth.mechanism === 'PLAIN') {
                    await completeAuthPlain(session, session.pendingAuth.tag, trimmed)
                } else if (session.pendingAuth.mechanism === 'LOGIN') {
                    if (session.pendingAuth.step === 0) {
                        await completeAuthLoginUsername(session, trimmed)
                    } else {
                        await completeAuthLoginPassword(session, trimmed)
                    }
                }
                continue
            }

            // APPEND with literal — detect before dispatch
            const appendLiteralMatch = line.match(/^(\S+)\s+APPEND\s+(.+?)\s*\{(\d+)(\+?)\}\s*$/i)
            if (appendLiteralMatch) {
                const [, tag, appendArgs, sizeStr, plus] = appendLiteralMatch
                const size = parseInt(sizeStr)
                if (size > MAX_BUFFER_BYTES) {
                    sendLine(session.socket, `${tag} NO Message too large`)
                    continue
                }

                // Extract folder + flag list from appendArgs
                const folderMatch = appendArgs.match(/^"?([^"\s(]+)"?\s*(\([^)]*\))?\s*(".*")?$/)
                const folderName = folderMatch?.[1] || appendArgs.trim()
                const flagsPart = folderMatch?.[2] || ''
                const flags = (flagsPart.match(/\\\w+/g) || []).map(f => f.toUpperCase())

                if (session.state === 'not_authenticated') {
                    sendLine(session.socket, `${tag} NO Authenticate first`)
                    continue
                }

                session.pendingLiteral = {
                    tag,
                    type: 'APPEND',
                    folderName,
                    flags,
                    chunks: [],
                    remaining: size,
                    noResponse: plus === '+',
                }
                if (!session.pendingLiteral.noResponse) {
                    sendLine(session.socket, '+ Ready for literal data')
                }
                continue
            }

            // Parse tag command [args]
            const firstSpace = line.indexOf(' ')
            if (firstSpace === -1) continue
            const tag = line.substring(0, firstSpace)
            const rest = line.substring(firstSpace + 1)
            const secondSpace = rest.indexOf(' ')
            const command = secondSpace === -1 ? rest : rest.substring(0, secondSpace)
            const args = secondSpace === -1 ? '' : rest.substring(secondSpace + 1)

            try {
                await handleCommand(session, tag, command, args)
            } catch (err) {
                console.error(`[IMAP] Command error (${command}):`, err)
                sendLine(session.socket, `${tag} NO Internal server error`)
            }

            if (session.state === 'logout') break
        }
    } finally {
        session.processing = false
    }
}

// ─── Socket wiring ───────────────────────────────────────────────────────────

function attachSocketHandlers(session: IMAPSession) {
    const socket = session.socket

    socket.on('data', (chunk: Buffer) => {
        if (session.buffer.length + chunk.length > MAX_BUFFER_BYTES) {
            sendLine(socket, '* BYE Input buffer exceeded')
            socket.destroy()
            return
        }
        session.buffer = Buffer.concat([session.buffer, chunk])
        processBuffer(session).catch(err => console.error('[IMAP] processBuffer error:', err))
    })

    socket.on('error', (err: Error) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
            console.error('[IMAP] Socket error:', err.message)
        }
    })

    socket.on('close', () => {
        if (session.idleListener) {
            mailEvents.off('folder-change', session.idleListener)
            session.idleListener = null
        }
    })
}

function detachSocketHandlers(socket: IMAPSocket) {
    socket.removeAllListeners('data')
    socket.removeAllListeners('error')
    socket.removeAllListeners('close')
}

function upgradeToTLS(session: IMAPSession, opts: { key: Buffer; cert: Buffer }) {
    detachSocketHandlers(session.socket)
    const secure = new tls.TLSSocket(session.socket as net.Socket, {
        isServer: true,
        key: opts.key,
        cert: opts.cert,
    })
    session.socket = secure
    session.isTLS = true
    session.buffer = Buffer.alloc(0) // Reset — any buffered plaintext is invalid now
    attachSocketHandlers(session)
}

function handleConnection(socket: IMAPSocket, isTLS: boolean) {
    const ip = socket.remoteAddress || 'unknown'

    if (isIpLocked(ip)) {
        sendLine(socket, '* BYE Too many failed auth attempts from this IP')
        socket.destroy()
        return
    }

    const session: IMAPSession = {
        socket,
        ip,
        isTLS,
        state: 'not_authenticated',
        userId: null,
        userEmail: null,
        selectedMailboxId: null,
        selectedFolderId: null,
        selectedReadOnly: false,
        selectedUidValidity: 1,
        selectedMessages: [],
        selectedSync: Promise.resolve(),
        buffer: Buffer.alloc(0),
        pendingLiteral: null,
        pendingAuth: null,
        idleTag: null,
        idleListener: null,
        knownMessageCount: 0,
        processing: false,
    }

    sendLine(socket, `* OK [CAPABILITY ${capabilities(session)}] ${_imapAppName} IMAP server ready`)
    attachSocketHandlers(session)
}

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

export function createIMAPServer() {
    const port = parseInt(process.env.IMAP_PORT || '2993')
    const tlsOpts = getMailTLSOptions()

    const server: net.Server | tls.Server = tlsOpts
        ? tls.createServer(
            { key: tlsOpts.key, cert: tlsOpts.cert },
            (socket) => handleConnection(socket, true)
        )
        : net.createServer((socket) => handleConnection(socket, false))

    server.on('error', (err: Error) => {
        console.error('[IMAP] Server error:', err.message)
    })

    return {
        start() {
            server.listen(port, '0.0.0.0', () => {
                const proto = tlsOpts ? 'SSL/TLS (implicit)' : 'plaintext (STARTTLS unavailable)'
                console.log(`[IMAP] Server listening on port ${port} — ${proto}`)
            })
        },
        close(): Promise<void> {
            return new Promise((resolve) => {
                server.close(() => resolve())
            })
        },
    }
}
