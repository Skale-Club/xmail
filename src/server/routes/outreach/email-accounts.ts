import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { emailAccounts, organizationUsers } from '../../../db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { encryptSecret, decryptSecret } from '../../lib/crypto'
import { paginate, paginationQuerySchema } from '../../lib/pagination'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'

const router = Router()

// Validation schemas
const createEmailAccountSchema = z.object({
    email: z.string().email('Invalid email address'),
    displayName: z.string().optional(),
    smtpHost: z.string().min(1, 'SMTP host is required'),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpUsername: z.string().min(1, 'SMTP username is required'),
    smtpPassword: z.string().min(1, 'SMTP password is required'),
    smtpSecure: z.boolean().default(true),
    imapHost: z.string().optional(),
    imapPort: z.number().int().min(1).max(65535).default(993),
    imapUsername: z.string().optional(),
    imapPassword: z.string().optional(),
    imapSecure: z.boolean().default(true),
    dailySendLimit: z.number().int().min(1).max(10000).default(50),
    minMinutesBetweenEmails: z.number().int().min(1).default(5),
    maxMinutesBetweenEmails: z.number().int().min(1).default(30),
    warmupEnabled: z.boolean().default(true),
    warmupDays: z.number().int().min(1).max(60).default(14),
})

const updateEmailAccountSchema = z.object({
    displayName: z.string().optional(),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpUsername: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
    smtpSecure: z.boolean().optional(),
    imapHost: z.string().optional(),
    imapPort: z.number().int().min(1).max(65535).optional(),
    imapUsername: z.string().optional(),
    imapPassword: z.string().optional(),
    imapSecure: z.boolean().optional(),
    dailySendLimit: z.number().int().min(1).max(10000).optional(),
    minMinutesBetweenEmails: z.number().int().min(1).optional(),
    maxMinutesBetweenEmails: z.number().int().min(1).optional(),
    warmupEnabled: z.boolean().optional(),
    warmupDays: z.number().int().min(1).max(60).optional(),
    status: z.enum(['pending', 'verified', 'failed', 'paused']).optional(),
})

// Helper to check org membership (platform admins bypass membership check)
async function checkOrgMembership(userId: string, organizationId: string) {
    const admin = await isPlatformAdmin(userId)
    if (admin) return { role: 'admin' as const }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId)
        ),
    })
    return membership
}

// NOTE: getDecryptedCredentials helper previously defined here was removed (Phase 12 COR-07 lint
// cleanup); routes inline `decryptSecret` calls. Re-add helper if needed by future routes.

