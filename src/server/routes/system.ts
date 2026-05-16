import { Router, Request, Response } from 'express'
import { statfs } from 'node:fs/promises'
import { db, checkDatabaseHealth, getPoolStats } from '../../db'
import { sql } from 'drizzle-orm'
import { systemBranding, users, organizations, domains, mailboxes, mailFolders, mailMessages } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { getCachedBranding, clearBrandingCache } from '../lib/serverBranding'
import { supabaseAdminClient } from '../lib/supabase'

const router = Router()

const brandingId = 'default'
const BUCKET_NAME = 'branding-assets'

const brandingSchema = z.object({
    companyName: z.string().trim().min(1).max(120).optional(),
    applicationName: z.string().trim().min(1).max(160).optional(),
    mailHost: z.string().trim().min(1).max(253).optional(),
})

function getRequestingUser(req: Request) {
    const requestingUserId = req.headers['x-user-id'] as string | undefined

    if (!requestingUserId) {
        return null
    }

    return db.query.users.findFirst({
        where: eq(users.id, requestingUserId),
    })
}

async function readBranding() {
    const b = await getCachedBranding()
    return {
        id: brandingId,
        companyName: b.companyName,
        applicationName: b.applicationName,
        logoStorage: b.logoStorage,
        faviconStorage: b.faviconStorage,
        mailHost: b.mailHost,
        createdAt: new Date(),
        updatedAt: new Date(),
    }
}

const DEFAULT_LOGO_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/branding-assets/brand-mark.svg`

function getPublicUrl(storage: string | null): string {
    if (!storage) {
        return DEFAULT_LOGO_URL
    }

    const [bucket, path] = storage.split('/')
    return `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
}

function getFaviconPublicUrl(faviconStorage: string | null, logoStorage: string | null): string {
    return getPublicUrl(faviconStorage || logoStorage)
}

async function readServerDiskUsage() {
    const storagePath =
        process.env.HETZNER_STORAGE_PATH ||
        process.env.SYSTEM_STORAGE_PATH ||
        process.env.MAIL_STORAGE_PATH ||
        process.cwd()

    const stats = await statfs(storagePath)
    const blockSize = Number(stats.bsize)
    const totalBytes = Number(stats.blocks) * blockSize
    const freeBytes = Number(stats.bavail) * blockSize
    const usedBytes = Math.max(0, totalBytes - freeBytes)

    return {
        path: storagePath,
        used: usedBytes,
        limit: totalBytes,
    }
}

