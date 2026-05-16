/* eslint-disable @typescript-eslint/no-explicit-any */
import Imap from 'imap'
import { simpleParser } from 'mailparser'
import { db } from '../../db'
import { mailboxes, mailFolders, mailMessages } from '../../db/schema'
import { eq, and, gt, or, isNull, desc } from 'drizzle-orm'
import { decryptSecret } from './crypto'

interface SyncResult {
    mailboxId: string
    folderId: string
    newMessages: number
    errors: string[]
}

interface FolderInfo {
    remoteId: string
    name: string
    type: string
}

interface SyncConfig {
    maxRetries: number
    retryDelay: number
    batchSize: number
    enableIdle: boolean
}

const DEFAULT_CONFIG: SyncConfig = {
    maxRetries: 3,
    retryDelay: 1000,
    batchSize: 50,
    enableIdle: true,
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function withRetry<T>(
    fn: () => Promise<T>,
    config: SyncConfig = DEFAULT_CONFIG
): Promise<T> {
    let lastError: Error | null = null
    
    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
            console.log(`Attempt ${attempt}/${config.maxRetries} failed: ${lastError.message}`)
            
            if (attempt < config.maxRetries) {
                const delay = config.retryDelay * Math.pow(2, attempt - 1)
                await sleep(delay)
            }
        }
    }
    
    throw lastError
}

function createImapConnection(mailbox: any, isIdle = false): Imap {
    const config: any = {
        user: mailbox.imapUsername,
        password: decryptSecret(mailbox.imapPasswordEncrypted),
        host: mailbox.imapHost,
        port: mailbox.imapPort,
        tls: mailbox.imapSecure,
        // SEC-02 — strict TLS by default; per-mailbox opt-in for self-signed
        // see .planning/debug/system-wide-audit-2026-05-16.md H5
        tlsOptions: {
            rejectUnauthorized: !mailbox.skipTlsVerify,
        },
        connectionTimeout: 30000,
        authTimeout: 15000,
    }
    
    if (isIdle) {
        config.keepalive = {
            interval: 30000,
            idleTimeout: 300000
        }
    }
    
    return new Imap(config)
}

export async function syncMailbox(
    mailboxId: string, 
    config: SyncConfig = DEFAULT_CONFIG
): Promise<SyncResult> {
    const result: SyncResult = {
        mailboxId,
        folderId: '',
        newMessages: 0,
        errors: [],
    }

    const mailbox = await db.query.mailboxes.findFirst({
        where: eq(mailboxes.id, mailboxId),
    })

    if (!mailbox) {
        throw new Error('Mailbox not found')
    }

    if (mailbox.isNative || !mailbox.imapPasswordEncrypted) {
        return result
    }

    const imapConfig = {
        user: mailbox.imapUsername,
        password: decryptSecret(mailbox.imapPasswordEncrypted),
        host: mailbox.imapHost,
        port: mailbox.imapPort,
        tls: mailbox.imapSecure,
    }

    try {
        await withRetry(
            () => syncAllFolders(mailboxId, imapConfig, config, result),
            config
        )

        await db.update(mailboxes)
            .set({ 
                lastSyncAt: new Date(),
                syncError: result.errors.length > 0 ? result.errors[0] : null,
            })
            .where(eq(mailboxes.id, mailboxId))

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        result.errors.push(message)
        
        await db.update(mailboxes)
            .set({ syncError: message })
            .where(eq(mailboxes.id, mailboxId))
    }

    return result
}

