import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { eq, and, desc, inArray, sql, ilike, or } from 'drizzle-orm'
import Imap from 'imap'
import { db } from '../../../db'
import { mailMessages, mailFolders } from '../../../db/schema'
import { checkUserMailboxAccess } from './mailboxes'
import { mailMessageToListItem } from '../../lib/mail'
import { runFiltersOnMessage } from './filters'
import { decryptSecret } from '../../lib/crypto'
import { deleteMessagesPermanently, moveMessagesToFolder } from '../../lib/move-messages'

const router = Router()

function isArchiveFolderIdentifier(value: string | null | undefined) {
    if (!value) return false
    const upper = value.toUpperCase()
    return upper === 'ARCHIVE' || upper === 'ARCHIVES' || upper === 'ALL MAIL' || upper.endsWith('ARCHIVE') || upper.endsWith('ARCHIVES') || upper.endsWith('ALL MAIL')
}

function isSpamFolderIdentifier(value: string | null | undefined) {
    if (!value) return false
    const upper = value.toUpperCase()
    return upper === 'SPAM' || upper === 'JUNK' || upper.endsWith('SPAM') || upper.endsWith('JUNK')
}

function isTrashFolderIdentifier(value: string | null | undefined) {
    if (!value) return false
    const upper = value.toUpperCase()
    return upper === 'TRASH' || upper === 'DELETED' || upper === 'DELETED ITEMS' || upper.endsWith('TRASH') || upper === 'BIN' || upper === 'DELETED MESSAGES'
}

function isInboxFolderIdentifier(value: string | null | undefined) {
    if (!value) return false
    const upper = value.toUpperCase()
    return upper === 'INBOX' || upper.endsWith('INBOX')
}

async function resolveFolder(
    mailboxId: string,
    type: string,
    matchesIdentifier: (folder: { remoteId: string; name: string }) => boolean,
    createDefaults?: { remoteId: string; name: string }
) {
    const folders = await db.query.mailFolders.findMany({
        where: eq(mailFolders.mailboxId, mailboxId),
    })

    const resolvedFolder =
        folders.find((folder) => folder.type === type) ||
        folders.find((folder) => matchesIdentifier({ remoteId: folder.remoteId, name: folder.name }))

    if (resolvedFolder) {
        if (resolvedFolder.type !== type) {
            const [updatedFolder] = await db.update(mailFolders)
                .set({ type, updatedAt: new Date() })
                .where(eq(mailFolders.id, resolvedFolder.id))
                .returning()

            return updatedFolder
        }

        return resolvedFolder
    }

    if (!createDefaults) {
        return null
    }

    const [createdFolder] = await db.insert(mailFolders).values({
        mailboxId,
        remoteId: createDefaults.remoteId,
        name: createDefaults.name,
        type,
    }).returning()

    return createdFolder
}

async function resolveArchiveFolder(mailboxId: string, allowCreate: boolean) {
    return resolveFolder(
        mailboxId,
        'archive',
        (folder) => isArchiveFolderIdentifier(folder.remoteId) || isArchiveFolderIdentifier(folder.name),
        allowCreate ? { remoteId: 'Archive', name: 'Archive' } : undefined
    )
}

async function resolveSpamFolder(mailboxId: string, allowCreate: boolean) {
    return resolveFolder(
        mailboxId,
        'spam',
        (folder) => isSpamFolderIdentifier(folder.remoteId) || isSpamFolderIdentifier(folder.name),
        allowCreate ? { remoteId: 'Spam', name: 'Spam' } : undefined
    )
}

async function resolveInboxFolder(mailboxId: string) {
    return resolveFolder(
        mailboxId,
        'inbox',
        (folder) => isInboxFolderIdentifier(folder.remoteId) || isInboxFolderIdentifier(folder.name)
    )
}

async function resolveTrashFolder(mailboxId: string, allowCreate: boolean) {
    return resolveFolder(
        mailboxId,
        'trash',
        (folder) => isTrashFolderIdentifier(folder.remoteId) || isTrashFolderIdentifier(folder.name),
        allowCreate ? { remoteId: 'Trash', name: 'Trash' } : undefined
    )
}