router.get('/branding', async (_req: Request, res: Response) => {
    try {
        const branding = await readBranding()

        res.json({
            companyName: branding.companyName,
            applicationName: branding.applicationName,
            logoUrl: getPublicUrl(branding.logoStorage),
            faviconUrl: getFaviconPublicUrl(branding.faviconStorage, branding.logoStorage),
            mailHost: branding.mailHost,
        })
    } catch (error) {
        console.error('Error fetching branding settings:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

const ALLOWED_MIME_TYPES = [
    'image/svg+xml',
    'image/png',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/webp',
]

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

router.post('/branding/upload', async (req: Request, res: Response) => {
    try {
        const requestingUser = await getRequestingUser(req)

        if (!requestingUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!requestingUser.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        if (!req.is('multipart/form-data')) {
            return res.status(400).json({ error: 'Content-Type must be multipart/form-data' })
        }

        const chunks: Buffer[] = []
        let totalSize = 0
        let fileType = ''
        let fieldName = ''

        await new Promise<void>((resolve, reject) => {
            req.on('data', (chunk: Buffer) => {
                totalSize += chunk.length
                if (totalSize > MAX_FILE_SIZE) {
                    req.destroy()
                    return reject(new Error('File size exceeds 5MB limit'))
                }
                chunks.push(chunk)
            })

            req.on('end', () => {
                resolve()
            })

            req.on('error', (error: Error) => {
                reject(error)
            })
        })

        const buffer = Buffer.concat(chunks)
        const contentType = req.headers['content-type'] || ''

        const boundaryMatch = contentType.match(/boundary=(.+)/)
        if (!boundaryMatch) {
            return res.status(400).json({ error: 'Invalid multipart data' })
        }

        const boundary = boundaryMatch[1]
        const parts = buffer.toString('binary').split(`--${boundary}`)

        let fileBuffer: Buffer | null = null
        let filename = ''

        for (const part of parts) {
            if (part.includes('Content-Disposition')) {
                const headerEnd = part.indexOf('\r\n\r\n')
                if (headerEnd !== -1) {
                    const headers = part.substring(0, headerEnd)
                    const body = part.substring(headerEnd + 4)

                    const fieldMatch = headers.match(/name="(\w+)"/)
                    if (fieldMatch) {
                        fieldName = fieldMatch[1]
                    }

                    const filenameMatch = headers.match(/filename="([^"]+)"/)
                    if (filenameMatch) {
                        filename = filenameMatch[1]
                    }

                    if (fieldName === 'logo' || fieldName === 'favicon') {
                        const bodyEnd = body.lastIndexOf('\r\n')
                        const fileData = bodyEnd !== -1 ? body.substring(0, bodyEnd) : body.trim()
                        fileBuffer = Buffer.from(fileData, 'binary')

                        const mimeMatch = headers.match(/Content-Type:\s*(.+)/i)
                        if (mimeMatch) {
                            fileType = mimeMatch[1].trim()
                        }
                    }
                }
            }
        }

        if (!fileBuffer || !fieldName) {
            return res.status(400).json({ error: 'No file uploaded' })
        }

        if (!ALLOWED_MIME_TYPES.includes(fileType)) {
            return res.status(400).json({ 
                error: `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}` 
            })
        }

        const timestamp = Date.now()
        const storagePath = `${fieldName}-${timestamp}-${filename}`
        const storageKey = `${BUCKET_NAME}/${storagePath}`

        const { data: uploadData, error: uploadError } = await supabaseAdminClient
            .storage
            .from(BUCKET_NAME)
            .upload(storagePath, fileBuffer, {
                contentType: fileType,
                upsert: true,
            })

        if (uploadError) {
            console.error('Upload error:', uploadError)
            return res.status(500).json({ error: 'Failed to upload file' })
        }

        const field = fieldName === 'logo' ? 'logoStorage' : 'faviconStorage'

        const currentBranding = await readBranding()
        await db.insert(systemBranding)
            .values({
                id: brandingId,
                companyName: currentBranding.companyName,
                applicationName: currentBranding.applicationName,
            })
            .onConflictDoNothing()

        const [branding] = await db.update(systemBranding)
            .set({
                [field]: storageKey,
                updatedAt: new Date(),
            })
            .where(eq(systemBranding.id, brandingId))
            .returning()

        clearBrandingCache()

        res.json({
            companyName: branding.companyName,
            applicationName: branding.applicationName,
            logoUrl: getPublicUrl(branding.logoStorage),
            faviconUrl: getFaviconPublicUrl(branding.faviconStorage, branding.logoStorage),
        })
    } catch (error) {
        console.error('Error uploading branding file:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.patch('/branding', async (req: Request, res: Response) => {
    try {
        const requestingUser = await getRequestingUser(req)

        if (!requestingUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!requestingUser.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const updates = brandingSchema.parse(req.body)
        const currentBranding = await readBranding()

        const payload = {
            companyName: updates.companyName ?? currentBranding.companyName,
            applicationName: updates.applicationName ?? currentBranding.applicationName,
            mailHost: updates.mailHost ?? currentBranding.mailHost,
            updatedAt: new Date(),
        }

        await db.insert(systemBranding)
            .values({
                id: brandingId,
                companyName: currentBranding.companyName,
                applicationName: currentBranding.applicationName,
            })
            .onConflictDoNothing()

        const [branding] = await db.update(systemBranding)
            .set(payload)
            .where(eq(systemBranding.id, brandingId))
            .returning()

        clearBrandingCache()

        res.json({
            companyName: branding.companyName,
            applicationName: branding.applicationName,
            logoUrl: getPublicUrl(branding.logoStorage),
            faviconUrl: getFaviconPublicUrl(branding.faviconStorage, branding.logoStorage),
            mailHost: branding.mailHost,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }

        console.error('Error updating branding settings:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// GET /api/system/usage - Admin only
router.get('/usage', async (req: Request, res: Response) => {
    try {
        const requestingUser = await getRequestingUser(req)

        if (!requestingUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const diskUsage = await readServerDiskUsage()

        const userUsageResult = await db.execute(sql`
            SELECT
                u.id,
                u.email,
                u.first_name,
                u.last_name,
                COUNT(DISTINCT m.id)::int AS message_count,
                COALESCE(
                    SUM(
                        CASE
                            WHEN jsonb_array_length(m.attachments) > 0
                            THEN (
                                SELECT COALESCE(SUM((length(att->>'content') * 3 / 4)::bigint), 0)
                                FROM jsonb_array_elements(m.attachments) AS att
                                WHERE att->>'content' IS NOT NULL
                            )
                            ELSE 0
                        END
                    )
                , 1)::bigint AS attachment_bytes
            FROM users u
            LEFT JOIN organization_users ou ON ou.user_id = u.id
            LEFT JOIN organizations org ON org.id = ou.organization_id
            LEFT JOIN messages m ON m.organization_id = org.id
            WHERE u.is_admin = false
            GROUP BY u.id, u.email, u.first_name, u.last_name
            ORDER BY message_count DESC
        `)

        res.json({
            storage: {
                used: diskUsage.used,
                limit: diskUsage.limit,
                path: diskUsage.path,
            },
            users: (userUsageResult as any[]).map((row) => ({
                id: row.id,
                email: row.email,
                firstName: row.first_name,
                lastName: row.last_name,
                messageCount: Number(row.message_count),
                attachmentBytes: Number(row.attachment_bytes),
            })),
        })
    } catch (error) {
        console.error('Error fetching system usage:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// GET /api/system/mail-server-info — public SMTP/IMAP connection info
router.get('/mail-server-info', (_req: Request, res: Response) => {
    const mailHost = process.env.MAIL_HOST || 'localhost'
    const smtpPort = parseInt(process.env.SMTP_SUBMISSION_PORT || '2587')
    const imapPort = parseInt(process.env.IMAP_PORT || '2993')

    res.json({
        smtp: {
            host: mailHost,
            port: smtpPort,
            security: 'STARTTLS',
            auth: 'PLAIN/LOGIN',
            description: 'Use your account email and password to authenticate',
        },
        imap: {
            host: mailHost,
            port: imapPort,
            security: 'SSL/TLS',
            auth: 'PLAIN',
            description: 'Use your account email and password to authenticate',
        },
    })
})

// GET /api/system/outreach - Get outreach enabled status (platform-wide)
router.get('/outreach', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { isPlatformAdmin } = await import('../lib/admin')
        if (!await isPlatformAdmin(userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const allOrgs = await db.select({ outreach_enabled: organizations.outreach_enabled }).from(organizations)
        const enabledOrgs = allOrgs.filter(o => o.outreach_enabled).length
        const totalOrgs = allOrgs.length

        res.json({
            outreach_enabled: enabledOrgs === totalOrgs,
            enabled_count: enabledOrgs,
            total_count: totalOrgs,
        })
    } catch (error) {
        console.error('Error fetching outreach status:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// PUT /api/system/outreach/global-toggle - Toggle outreach enabled for all organizations (COR-04, audit H9/M7)
// Replaces the older PUT /api/system/outreach (now 410 Gone — see below).
// COR-04 — see audit H9/M7 and .planning/phases/12-high-correctness/12-CONTEXT.md
const outreachGlobalToggleSchema = z.object({
    enabled: z.boolean(),
})

router.put('/outreach/global-toggle', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { isPlatformAdmin } = await import('../lib/admin')
        if (!await isPlatformAdmin(userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        // Validate body
        const parseResult = outreachGlobalToggleSchema.safeParse(req.body)
        if (!parseResult.success) {
            return res.status(400).json({ error: parseResult.error.errors })
        }
        const { enabled } = parseResult.data

        // Capture previousState BEFORE the UPDATE so the response surfaces blast radius.
        const allOrgs = await db.select({ outreach_enabled: organizations.outreach_enabled }).from(organizations)
        const previousState = {
            enabledCount: allOrgs.filter(o => o.outreach_enabled).length,
            totalCount: allOrgs.length,
        }

        // Apply the toggle and capture affected row count via .returning()
        const updated = await db
            .update(organizations)
            .set({ outreach_enabled: enabled })
            .returning({ id: organizations.id })
        const affectedRows = updated.length

        const timestamp = new Date().toISOString()

        // Audit log — written to stdout with [audit] prefix.
        // Phase 13 QUA-06 will route this through a proper logger; for v1.2 stdout is sufficient.
        console.log(`[audit] outreach-toggle user=${userId} from=${previousState.enabledCount}/${previousState.totalCount} to=${enabled} affected=${affectedRows} at=${timestamp}`)

        res.json({
            affectedRows,
            previousState,
            userId,
            timestamp,
        })
    } catch (error) {
        console.error('Error toggling outreach (global-toggle):', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// PUT /api/system/outreach - Toggle outreach enabled for all organizations
router.put('/outreach', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { isPlatformAdmin } = await import('../lib/admin')
        if (!await isPlatformAdmin(userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const { enabled } = req.body
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' })
        }

        await db.update(organizations).set({ outreach_enabled: enabled })

        res.json({ success: true, outreach_enabled: enabled })
    } catch (error) {
        console.error('Error updating outreach status:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// GET /api/system/db-stats - Get database connection stats and health
router.get('/db-stats', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { isPlatformAdmin } = await import('../lib/admin')
        if (!await isPlatformAdmin(userId)) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        // Run health check and pool stats in parallel
        const [health, poolStats] = await Promise.all([
            checkDatabaseHealth(),
            getPoolStats(),
        ])

        res.json({
            health,
            ...poolStats,
            timestamp: new Date().toISOString(),
        })
    } catch (error) {
        console.error('Error fetching database stats:', error)
        res.status(500).json({ 
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})

// GET /api/system/db-health - Quick health check endpoint (lighter, for monitoring)
router.get('/db-health', async (req: Request, res: Response) => {
    try {
        const health = await checkDatabaseHealth()
        
        if (health.ok) {
            res.json({ 
                status: 'healthy',
                latencyMs: health.latencyMs,
                timestamp: health.timestamp
            })
        } else {
            res.status(503).json({ 
                status: 'unhealthy',
                latencyMs: health.latencyMs,
                error: health.error,
                timestamp: health.timestamp
            })
        }
    } catch (error) {
        res.status(503).json({ 
            status: 'unhealthy',
            error: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})

// GET /api/system/mail-diag — Diagnostic: check domains, users, mailboxes, env for native mail
router.get('/mail-diag', async (req: Request, res: Response) => {
    try {
        const requestingUser = await getRequestingUser(req)
        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden — admin only' })
        }

        // 1. All domains
        const allDomains = await db.query.domains.findMany()

        // 2. All non-admin users
        const allUsers = await db.query.users.findMany()
        const nonAdminUsers = allUsers.filter(u => !u.isAdmin)

        // 3. All native mailboxes
        const nativeMailboxes = await db.query.mailboxes.findMany({
            where: eq(mailboxes.isNative, true),
        })

        // 4. For each native mailbox, check folders exist
        const mailboxDetails = await Promise.all(
            nativeMailboxes.map(async (mb) => {
                const folders = await db.query.mailFolders.findMany({
                    where: eq(mailFolders.mailboxId, mb.id),
                })
                const messageCount = await db.select({ count: sql<number>`count(*)::int` })
                    .from(mailMessages)
                    .where(eq(mailMessages.mailboxId, mb.id))
                return {
                    id: mb.id,
                    email: mb.email,
                    userId: mb.userId,
                    isNative: mb.isNative,
                    folders: folders.map(f => ({ name: f.name, type: f.type, remoteId: f.remoteId })),
                    messageCount: messageCount[0]?.count ?? 0,
                }
            })
        )

        // 5. Env check
        const envCheck = {
            SMTP_HOST: process.env.SMTP_HOST || '❌ NOT SET',
            SMTP_USER: process.env.SMTP_USER ? '✅ SET' : '❌ NOT SET',
            SMTP_PASS: process.env.SMTP_PASS ? '✅ SET' : '❌ NOT SET',
            SMTP_PORT: process.env.SMTP_PORT || '(default 587)',
            MAIL_HOST: process.env.MAIL_HOST || '❌ NOT SET',
            MAIL_DOMAIN: process.env.MAIL_DOMAIN || '❌ NOT SET',
            SMTP_SUBMISSION_PORT: process.env.SMTP_SUBMISSION_PORT || '2587',
            IMAP_PORT: process.env.IMAP_PORT || '2993',
            ENABLE_MAIL_SERVER: process.env.ENABLE_MAIL_SERVER || 'not set',
            RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT || 'not set',
        }

        // 6. Test: would vanildo@skale.club be found as local?
        const testEmail = 'vanildo@skale.club'
        const testDomain = 'skale.club'
        const verifiedTestDomain = await db.query.domains.findFirst({
            where: and(eq(domains.name, testDomain), eq(domains.verificationStatus, 'verified')),
        })
        const testUser = await db.query.users.findFirst({
            where: eq(users.email, testEmail),
        })
        const testMailbox = testUser ? await db.query.mailboxes.findFirst({
            where: and(eq(mailboxes.email, testEmail), eq(mailboxes.userId, testUser.id)),
        }) : null

        res.json({
            env: envCheck,
            domains: allDomains.map(d => ({
                name: d.name,
                verificationStatus: d.verificationStatus,
                organizationId: d.organizationId,
            })),
            users: nonAdminUsers.map(u => ({
                id: u.id,
                email: u.email,
                hasPasswordHash: !!u.passwordHash,
            })),
            nativeMailboxes: mailboxDetails,
            diagnosticTest: {
                testEmail,
                domainVerified: !!verifiedTestDomain,
                domainDetails: verifiedTestDomain ? { name: verifiedTestDomain.name, orgId: verifiedTestDomain.organizationId } : null,
                userExists: !!testUser,
                userDetails: testUser ? { id: testUser.id, email: testUser.email, isAdmin: testUser.isAdmin } : null,
                mailboxExists: !!testMailbox,
                mailboxId: testMailbox?.id || null,
                wouldDeliverLocally: !!verifiedTestDomain && !!testUser && !!testMailbox,
                issues: [
                    !verifiedTestDomain && `Domain "${testDomain}" is NOT verified in any org`,
                    verifiedTestDomain && !testUser && `User "${testEmail}" does NOT exist in users table`,
                    testUser && testUser.isAdmin && `User "${testEmail}" is an ADMIN (blocked from native mail)`,
                    testUser && !testUser.passwordHash && `User "${testEmail}" has NO password hash (cannot auth SMTP/IMAP)`,
                    testUser && !testMailbox && `User "${testEmail}" has NO native mailbox (call createUserMailbox)`,
                ].filter(Boolean),
            },
            relayConfig: {
                hasSmtpRelay: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
                willUseDirect: !(process.env.SMTP_HOST && process.env.SMTP_USER),
                warning: !(process.env.SMTP_HOST && process.env.SMTP_USER)
                    ? 'No SMTP relay configured. External emails (e.g. to gmail.com) will attempt direct delivery which usually fails without proper MX/PTR/SPF setup.'
                    : null,
            },
        })
    } catch (error) {
        console.error('Error in mail-diag:', error)
        res.status(500).json({ error: 'Internal server error', message: (error as Error).message })
    }
})

export default router
