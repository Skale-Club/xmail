import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../../../db'
import { mailboxes, mailFolders, users } from '../../../db/schema'
import { encryptSecret } from '../../lib/crypto'
import { authenticateNativeUser, createUserMailbox, deleteMailboxById } from '../../lib/native-mail'
import { isPrivateHost } from '../../lib/network-guard'

const router = Router()

/**
 * Check whether `userId` can access `mailboxId`.
 *
 * Rules:
 *   - Owner can always access their own mailbox.
 *   - Platform admins (users.isAdmin = true) can access any mailbox in the
 *     system (impersonation: super-admin reads other users' inboxes from
 *     their own panel).
 *   - For non-admin owners of a native mailbox, the email on the mailbox
 *     must still match the user's email (sanity check; native mailboxes
 *     are 1:1 with the user record).
 */
export async function checkUserMailboxAccess(userId: string, mailboxId: string) {
    const [requester, mailbox] = await Promise.all([
        db.query.users.findFirst({
            where: eq(users.id, userId),
        }),
        db.query.mailboxes.findFirst({
            where: eq(mailboxes.id, mailboxId),
        }),
    ])

    if (!mailbox || !requester) {
        return null
    }

    // Admin bypass: super-admins can access any mailbox.
    if (requester.isAdmin) {
        return mailbox
    }

    // Non-admins must own the mailbox.
    if (mailbox.userId !== userId) {
        return null
    }

    // For native mailboxes, the email must match the owner's email.
    if (mailbox.isNative) {
        const owner = await db.query.users.findFirst({
            where: eq(users.id, mailbox.userId),
        })
        if (!owner || mailbox.email.toLowerCase() !== owner.email.toLowerCase()) {
            return null
        }
    }

    return mailbox
}

function toMailboxResponse(mailbox: {
    id: string
    email: string
    displayName: string | null
    isDefault: boolean
    isActive: boolean
    isNative: boolean
    lastSyncAt: Date | null
    syncError: string | null
}) {
    return {
        id: mailbox.id,
        email: mailbox.email,
        displayName: mailbox.displayName,
        isDefault: mailbox.isDefault,
        isActive: mailbox.isActive,
        isNative: mailbox.isNative,
        lastSyncAt: mailbox.lastSyncAt,
        syncError: mailbox.isNative ? null : mailbox.syncError,
    }
}