async function syncAllFolders(
    mailboxId: string,
    imapConfig: any,
    config: SyncConfig,
    result: SyncResult
): Promise<void> {
    const folders = await getAllFolders(mailboxId, imapConfig)
    
    for (const folder of folders) {
        let dbFolder = await db.query.mailFolders.findFirst({
            where: and(
                eq(mailFolders.mailboxId, mailboxId),
                eq(mailFolders.remoteId, folder.remoteId)
            ),
        })

        if (!dbFolder) {
            const inserted = await db.insert(mailFolders).values({
                mailboxId,
                remoteId: folder.remoteId,
                name: folder.name,
                type: folder.type,
            }).returning()
            dbFolder = inserted[0]
        }

        const folderResult = await syncFolder(
            mailboxId, 
            dbFolder.id, 
            folder.remoteId, 
            imapConfig, 
            config
        )
        
        result.newMessages += folderResult.newMessages
        result.errors.push(...folderResult.errors)

        await db.update(mailFolders)
            .set({
                unreadCount: folderResult.unreadCount,
                totalCount: folderResult.totalCount,
                updatedAt: new Date(),
            })
            .where(eq(mailFolders.id, dbFolder.id))
    }
}

async function getAllFolders(mailboxId: string, imapConfig: any): Promise<FolderInfo[]> {
    return new Promise((resolve, reject) => {
        const imap = createImapConnection({ ...imapConfig, id: mailboxId })

        imap.once('ready', () => {
            imap.getBoxes((err: any, boxes: any) => {
                if (err) {
                    imap.end()
                    reject(err)
                    return
                }

                const folders: FolderInfo[] = []

                const processBox = (box: any, path: string) => {
                    const fullPath = path ? `${path}${box.name}` : box.name
                    folders.push({
                        remoteId: fullPath,
                        name: box.name,
                        type: getFolderType(fullPath),
                    })

                    if (box.children) {
                        Object.entries(box.children).forEach(([_name, subBox]: [string, any]) => {
                            processBox(subBox, fullPath + '/')
                        })
                    }
                }

                if (boxes) {
                    Object.entries(boxes).forEach(([_name, box]: [string, any]) => {
                        processBox(box, '')
                    })
                }

                imap.end()
                resolve(folders)
            })
        })

        imap.once('error', (err: any) => {
            reject(err)
        })

        imap.connect()
    })
}

function getFolderType(remoteId: string): string {
    const upper = remoteId.toUpperCase()
    if (upper === 'INBOX') return 'inbox'
    if (upper === 'SENT' || upper === 'SENT MAIL' || upper.endsWith('SENT')) return 'sent'
    if (upper === 'DRAFTS' || upper.endsWith('DRAFTS')) return 'drafts'
    if (upper === 'TRASH' || upper === 'DELETED' || upper.endsWith('TRASH') || upper.endsWith('DELETED')) return 'trash'
    if (upper === 'SPAM' || upper === 'JUNK' || upper.endsWith('SPAM') || upper.endsWith('JUNK')) return 'spam'
    if (upper === 'ARCHIVE' || upper === 'ARCHIVES' || upper === 'ALL MAIL' || upper.endsWith('ARCHIVE') || upper.endsWith('ARCHIVES') || upper.endsWith('ALL MAIL')) return 'archive'
    return 'custom'
}

async function syncFolder(
    mailboxId: string,
    folderId: string,
    remoteId: string,
    imapConfig: any,
    config: SyncConfig
): Promise<{ newMessages: number; errors: string[]; unreadCount: number; totalCount: number }> {
    const result = {
        newMessages: 0,
        errors: [] as string[],
        unreadCount: 0,
        totalCount: 0,
    }

    return new Promise((resolve) => {
        const imap = createImapConnection({ ...imapConfig, id: mailboxId })

        imap.once('ready', () => {
            const boxName = remoteId
            
            imap.openBox(boxName, false, async (err: any, box: any) => {
                if (err) {
                    result.errors.push(`Failed to open ${boxName}: ${err.message}`)
                    imap.end()
                    resolve(result)
                    return
                }

                result.unreadCount = box.messages.unseen
                result.totalCount = box.messages.total

                try {
                    if (box.messages.total > 0) {
                        const { newCount, errors } = await fetchMessagesSync(
                            imap, 
                            mailboxId, 
                            folderId, 
                            box, 
                            config
                        )
                        result.newMessages = newCount
                        result.errors.push(...errors)
                    }
                } catch (error) {
                    const msg = error instanceof Error ? error.message : 'Unknown error'
                    result.errors.push(`Error syncing ${boxName}: ${msg}`)
                }

                imap.end()
                resolve(result)
            })
        })

        imap.once('error', (err: any) => {
            result.errors.push(`IMAP error: ${err.message}`)
            resolve(result)
        })

        imap.connect()
    })
}