async function moveRemoteMessage(mailbox: Awaited<ReturnType<typeof checkUserMailboxAccess>>, sourceRemoteId: string, targetRemoteId: string, remoteUid: number) {
    if (!mailbox || mailbox.isNative || !mailbox.imapPasswordEncrypted) {
        return
    }

    if (sourceRemoteId === targetRemoteId) {
        return
    }

    await new Promise<void>((resolve, reject) => {
        const imap = new Imap({
            user: mailbox.imapUsername,
            password: decryptSecret(mailbox.imapPasswordEncrypted),
            host: mailbox.imapHost,
            port: mailbox.imapPort,
            tls: mailbox.imapSecure,
            tlsOptions: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
        } as Imap.Config)

        let settled = false

        const finish = (fn: () => void) => {
            if (settled) return
            settled = true
            fn()
        }

        imap.once('ready', () => {
            imap.openBox(sourceRemoteId, false, (openErr) => {
                if (openErr) {
                    finish(() => {
                        imap.end()
                        reject(openErr)
                    })
                    return
                }

                imap.move(String(remoteUid), targetRemoteId, (moveErr) => {
                    if (moveErr) {
                        finish(() => {
                            imap.end()
                            reject(moveErr)
                        })
                        return
                    }

                    finish(() => {
                        imap.end()
                        resolve()
                    })
                })
            })
        })

        imap.once('error', (error) => {
            finish(() => reject(error))
        })

        imap.connect()
    })
}

