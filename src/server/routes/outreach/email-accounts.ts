import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { emailAccounts, organizationUsers, users } from '../../../db/schema'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { encryptSecret, decryptSecret } from '../../lib/crypto'
import { paginate, paginationQuerySchema } from '../../lib/pagination'
import { getEffectiveDailySendLimit } from '../../lib/outreach-sender'
import { listInboxProviders } from '../../lib/inbox-providers'
import { getNativeMailboxByEmail } from '../../lib/native-send'
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'

const router = Router()

// Validation schemas
//
// provider='native' accounts send through the platform's native mailbox model
// (src/server/lib/native-send.ts) instead of stored SMTP/IMAP credentials — no
// password is ever collected or persisted for these accounts. SMTP fields are
// only required when provider is (or defaults to) 'smtp'; see superRefine below.
// 'outlook' accounts are created via src/server/routes/outlook.ts (OAuth flow),
// not through this route, so it is intentionally excluded from this enum.
const createEmailAccountSchema = z.object({
    email: z.string().email('Invalid email address'),
    displayName: z.string().optional(),
    provider: z.enum(['smtp', 'native']).default('smtp'),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpUsername: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
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
}).superRefine((data, ctx) => {
    if (data.provider === 'smtp') {
        if (!data.smtpHost) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['smtpHost'], message: 'SMTP host is required' })
        }
        if (!data.smtpUsername) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['smtpUsername'], message: 'SMTP username is required' })
        }
        if (!data.smtpPassword) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['smtpPassword'], message: 'SMTP password is required' })
        }
    }
})

// P006 — bulk import of provider-exported SMTP/IMAP credentials (IceMail, Primeforge, or manual).
const importMailboxSchema = z.object({
    email: z.string().email('Invalid email address').transform((v) => v.trim().toLowerCase()),
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
    // Vendor-side mailbox reference (for later warmup sync / re-provisioning).
    providerRef: z.string().optional(),
})