// List email accounts for organization
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const { page, limit } = paginationQuerySchema.parse(req.query)

        const result = await paginate(db, emailAccounts, {
            where: eq(emailAccounts.organizationId, organizationId),
            page,
            limit,
            orderBy: desc(emailAccounts.createdAt),
        })

        // Remove sensitive data
        const safeAccounts = result.data.map((account) => ({
            ...account,
            smtpPassword: undefined,
            imapPassword: undefined,
        }))

        res.json({ emailAccounts: safeAccounts, pagination: result.pagination })
    } catch (error) {
        console.error('Error fetching email accounts:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get email account by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({
            emailAccount: {
                ...account,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
        })
    } catch (error) {
        console.error('Error fetching email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create email account
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const validatedData = createEmailAccountSchema.parse(req.body)

        // Check for duplicate email
        const existing = await db.query.emailAccounts.findFirst({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                eq(emailAccounts.email, validatedData.email)
            ),
        })

        if (existing) {
            return res.status(400).json({ error: 'Email account already exists' })
        }

        const [newAccount] = await db.insert(emailAccounts).values({
            organizationId,
            email: validatedData.email,
            displayName: validatedData.displayName,
            smtpHost: validatedData.smtpHost,
            smtpPort: validatedData.smtpPort,
            smtpUsername: validatedData.smtpUsername,
            smtpPassword: encryptSecret(validatedData.smtpPassword),
            smtpSecure: validatedData.smtpSecure,
            imapHost: validatedData.imapHost,
            imapPort: validatedData.imapPort,
            imapUsername: validatedData.imapUsername,
            imapPassword: validatedData.imapPassword ? encryptSecret(validatedData.imapPassword) : null,
            imapSecure: validatedData.imapSecure,
            dailySendLimit: validatedData.dailySendLimit,
            minMinutesBetweenEmails: validatedData.minMinutesBetweenEmails,
            maxMinutesBetweenEmails: validatedData.maxMinutesBetweenEmails,
            warmupEnabled: validatedData.warmupEnabled,
            warmupDays: validatedData.warmupDays,
            status: 'pending',
        }).returning()

        res.status(201).json({
            emailAccount: {
                ...newAccount,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update email account
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const validatedData = updateEmailAccountSchema.parse(req.body)

        const updateValues: Record<string, unknown> = {
            updatedAt: new Date(),
        }

        if (validatedData.displayName !== undefined) updateValues.displayName = validatedData.displayName
        if (validatedData.smtpHost !== undefined) updateValues.smtpHost = validatedData.smtpHost
        if (validatedData.smtpPort !== undefined) updateValues.smtpPort = validatedData.smtpPort
        if (validatedData.smtpUsername !== undefined) updateValues.smtpUsername = validatedData.smtpUsername
        if (validatedData.smtpPassword !== undefined) updateValues.smtpPassword = encryptSecret(validatedData.smtpPassword)
        if (validatedData.smtpSecure !== undefined) updateValues.smtpSecure = validatedData.smtpSecure
        if (validatedData.imapHost !== undefined) updateValues.imapHost = validatedData.imapHost
        if (validatedData.imapPort !== undefined) updateValues.imapPort = validatedData.imapPort
        if (validatedData.imapUsername !== undefined) updateValues.imapUsername = validatedData.imapUsername
        if (validatedData.imapPassword !== undefined) updateValues.imapPassword = validatedData.imapPassword ? encryptSecret(validatedData.imapPassword) : null
        if (validatedData.imapSecure !== undefined) updateValues.imapSecure = validatedData.imapSecure
        if (validatedData.dailySendLimit !== undefined) updateValues.dailySendLimit = validatedData.dailySendLimit
        if (validatedData.minMinutesBetweenEmails !== undefined) updateValues.minMinutesBetweenEmails = validatedData.minMinutesBetweenEmails
        if (validatedData.maxMinutesBetweenEmails !== undefined) updateValues.maxMinutesBetweenEmails = validatedData.maxMinutesBetweenEmails
        if (validatedData.warmupEnabled !== undefined) updateValues.warmupEnabled = validatedData.warmupEnabled
        if (validatedData.warmupDays !== undefined) updateValues.warmupDays = validatedData.warmupDays
        if (validatedData.status !== undefined) updateValues.status = validatedData.status

        const [updatedAccount] = await db.update(emailAccounts)
            .set(updateValues)
            .where(eq(emailAccounts.id, accountId))
            .returning()

        if (!updatedAccount) return res.status(500).json({ error: 'Update failed — record not found' })

        res.json({
            emailAccount: {
                ...updatedAccount,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete email account
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        await db.delete(emailAccounts).where(eq(emailAccounts.id, accountId))

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Verify email account (test connection)
router.post('/:id/verify', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const smtpPassword = account.smtpPassword ? decryptSecret(account.smtpPassword) : null
        const errors: string[] = []

        if (account.provider === 'outlook') {
            const [updatedAccount] = await db.update(emailAccounts)
                .set({
                    status: 'verified',
                    verifiedAt: new Date(),
                    lastError: null,
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, accountId))
                .returning()

            return res.json({
                emailAccount: {
                    ...updatedAccount,
                    smtpPassword: undefined,
                    imapPassword: undefined,
                },
                verified: true,
            })
        }

        if (!account.smtpHost || !smtpPassword) {
            return res.status(400).json({
                error: 'SMTP credentials not configured',
                verified: false,
            })
        }

        // Test SMTP connection
        try {
            const smtpTransporter = nodemailer.createTransport({
                host: account.smtpHost,
                port: account.smtpPort || 587,
                secure: account.smtpSecure ?? true,
                auth: {
                    user: account.smtpUsername || account.email,
                    pass: smtpPassword,
                },
                connectionTimeout: 10_000,
                greetingTimeout: 10_000,
            } as nodemailer.TransportOptions)

            await smtpTransporter.verify()
            smtpTransporter.close()
        } catch (smtpError) {
            const msg = smtpError instanceof Error ? smtpError.message : 'SMTP connection failed'
            errors.push(`SMTP: ${msg}`)
        }

        // Test IMAP connection (if configured)
        if (account.imapHost && account.imapUsername && account.imapPassword) {
            try {
                const imapPassword = decryptSecret(account.imapPassword)
                const imapClient = new ImapFlow({
                    host: account.imapHost,
                    port: account.imapPort || 993,
                    secure: account.imapSecure !== false,
                    auth: {
                        user: account.imapUsername,
                        pass: imapPassword,
                    },
                    logger: false,
                })

                await imapClient.connect()
                await imapClient.logout()
            } catch (imapError) {
                const msg = imapError instanceof Error ? imapError.message : 'IMAP connection failed'
                errors.push(`IMAP: ${msg}`)
            }
        }

        if (errors.length > 0) {
            const [updatedAccount] = await db.update(emailAccounts)
                .set({
                    status: 'failed',
                    lastError: errors.join('; '),
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, accountId))
                .returning()

            return res.status(400).json({
                emailAccount: {
                    ...updatedAccount,
                    smtpPassword: undefined,
                    imapPassword: undefined,
                },
                verified: false,
                errors,
            })
        }

        const [updatedAccount] = await db.update(emailAccounts)
            .set({
                status: 'verified',
                verifiedAt: new Date(),
                lastError: null,
                updatedAt: new Date(),
            })
            .where(eq(emailAccounts.id, accountId))
            .returning()

        res.json({
            emailAccount: {
                ...updatedAccount,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
            verified: true,
        })
    } catch (error) {
        console.error('Error verifying email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