router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Safety net: ensure native mailbox exists for the requester (should
        // already exist from user creation). Applies to admins too — admins
        // can use webmail like any other user.
        const user = await db.query.users.findFirst({ where: eq(users.id, userId) })
        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }
        if (user.passwordHash) {
            await createUserMailbox(userId, user.email)
        }

        // Admins see every mailbox in the system (super-admin impersonation:
        // they can pick any user's inbox from their AccountSwitcher). Regular
        // users only see their own mailboxes.
        const userMailboxes = user.isAdmin
            ? await db.query.mailboxes.findMany({
                  orderBy: [desc(mailboxes.createdAt)],
              })
            : await db.query.mailboxes.findMany({
                  where: eq(mailboxes.userId, userId),
                  orderBy: [desc(mailboxes.createdAt)],
              })

        // Clear stale syncError from native mailboxes (they don't use IMAP)
        const nativeWithError = userMailboxes.filter(mb => mb.isNative && mb.syncError)
        if (nativeWithError.length > 0) {
            await Promise.all(nativeWithError.map(mb =>
                db.update(mailboxes).set({ syncError: null }).where(eq(mailboxes.id, mb.id))
            ))
        }

        const safeMailboxes = userMailboxes.map(toMailboxResponse)

        res.json({ mailboxes: safeMailboxes })
    } catch (error) {
        console.error('Error fetching mailboxes:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)

        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        res.json({ mailbox: toMailboxResponse(mailbox) })
    } catch (error) {
        console.error('Error fetching mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/connect', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })

        const schema = z.object({
            email: z.string().email(),
            password: z.string().min(1),
        })

        const { email, password } = schema.parse(req.body)

        const targetUser = await authenticateNativeUser(email, password)
        if (!targetUser) {
            return res.status(401).json({ error: 'Invalid email or password' })
        }

        const requestingUser = await db.query.users.findFirst({
            where: eq(users.id, userId),
        })
        if (!requestingUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Non-admins can only provision a native mailbox for themselves.
        // Admins may provision/refresh a native mailbox on behalf of any user
        // they have credentials for (super-admin impersonation flow).
        if (!requestingUser.isAdmin && targetUser.id !== userId) {
            return res.status(403).json({
                error: 'Local server mailboxes belong to their owner. Sign in as that user instead.',
            })
        }

        // Native mailboxes are owned by the *target* user, not the requester.
        // This keeps the "users.email = mailboxes.email for native rows"
        // invariant intact even when an admin provisions on behalf of someone.
        const ownerUserId = targetUser.id
        const ownerEmail = targetUser.email.toLowerCase()

        const existing = await db.query.mailboxes.findFirst({
            where: and(
                eq(mailboxes.userId, ownerUserId),
                eq(mailboxes.email, ownerEmail),
                eq(mailboxes.isNative, true)
            ),
        })
        if (existing) {
            return res.json({ mailbox: toMailboxResponse(existing) })
        }

        await createUserMailbox(ownerUserId, targetUser.email)
        const created = await db.query.mailboxes.findFirst({
            where: and(
                eq(mailboxes.userId, ownerUserId),
                eq(mailboxes.email, ownerEmail),
                eq(mailboxes.isNative, true)
            ),
        })
        if (!created) {
            return res.status(500).json({ error: 'Failed to provision local mailbox' })
        }

        res.status(201).json({
            mailbox: toMailboxResponse(created),
        })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors })
        console.error('Error connecting mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const schema = z.object({
            email: z.string().email(),
            displayName: z.string().optional(),
            smtpHost: z.string(),
            smtpPort: z.number().int().min(1).max(65535),
            smtpUsername: z.string(),
            smtpPassword: z.string(),
            smtpSecure: z.boolean().default(true),
            imapHost: z.string(),
            imapPort: z.number().int().min(1).max(65535),
            imapUsername: z.string(),
            imapPassword: z.string(),
            imapSecure: z.boolean().default(true),
            isDefault: z.boolean().default(false),
        })

        const data = schema.parse(req.body)

        if (data.isDefault) {
            await db.update(mailboxes)
                .set({ isDefault: false })
                .where(eq(mailboxes.userId, userId))
        }

        const newMailboxValues = {
            userId,
            email: data.email,
            displayName: data.displayName,
            smtpHost: data.smtpHost,
            smtpPort: data.smtpPort,
            smtpUsername: data.smtpUsername,
            smtpPasswordEncrypted: encryptSecret(data.smtpPassword),
            smtpSecure: data.smtpSecure,
            imapHost: data.imapHost,
            imapPort: data.imapPort,
            imapUsername: data.imapUsername,
            imapPasswordEncrypted: encryptSecret(data.imapPassword),
            imapSecure: data.imapSecure,
            isDefault: data.isDefault,
        }

        const insertedMailboxes = await db.insert(mailboxes).values(newMailboxValues).returning()
        const insertedMailbox = insertedMailboxes[0]
        const mailboxId = insertedMailbox.id
        const insertedEmail = insertedMailbox.email
        const insertedDisplayName = insertedMailbox.displayName
        const insertedIsDefault = insertedMailbox.isDefault
        const insertedIsActive = insertedMailbox.isActive

        await db.insert(mailFolders).values([
            { mailboxId: mailboxId, remoteId: 'INBOX', name: 'INBOX', type: 'inbox' },
            { mailboxId: mailboxId, remoteId: 'Sent', name: 'Sent', type: 'sent' },
            { mailboxId: mailboxId, remoteId: 'Drafts', name: 'Drafts', type: 'drafts' },
            { mailboxId: mailboxId, remoteId: 'Archive', name: 'Archive', type: 'archive' },
            { mailboxId: mailboxId, remoteId: 'Trash', name: 'Trash', type: 'trash' },
        ])

        res.status(201).json({
            mailbox: {
                id: mailboxId,
                email: insertedEmail,
                displayName: insertedDisplayName,
                isDefault: insertedIsDefault,
                isActive: insertedIsActive,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const schema = z.object({
            displayName: z.string().optional(),
            smtpPassword: z.string().optional(),
            imapPassword: z.string().optional(),
            isDefault: z.boolean().optional(),
            isActive: z.boolean().optional(),
        })

        const data = schema.parse(req.body)

        const existing = await checkUserMailboxAccess(userId, mailboxId)

        if (!existing) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        if (data.isDefault) {
            await db.update(mailboxes)
                .set({ isDefault: false })
                .where(eq(mailboxes.userId, userId))
        }

        const updateData: Record<string, unknown> = { updatedAt: new Date() }
        if (data.displayName !== undefined) updateData.displayName = data.displayName
        if (data.smtpPassword !== undefined) updateData.smtpPasswordEncrypted = encryptSecret(data.smtpPassword)
        if (data.imapPassword !== undefined) updateData.imapPasswordEncrypted = encryptSecret(data.imapPassword)
        if (data.isDefault !== undefined) updateData.isDefault = data.isDefault
        if (data.isActive !== undefined) updateData.isActive = data.isActive

        const [updated] = await db.update(mailboxes)
            .set(updateData)
            .where(eq(mailboxes.id, mailboxId))
            .returning()

        res.json({
            mailbox: {
                id: updated.id,
                email: updated.email,
                displayName: updated.displayName,
                isDefault: updated.isDefault,
                isActive: updated.isActive,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const existing = await checkUserMailboxAccess(userId, mailboxId)

        if (!existing) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        await deleteMailboxById(mailboxId)

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/test-connection', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id']
        if (!userId || typeof userId !== 'string') {
            return res.status(401).json({ error: 'Authentication required' })
        }

        const schema = z.object({
            smtpHost: z.string(),
            smtpPort: z.number().int().min(1).max(65535),
            smtpSecure: z.boolean(),
            smtpUsername: z.string(),
            smtpPassword: z.string(),
            imapHost: z.string(),
            imapPort: z.number().int().min(1).max(65535),
            imapSecure: z.boolean(),
            imapUsername: z.string(),
            imapPassword: z.string(),
        })

        const data = schema.parse(req.body)

        const smtpHost = data.smtpHost.trim()
        const imapHost = data.imapHost.trim()
        if (isPrivateHost(smtpHost) || isPrivateHost(imapHost)) {
            return res.status(400).json({ error: 'Connection to private/loopback/link-local hosts is not allowed' })
        }

        const nodemailer = await import('nodemailer')
        
        let smtpSuccess = false
        let imapSuccess = false
        const errors: string[] = []

        try {
            const smtpTransporter = nodemailer.createTransport({
                host: smtpHost,
                port: data.smtpPort,
                secure: data.smtpSecure,
                auth: {
                    user: data.smtpUsername,
                    pass: data.smtpPassword,
                },
            })
            await smtpTransporter.verify()
            smtpSuccess = true
        } catch (err) {
            errors.push(`SMTP: ${err instanceof Error ? err.message : String(err)}`)
        }

        try {
            const Imap = (await import('imap')).default
            const imap = new Imap({
                user: data.imapUsername,
                password: data.imapPassword,
                host: imapHost,
                port: data.imapPort,
                tls: data.imapSecure,
                tlsOptions: { rejectUnauthorized: false },
            })

            await new Promise<void>((resolve, reject) => {
                imap.once('ready', () => {
                    imap.end()
                    resolve()
                })
                imap.once('error', (err) => {
                    reject(err)
                })
                imap.connect()
            })
            imapSuccess = true
        } catch (err) {
            errors.push(`IMAP: ${err instanceof Error ? err.message : String(err)}`)
        }

        res.json({
            data: {
                smtp: smtpSuccess,
                imap: imapSuccess,
                errors: errors.length > 0 ? errors : undefined,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error testing connection:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