const bulkImportEmailAccountsSchema = z.object({
    provider: z.enum(['manual', 'icemail', 'primeforge']).default('manual'),
    mailboxes: z.array(importMailboxSchema).min(1).max(200),
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

function canWriteOutreach(membership: Awaited<ReturnType<typeof checkOrgMembership>>): boolean {
    return membership?.role === 'admin' || membership?.role === 'member'
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
            dailyLimit: getEffectiveDailySendLimit(account),
            configuredDailyLimit: account.dailySendLimit,
            sentToday: account.currentDailySent,
            warmupDay: account.warmupCurrentDay,
            warmupProgress: account.warmupEnabled
                ? Math.min(100, Math.round((account.warmupCurrentDay / Math.max(1, account.warmupDays)) * 100))
                : 100,
            smtpPassword: undefined,
            imapPassword: undefined,
        }))

        res.json({ emailAccounts: safeAccounts, pagination: result.pagination })
    } catch (error) {
        console.error('Error fetching email accounts:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// List available inbox providers (P006). Registered before /:id so "providers" is not matched
// as an account id. Static registry — no tenant data — so only auth (x-user-id) is required.
router.get('/providers', async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    res.json({ providers: listInboxProviders() })
})

// Bulk-import mailbox credentials from an inbox provider (P006).
// Vendors like IceMail and Primeforge export standard SMTP/IMAP credentials in bulk; this endpoint
// ingests them into email_accounts (encrypted, status 'pending'), tagging each row with its
// mailbox_provider. Imported accounts are verified through the existing POST /:id/verify flow —
// inline bulk verification is deliberately NOT done here (N sequential SMTP/IMAP connects would be
// slow and widen the SSRF surface flagged in the audit).
router.post('/bulk-import', async (req: Request, res: Response) => {
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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const { provider, mailboxes } = bulkImportEmailAccountsSchema.parse(req.body)

        // De-dupe against existing inboxes in this org (unique on org+email).
        const submittedEmails = mailboxes.map((m) => m.email)
        const existing = await db.query.emailAccounts.findMany({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                inArray(emailAccounts.email, submittedEmails)
            ),
            columns: { email: true },
        })
        const existingEmails = new Set(existing.map((e) => e.email))

        // Also drop in-payload duplicates (keep first occurrence).
        const seen = new Set<string>()
        const toInsert = mailboxes.filter((m) => {
            if (existingEmails.has(m.email) || seen.has(m.email)) return false
            seen.add(m.email)
            return true
        })

        if (toInsert.length === 0) {
            return res.status(200).json({
                imported: 0,
                duplicates: mailboxes.length,
                provider,
                emailAccounts: [],
            })
        }

        const inserted = await db.insert(emailAccounts).values(
            toInsert.map((m) => ({
                organizationId,
                email: m.email,
                displayName: m.displayName,
                mailboxProvider: provider,
                providerRef: m.providerRef ?? null,
                smtpHost: m.smtpHost,
                smtpPort: m.smtpPort,
                smtpUsername: m.smtpUsername,
                smtpPassword: encryptSecret(m.smtpPassword),
                smtpSecure: m.smtpSecure,
                imapHost: m.imapHost,
                imapPort: m.imapPort,
                imapUsername: m.imapUsername,
                imapPassword: m.imapPassword ? encryptSecret(m.imapPassword) : null,
                imapSecure: m.imapSecure,
                dailySendLimit: m.dailySendLimit,
                minMinutesBetweenEmails: m.minMinutesBetweenEmails,
                maxMinutesBetweenEmails: m.maxMinutesBetweenEmails,
                warmupEnabled: m.warmupEnabled,
                warmupDays: m.warmupDays,
                status: 'pending' as const,
            }))
        ).returning()

        res.status(201).json({
            imported: inserted.length,
            duplicates: mailboxes.length - inserted.length,
            provider,
            emailAccounts: inserted.map((a) => ({
                ...a,
                smtpPassword: undefined,
                imapPassword: undefined,
            })),
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error bulk-importing email accounts:', error)
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
                dailyLimit: getEffectiveDailySendLimit(account),
                configuredDailyLimit: account.dailySendLimit,
                sentToday: account.currentDailySent,
                warmupDay: account.warmupCurrentDay,
                warmupProgress: account.warmupEnabled
                    ? Math.min(100, Math.round((account.warmupCurrentDay / Math.max(1, account.warmupDays)) * 100))
                    : 100,
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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = createEmailAccountSchema.parse(req.body)
        const normalizedEmail = validatedData.email.toLowerCase()

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

        let newAccount: typeof emailAccounts.$inferSelect

        if (validatedData.provider === 'native') {
            // No SMTP/IMAP credentials are collected or stored for native accounts —
            // sending goes through src/server/lib/native-send.ts's internal relay,
            // authenticated implicitly by the fact that the mailbox belongs to a
            // member of this organization. Validate all three preconditions BEFORE
            // inserting: (1) a platform user exists with this email, (2) that user
            // has a native mailbox, (3) that user is a member of this organization.
            const targetUser = await db.query.users.findFirst({
                where: eq(users.email, normalizedEmail),
            })
            if (!targetUser) {
                return res.status(400).json({ error: 'No platform user found with that email address' })
            }

            const nativeMailbox = await getNativeMailboxByEmail(normalizedEmail)
            if (!nativeMailbox) {
                return res.status(400).json({ error: 'That user does not have a native mailbox' })
            }

            const targetMembership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, targetUser.id)
                ),
            })
            if (!targetMembership) {
                return res.status(400).json({ error: 'That user is not a member of this organization' })
            }

            const [inserted] = await db.insert(emailAccounts).values({
                organizationId,
                email: validatedData.email,
                displayName: validatedData.displayName,
                provider: 'native',
                smtpHost: null,
                smtpPort: null,
                smtpUsername: null,
                smtpPassword: null,
                smtpSecure: null,
                imapHost: null,
                imapPort: null,
                imapUsername: null,
                imapPassword: null,
                imapSecure: null,
                dailySendLimit: validatedData.dailySendLimit,
                minMinutesBetweenEmails: validatedData.minMinutesBetweenEmails,
                maxMinutesBetweenEmails: validatedData.maxMinutesBetweenEmails,
                warmupEnabled: validatedData.warmupEnabled,
                warmupDays: validatedData.warmupDays,
                status: 'pending',
            }).returning()
            newAccount = inserted
        } else {
            // validatedData.smtpHost/smtpUsername/smtpPassword are guaranteed present by
            // superRefine when provider === 'smtp' (the default).
            const [inserted] = await db.insert(emailAccounts).values({
                organizationId,
                email: validatedData.email,
                displayName: validatedData.displayName,
                provider: 'smtp',
                smtpHost: validatedData.smtpHost as string,
                smtpPort: validatedData.smtpPort,
                smtpUsername: validatedData.smtpUsername as string,
                smtpPassword: encryptSecret(validatedData.smtpPassword as string),
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
            newAccount = inserted
        }

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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
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

        if (account.provider === 'native') {
            // No network test — re-validate that the backing platform user and native
            // mailbox still exist (they may have been deleted since account creation).
            const targetUser = await db.query.users.findFirst({
                where: eq(users.email, account.email.toLowerCase()),
            })
            const nativeMailbox = targetUser ? await getNativeMailboxByEmail(account.email) : null

            if (!targetUser || !nativeMailbox) {
                const [updatedAccount] = await db.update(emailAccounts)
                    .set({
                        status: 'failed',
                        lastError: 'Native mailbox no longer exists for this user',
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
                    errors: ['Native mailbox no longer exists for this user'],
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