router.get('/:mailboxId/folders', async (req: Request, res: Response) => {
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

        const folders = await db.query.mailFolders.findMany({
            where: eq(mailFolders.mailboxId, mailboxId),
            orderBy: [desc(mailFolders.createdAt)],
        })

        res.json({ folders })
    } catch (error) {
        console.error('Error fetching folders:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:mailboxId/messages', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        let folderId = req.query.folderId as string | undefined
        const folderType = req.query.folderType as string | undefined
        const page = parseInt(req.query.page as string) || 1
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
        const offset = (page - 1) * limit

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        // Resolve folder by type if no folderId provided
        if (!folderId && folderType) {
            const folder = await db.query.mailFolders.findFirst({
                where: and(
                    eq(mailFolders.mailboxId, mailboxId),
                    eq(mailFolders.type, folderType)
                ),
            })
            if (!folder) {
                // Try by remoteId (case-insensitive)
                const allFolders = await db.query.mailFolders.findMany({
                    where: eq(mailFolders.mailboxId, mailboxId),
                })
                const matched = allFolders.find(f =>
                    f.remoteId?.toLowerCase() === folderType.toLowerCase() ||
                    f.name?.toLowerCase() === folderType.toLowerCase()
                )
                if (matched) {
                    // Backfill the type so future lookups are fast
                    await db.update(mailFolders).set({ type: folderType, updatedAt: new Date() }).where(eq(mailFolders.id, matched.id))
                    folderId = matched.id
                }
            } else {
                folderId = folder.id
            }
        }

        const conditions = [
            eq(mailMessages.mailboxId, mailboxId),
            eq(mailMessages.isDeleted, false),
        ]

        if (folderId) {
            conditions.push(eq(mailMessages.folderId, folderId))
        }

        const [messages, countResult] = await Promise.all([
            db.query.mailMessages.findMany({
                where: and(...conditions),
                columns: {
                    htmlBody: false,
                    plainBody: false,
                    headers: false,
                    attachments: false,
                },
                orderBy: [desc(mailMessages.receivedAt)],
                limit,
                offset,
            }),
            db
                .select({ count: sql<number>`count(*)::int` })
                .from(mailMessages)
                .where(and(...conditions)),
        ])

        const total = countResult[0]?.count ?? 0
        const items = messages.map(mailMessageToListItem)

        res.json({
            messages: items,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        })
    } catch (error) {
        console.error('Error fetching messages:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:mailboxId/messages/:messageId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const message = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.id, messageId),
                eq(mailMessages.mailboxId, mailboxId)
            ),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        if (!message.isRead) {
            await db.update(mailMessages)
                .set({ isRead: true, updatedAt: new Date() })
                .where(eq(mailMessages.id, messageId))
        }

        res.json({
            message: {
                id: message.id,
                messageId: message.messageId,
                inReplyTo: message.inReplyTo,
                references: message.references,
                subject: message.subject,
                from: { name: message.fromName, email: message.fromAddress },
                to: ((message.toAddresses as any[]) || []).map((a: any) => ({ name: a.name || null, email: a.address || a.email || null })),
                cc: ((message.ccAddresses as any[]) || []).map((a: any) => ({ name: a.name || null, email: a.address || a.email || null })),
                bcc: ((message.bccAddresses as any[]) || []).map((a: any) => ({ name: a.name || null, email: a.address || a.email || null })),
                plainBody: message.plainBody,
                htmlBody: message.htmlBody,
                headers: message.headers,
                attachments: message.attachments,
                hasAttachments: message.hasAttachments,
                isRead: true,
                isStarred: message.isStarred,
                receivedAt: message.receivedAt,
            },
        })
    } catch (error) {
        console.error('Error fetching message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.put('/:mailboxId/messages/:messageId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const schema = z.object({
            isRead: z.boolean().optional(),
            isStarred: z.boolean().optional(),
        })

        const data = schema.parse(req.body)

        const existing = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.id, messageId),
                eq(mailMessages.mailboxId, mailboxId)
            ),
        })

        if (!existing) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const updateData: Record<string, unknown> = { updatedAt: new Date() }
        if (data.isRead !== undefined) updateData.isRead = data.isRead
        if (data.isStarred !== undefined) updateData.isStarred = data.isStarred

        const [updated] = await db.update(mailMessages)
            .set(updateData)
            .where(eq(mailMessages.id, messageId))
            .returning()

        res.json({
            message: mailMessageToListItem(updated),
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:mailboxId/messages/:messageId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const message = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.id, messageId),
                eq(mailMessages.mailboxId, mailboxId)
            ),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const currentFolder = await db.query.mailFolders.findFirst({
            where: eq(mailFolders.id, message.folderId),
        })

        if (currentFolder?.type === 'trash') {
            await deleteMessagesPermanently([messageId], mailboxId)

            return res.json({ success: true, permanentlyDeleted: true })
        }

        const trashFolder = await resolveTrashFolder(mailboxId, mailbox.isNative)
        if (!trashFolder) {
            return res.status(400).json({ error: 'Trash folder is not available for this mailbox' })
        }

        // Update DB first so the UI stays consistent, then move on remote in background
        await moveMessagesToFolder([messageId], trashFolder.id)

        res.json({ success: true })

        // Move on remote IMAP server in the background (don't block the response)
        if (!mailbox.isNative && message.remoteUid && currentFolder?.remoteId && trashFolder.remoteId) {
            moveRemoteMessage(mailbox, currentFolder.remoteId, trashFolder.remoteId, message.remoteUid)
                .catch((err) => console.error('Background IMAP move to trash failed:', err))
        }
    } catch (error) {
        console.error('Error deleting message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/messages/:messageId/restore', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const message = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.id, messageId),
                eq(mailMessages.mailboxId, mailboxId)
            ),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const currentFolder = await db.query.mailFolders.findFirst({
            where: eq(mailFolders.id, message.folderId),
        })

        const inboxFolder = await resolveInboxFolder(mailboxId)
        if (!inboxFolder) {
            return res.status(400).json({ error: 'Inbox folder is not available for this mailbox' })
        }

        await moveMessagesToFolder([messageId], inboxFolder.id)

        res.json({ success: true })

        if (!mailbox.isNative && message.remoteUid && currentFolder?.remoteId && inboxFolder.remoteId) {
            moveRemoteMessage(mailbox, currentFolder.remoteId, inboxFolder.remoteId, message.remoteUid)
                .catch((err) => console.error('Background IMAP restore failed:', err))
        }
    } catch (error) {
        console.error('Error restoring message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/messages/:messageId/archive', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const message = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.id, messageId),
                eq(mailMessages.mailboxId, mailboxId)
            ),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const currentFolder = await db.query.mailFolders.findFirst({
            where: eq(mailFolders.id, message.folderId),
        })

        if (!currentFolder) {
            return res.status(400).json({ error: 'Current folder not found' })
        }

        const archiveFolder = await resolveArchiveFolder(mailboxId, mailbox.isNative)

        if (!archiveFolder) {
            return res.status(400).json({ error: 'Archive folder is not available for this mailbox' })
        }

        await moveMessagesToFolder([messageId], archiveFolder.id)

        res.json({ success: true })

        if (!mailbox.isNative && message.remoteUid && currentFolder.remoteId && archiveFolder.remoteId) {
            moveRemoteMessage(mailbox, currentFolder.remoteId, archiveFolder.remoteId, message.remoteUid)
                .catch((err) => console.error('Background IMAP archive failed:', err))
        }
    } catch (error) {
        console.error('Error archiving message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/messages/:messageId/spam', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId
        const isSpam = req.body.isSpam ?? true

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const message = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.id, messageId),
                eq(mailMessages.mailboxId, mailboxId)
            ),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const currentFolder = await db.query.mailFolders.findFirst({
            where: eq(mailFolders.id, message.folderId),
        })

        if (!currentFolder) {
            return res.status(400).json({ error: 'Current folder not found' })
        }

        const targetFolder = isSpam
            ? await resolveSpamFolder(mailboxId, mailbox.isNative)
            : await resolveInboxFolder(mailboxId)

        if (!targetFolder) {
            return res.status(400).json({ error: `Target ${isSpam ? 'spam' : 'inbox'} folder is not available for this mailbox` })
        }

        await moveMessagesToFolder([messageId], targetFolder.id)

        res.json({ success: true })

        if (!mailbox.isNative && message.remoteUid && currentFolder.remoteId && targetFolder.remoteId) {
            moveRemoteMessage(mailbox, currentFolder.remoteId, targetFolder.remoteId, message.remoteUid)
                .catch((err) => console.error('Background IMAP spam move failed:', err))
        }
    } catch (error) {
        console.error('Error marking message as spam:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/messages/:messageId/move', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const messageId = req.params.messageId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const schema = z.object({
            folderId: z.string().uuid(),
        })

        const data = schema.parse(req.body)

        // COR-05 — see audit H10. Verify the target folder belongs to the SAME mailbox before
        // moving. Without this, a user can move their message into another user's folder,
        // silently corrupting the folder tree (orphaned in foreign mailbox, invisible to owner).
        const targetFolder = await db.query.mailFolders.findFirst({
            where: and(eq(mailFolders.id, data.folderId), eq(mailFolders.mailboxId, mailboxId)),
        })
        if (!targetFolder) {
            return res.status(400).json({ error: 'Folder does not belong to this mailbox' })
        }

        // Scoped to the mailbox so a foreign message id cannot be moved through here.
        const owned = await db.query.mailMessages.findFirst({
            where: and(eq(mailMessages.id, messageId), eq(mailMessages.mailboxId, mailboxId)),
            columns: { id: true },
        })
        if (!owned) {
            return res.status(404).json({ error: 'Message not found' })
        }

        await moveMessagesToFolder([messageId], targetFolder.id)

        res.json({ success: true })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error moving message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/messages/batch', async (req: Request, res: Response) => {
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

        const schema = z.object({
            messageIds: z.array(z.string().uuid()).min(1),
            action: z.enum(['archive', 'spam', 'unspam', 'delete', 'restore', 'read', 'unread', 'star', 'unstar']),
            folderId: z.string().uuid().optional(),
        })

        const data = schema.parse(req.body)

        const updateData: Record<string, unknown> = { updatedAt: new Date() }
        let remoteTargetFolder: { id: string; remoteId: string } | null = null
        // Folder changes never ride along in `updateData`: they go through
        // moveMessagesToFolder so each message gets a UID from the destination.
        let destinationFolderId: string | null = null

        switch (data.action) {
            case 'archive': {
                const archiveFolder = await resolveArchiveFolder(mailboxId, mailbox.isNative)
                if (!archiveFolder) {
                    return res.status(400).json({ error: 'Archive folder is not available for this mailbox' })
                }

                destinationFolderId = archiveFolder.id
                remoteTargetFolder = archiveFolder
                break
            }
            case 'spam': {
                const spamFolder = await resolveSpamFolder(mailboxId, mailbox.isNative)
                if (spamFolder) {
                    destinationFolderId = spamFolder.id
                    remoteTargetFolder = spamFolder
                }
                break
            }
            case 'unspam': {
                const unspamInboxFolder = await resolveInboxFolder(mailboxId)
                if (unspamInboxFolder) {
                    destinationFolderId = unspamInboxFolder.id
                    remoteTargetFolder = unspamInboxFolder
                }
                break
            }
            case 'restore': {
                const inboxFolder = await resolveInboxFolder(mailboxId)
                if (inboxFolder) {
                    destinationFolderId = inboxFolder.id
                    remoteTargetFolder = inboxFolder
                }
                break
            }
            case 'delete': {
                const batchMessages = await db.query.mailMessages.findMany({
                    where: and(
                        inArray(mailMessages.id, data.messageIds),
                        eq(mailMessages.mailboxId, mailboxId)
                    ),
                })

                const batchFolderIds = [...new Set(batchMessages.map((m) => m.folderId))]
                const batchFolders = await db.query.mailFolders.findMany({
                    where: and(
                        eq(mailFolders.mailboxId, mailboxId),
                        inArray(mailFolders.id, batchFolderIds)
                    ),
                })
                const batchFoldersById = new Map(batchFolders.map((f) => [f.id, f]))

                const trashMsgs = batchMessages.filter((m) => batchFoldersById.get(m.folderId)?.type === 'trash')
                const nonTrashMsgs = batchMessages.filter((m) => batchFoldersById.get(m.folderId)?.type !== 'trash')

                if (trashMsgs.length > 0) {
                    await deleteMessagesPermanently(trashMsgs.map((m) => m.id), mailboxId)
                }

                if (nonTrashMsgs.length > 0) {
                    const trashFolder = await resolveTrashFolder(mailboxId, mailbox.isNative)
                    if (trashFolder) {
                        // Update DB first, then move on remote in background
                        await moveMessagesToFolder(nonTrashMsgs.map((m) => m.id), trashFolder.id)

                        if (!mailbox.isNative && trashFolder.remoteId) {
                            (async () => {
                                for (const msg of nonTrashMsgs) {
                                    const srcFolder = batchFoldersById.get(msg.folderId)
                                    if (msg.remoteUid && srcFolder?.remoteId) {
                                        await moveRemoteMessage(mailbox, srcFolder.remoteId, trashFolder.remoteId, msg.remoteUid).catch(() => {})
                                    }
                                }
                            })().catch((err) => console.error('Background IMAP batch delete failed:', err))
                        }
                    }
                }
                break
            }
            case 'read':
                updateData.isRead = true
                break
            case 'unread':
                updateData.isRead = false
                break
            case 'star':
                updateData.isStarred = true
                break
            case 'unstar':
                updateData.isStarred = false
                break
        }

        if (data.folderId && ['archive', 'spam', 'unspam', 'restore'].includes(data.action)) {
            const overrideFolder = await db.query.mailFolders.findFirst({
                where: and(
                    eq(mailFolders.mailboxId, mailboxId),
                    eq(mailFolders.id, data.folderId)
                ),
            })
            // Silently trusting data.folderId would let a caller park messages in
            // another mailbox's folder; only an override we could verify is used.
            if (!overrideFolder) {
                return res.status(400).json({ error: 'Folder does not belong to this mailbox' })
            }
            destinationFolderId = overrideFolder.id
            remoteTargetFolder = overrideFolder
        }

        // Capture source folder mapping BEFORE DB update (needed for background IMAP move)
        let sourceFolderMap: Map<string, { remoteUid: number; sourceRemoteId: string }> | null = null
        if (!mailbox.isNative && remoteTargetFolder?.remoteId && ['archive', 'spam', 'unspam', 'restore'].includes(data.action)) {
            const msgs = await db.query.mailMessages.findMany({
                where: and(
                    inArray(mailMessages.id, data.messageIds),
                    eq(mailMessages.mailboxId, mailboxId)
                ),
            })

            const folderIds = [...new Set(msgs.map((m) => m.folderId))]
            const folders = await db.query.mailFolders.findMany({
                where: and(
                    eq(mailFolders.mailboxId, mailboxId),
                    inArray(mailFolders.id, folderIds)
                ),
            })
            const foldersById = new Map(folders.map((f) => [f.id, f]))

            sourceFolderMap = new Map()
            for (const msg of msgs) {
                const srcFolder = foldersById.get(msg.folderId)
                if (msg.remoteUid && srcFolder?.remoteId) {
                    sourceFolderMap.set(msg.id, { remoteUid: msg.remoteUid, sourceRemoteId: srcFolder.remoteId })
                }
            }
        }

        // Update DB first so the UI stays consistent
        if (Object.keys(updateData).length > 1) {
            await db.update(mailMessages)
                .set(updateData)
                .where(and(inArray(mailMessages.id, data.messageIds), eq(mailMessages.mailboxId, mailboxId)))
        }

        if (destinationFolderId) {
            const owned = await db.query.mailMessages.findMany({
                where: and(inArray(mailMessages.id, data.messageIds), eq(mailMessages.mailboxId, mailboxId)),
                columns: { id: true },
            })
            await moveMessagesToFolder(owned.map((m) => m.id), destinationFolderId)
        }

        for (const messageId of data.messageIds) {
            await runFiltersOnMessage(messageId)
        }

        res.json({ success: true })

        // Move on remote IMAP server in the background (don't block the response)
        if (sourceFolderMap && sourceFolderMap.size > 0 && remoteTargetFolder?.remoteId) {
            (async () => {
                try {
                    for (const [, { remoteUid, sourceRemoteId }] of sourceFolderMap!) {
                        await moveRemoteMessage(mailbox, sourceRemoteId, remoteTargetFolder!.remoteId, remoteUid)
                    }
                } catch (err) {
                    console.error('Background IMAP batch move failed:', err)
                }
            })()
        }
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error batch updating messages:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:mailboxId/search', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const q = req.query.q as string | undefined
        const folderId = req.query.folderId as string | undefined
        const page = parseInt(req.query.page as string) || 1
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
        const offset = (page - 1) * limit

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!q || q.trim().length < 2) {
            return res.json({ messages: [], pagination: { page, limit, total: 0, totalPages: 0 } })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const conditions = [
            eq(mailMessages.mailboxId, mailboxId),
            eq(mailMessages.isDeleted, false),
            or(
                ilike(mailMessages.subject, `%${q}%`),
                ilike(mailMessages.fromName, `%${q}%`),
                ilike(mailMessages.fromAddress, `%${q}%`),
                ilike(mailMessages.plainBody, `%${q}%`),
            ),
        ]

        if (folderId) {
            conditions.push(eq(mailMessages.folderId, folderId))
        }

        const [messages, countResult] = await Promise.all([
            db.query.mailMessages.findMany({
                where: and(...conditions),
                columns: {
                    htmlBody: false,
                    plainBody: false,
                    headers: false,
                    attachments: false,
                },
                orderBy: [desc(mailMessages.receivedAt)],
                limit,
                offset,
            }),
            db
                .select({ count: sql<number>`count(*)::int` })
                .from(mailMessages)
                .where(and(...conditions)),
        ])

        const total = countResult[0]?.count ?? 0
        const items = messages.map(mailMessageToListItem)

        res.json({
            messages: items,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        })
    } catch (error) {
        console.error('Error searching messages:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