async function fetchMessagesSync(
    imap: any,
    mailboxId: string,
    folderId: string,
    box: any,
    config: SyncConfig
): Promise<{ newCount: number; errors: string[] }> {
    const result = { newCount: 0, errors: [] as string[] }

    const lastKnownUid = await getLastKnownUid(mailboxId, folderId)
    const startUid = lastKnownUid ? lastKnownUid + 1 : 1

    if (startUid > box.messages.total) {
        return result
    }

    const rangeEnd = Math.min(startUid + config.batchSize - 1, box.messages.total)
    const uidRange = `${startUid}:${rangeEnd}`

    return new Promise((resolve) => {
        const fetch = imap.fetch(uidRange, {
            bodies: '',
            struct: true,
        })

        let completed = 0
        const totalMessages = rangeEnd - startUid + 1

        fetch.on('message', (msg: any) => {
            let uid: number | null = null
            let messageId: string | null = null
            let raw = ''

            msg.on('attributes', (attrs: any) => {
                uid = attrs.uid
                const headers = attrs.headers
                if (headers) {
                    const msgIdHeader = headers.find((h: any) => h.key === 'message-id')
                    messageId = msgIdHeader ? msgIdHeader.value : null
                }
            })

            msg.on('body', (stream: any) => {
                stream.on('data', (chunk: any) => {
                    raw += chunk.toString('utf8')
                })
            })

            msg.once('end', async () => {
                completed++

                if (uid) {
                    try {
                        const existing = await db.query.mailMessages.findFirst({
                            where: and(
                                eq(mailMessages.mailboxId, mailboxId),
                                eq(mailMessages.folderId, folderId),
                                eq(mailMessages.remoteUid, uid)
                            ),
                        })

                        if (!existing && raw) {
                            const parsed = await simpleParser(raw)

                            const refs = parsed.references
                            const refsStr = Array.isArray(refs) ? refs.join(' ') : refs || null
                            const toObj = parsed.to && !Array.isArray(parsed.to) ? parsed.to : Array.isArray(parsed.to) ? parsed.to[0] : undefined

                            await db.insert(mailMessages).values({
                                mailboxId,
                                folderId,
                                messageId: parsed.messageId || null,
                                inReplyTo: parsed.inReplyTo || null,
                                references: refsStr,
                                subject: parsed.subject || null,
                                fromAddress: parsed.from?.value[0]?.address || null,
                                fromName: parsed.from?.value[0]?.name || null,
                                toAddresses: toObj?.value.map(v => ({
                                    name: v.name,
                                    address: v.address
                                })) || [],
                                plainBody: parsed.text || null,
                                htmlBody: parsed.html as string || null,
                                headers: {},
                                hasAttachments: parsed.attachments.length > 0,
                                attachments: parsed.attachments.map((att: any) => ({
                                    filename: att.filename,
                                    contentType: att.contentType,
                                    size: att.size,
                                })),
                                isRead: false,
                                isDraft: false,
                                remoteUid: uid,
                                remoteDate: parsed.date || null,
                                receivedAt: parsed.date || new Date(),
                            })

                            result.newCount++
                        }
                    } catch (error) {
                        console.error('Error processing message:', error)
                        result.errors.push(`Error processing UID ${uid}: ${error}`)
                    }
                }

                if (completed >= totalMessages) {
                    resolve(result)
                }
            })
        })

        fetch.once('error', (err: any) => {
            console.error('Fetch error:', err)
            result.errors.push(`Fetch error: ${err.message}`)
            resolve(result)
        })
    })
}

async function getLastKnownUid(mailboxId: string, folderId: string): Promise<number | null> {
    const lastMessage = await db.query.mailMessages.findFirst({
        where: and(
            eq(mailMessages.mailboxId, mailboxId),
            eq(mailMessages.folderId, folderId)
        ),
        orderBy: [desc(mailMessages.remoteUid)],
    })

    return lastMessage?.remoteUid || null
}

export async function syncAllMailboxes(): Promise<SyncResult[]> {
    const mailboxesToSync = await db.query.mailboxes.findMany({
        where: and(
            eq(mailboxes.isActive, true),
            eq(mailboxes.isNative, false)
        ),
    })

    const results: SyncResult[] = []

    for (const mailbox of mailboxesToSync) {
        const result = await syncMailbox(mailbox.id)
        results.push(result)
    }

    return results
}

export async function startMailboxIdle(mailboxId: string): Promise<void> {
    const mailbox = await db.query.mailboxes.findFirst({
        where: eq(mailboxes.id, mailboxId),
    })

    if (!mailbox) {
        throw new Error('Mailbox not found')
    }

    const imapConfig = {
        user: mailbox.imapUsername,
        password: decryptSecret(mailbox.imapPasswordEncrypted),
        host: mailbox.imapHost,
        port: mailbox.imapPort,
        tls: mailbox.imapSecure,
    }

    const imap = createImapConnection({ ...imapConfig, id: mailboxId }, true)

    imap.once('ready', () => {
        console.log(`IMAP IDLE started for mailbox ${mailboxId}`)
        
        imap.on('mail', async (count: number) => {
            console.log(`New emails detected for mailbox ${mailboxId}: ${count}`)
            await syncMailbox(mailboxId)
        })

        imap.on('error', (err: any) => {
            console.error(`IMAP IDLE error for mailbox ${mailboxId}:`, err)
        })
    })

    imap.connect()
}

export function stopMailboxIdle(mailboxId: string): void {
    console.log(`IMAP IDLE stopped for mailbox ${mailboxId}`)
}

/**
 * Test SMTP + IMAP connectivity for a mailbox configuration.
 *
 * SEC-02 — `skipTlsVerify` defaults to false (strict TLS).
 * See .planning/debug/system-wide-audit-2026-05-16.md H5.
 */
export async function testMailboxConnection(
    smtpHost: string,
    smtpPort: number,
    smtpSecure: boolean,
    smtpUsername: string,
    smtpPassword: string,
    imapHost: string,
    imapPort: number,
    imapSecure: boolean,
    imapUsername: string,
    imapPassword: string,
    skipTlsVerify: boolean = false
): Promise<{ smtp: boolean; imap: boolean; errors: string[] }> {
    const result = { smtp: false, imap: false, errors: [] as string[] }

    const smtpConfig = {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
            user: smtpUsername,
            pass: smtpPassword,
        },
        connectionTimeout: 10000,
    }

    try {
        const nodemailer = await import('nodemailer')
        const transporter = nodemailer.createTransport(smtpConfig)
        await transporter.verify()
        result.smtp = true
    } catch (error) {
        result.errors.push(`SMTP: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
        const Imap = (await import('imap')).default
        const imapTest = new Imap({
            user: imapUsername,
            password: imapPassword,
            host: imapHost,
            port: imapPort,
            tls: imapSecure,
            // SEC-02 — strict TLS by default; opt-in via skipTlsVerify arg
            tlsOptions: { rejectUnauthorized: !skipTlsVerify },
        })

        await new Promise<void>((resolve, reject) => {
            imapTest.once('ready', () => {
                imapTest.end()
                resolve()
            })
            imapTest.once('error', (err: any) => {
                reject(err)
            })
            imapTest.connect()
        })
        result.imap = true
    } catch (error) {
        result.errors.push(`IMAP: ${error instanceof Error ? error.message : String(error)}`)
    }

    return result
}
