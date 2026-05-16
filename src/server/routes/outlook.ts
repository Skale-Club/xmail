import { Router, Request, Response } from 'express'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { organizationUsers, organizations, outlookMailboxes, emailAccounts } from '../../db/schema'
import { isPlatformAdmin } from '../lib/admin'
import {
    buildOutlookOauthUrl,
    createOutlookOauthState,
    exchangeCodeForOutlookConnection,
    parseOutlookOauthState,
    resolveOutlookMailboxForServer,
    sanitizeOutlookMailbox,
    sendMessageWithOutlook,
} from '../lib/outlook'
import { encryptSecret } from '../lib/crypto'

const router = Router()

const startSchema = z.object({
    organizationId: z.string().uuid(),
    loginHint: z.string().email().optional(),
})

const sendTestSchema = z.object({
    to: z.string().email(),
    subject: z.string().min(1).default('SkaleClub Mail Outlook test'),
    body: z.string().min(1).default('This is a test message sent through Microsoft Graph.'),
})

export async function checkOutlookAccess(userId: string, organizationId: string) {
    const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
    })

    if (!organization) {
        return { organization: null, membership: null }
    }

    if (await isPlatformAdmin(userId)) {
        return { organization, membership: { role: 'admin' as const } }
    }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organization.id),
            eq(organizationUsers.userId, userId),
        ),
    })

    return { organization, membership }
}

function buildFrontendRedirect(params: Record<string, string>, redirectDestination?: string) {
    const dest = redirectDestination || '/admin/servers'
    const url = new URL(dest, process.env.FRONTEND_URL || 'http://localhost:9000')

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value)
    }

    return url.toString()
}

router.post('/connect/start', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = startSchema.parse(req.body)
        const { organization, membership } = await checkOutlookAccess(userId, data.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can connect Outlook mailboxes' })
        }

        const state = createOutlookOauthState(userId, data.organizationId)
        const authUrl = buildOutlookOauthUrl(state, data.loginHint)

        res.json({
            authUrl,
            state,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }

        console.error('Error starting Outlook OAuth:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined
    const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined
    const oauthError = typeof req.query.error === 'string' ? req.query.error : undefined

    if (oauthError) {
        return res.redirect(buildFrontendRedirect({
            outlook: 'error',
            reason: oauthError,
        }))
    }

    if (!code || !stateParam) {
        return res.status(400).json({ error: 'Missing OAuth code or state' })
    }

    try {
        const state = parseOutlookOauthState(stateParam)
        const { organization, membership } = await checkOutlookAccess(state.userId, state.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Outlook callback is no longer authorized' })
        }

        const connection = await exchangeCodeForOutlookConnection(code)
        const mailboxEmail = connection.profile.mail || connection.profile.userPrincipalName

        if (!mailboxEmail) {
            throw new Error('Outlook account does not expose a usable mailbox address')
        }

        const existingMailbox =
            await db.query.outlookMailboxes.findFirst({
                where: eq(outlookMailboxes.microsoftUserId, connection.profile.id),
            }) ||
            await db.query.outlookMailboxes.findFirst({
                where: and(
                    eq(outlookMailboxes.organizationId, state.organizationId),
                    eq(outlookMailboxes.email, mailboxEmail),
                ),
            })

        const payload = {
            organizationId: state.organizationId,
            email: mailboxEmail,
            displayName: connection.profile.displayName || null,
            microsoftUserId: connection.profile.id,
            tenantId: connection.tenantId,
            scopes: connection.scopes,
            accessTokenEncrypted: encryptSecret(connection.accessToken),
            refreshTokenEncrypted: encryptSecret(connection.refreshToken || connection.accessToken),
            tokenExpiresAt: connection.expiresAt,
            status: 'active' as const,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
        }

        const [mailbox] = existingMailbox
            ? await db
                .update(outlookMailboxes)
                .set(payload)
                .where(eq(outlookMailboxes.id, existingMailbox.id))
                .returning()
            : await db.insert(outlookMailboxes).values(payload).returning()

        const dest = '/outreach/inboxes'
        const existingEmailAccount = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.outlookMailboxId, mailbox.id),
        })

        if (!existingEmailAccount) {
            await db.insert(emailAccounts).values({
                organizationId: state.organizationId,
                email: mailboxEmail,
                displayName: connection.profile.displayName || mailbox.displayName,
                provider: 'outlook',
                outlookMailboxId: mailbox.id,
                status: 'verified',
                verifiedAt: new Date(),
                dailySendLimit: 50,
                warmupEnabled: true,
                warmupDays: 14,
            })
        } else {
            await db.update(emailAccounts)
                .set({
                    displayName: connection.profile.displayName || mailbox.displayName,
                    status: 'verified',
                    verifiedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, existingEmailAccount.id))
        }

        return res.redirect(buildFrontendRedirect({
            outlook: 'connected',
            mailbox: mailbox.email,
        }, dest))
    } catch (error) {
        console.error('Error completing Outlook OAuth:', error)
        return res.redirect(buildFrontendRedirect({
            outlook: 'error',
            reason: error instanceof Error ? error.message : 'callback_failed',
        }, '/admin/servers'))
    }
})

router.get('/mailboxes', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'Organization ID required' })
        }

        const { organization, membership } = await checkOutlookAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const mailboxes = await db.query.outlookMailboxes.findMany({
            where: eq(outlookMailboxes.organizationId, organizationId),
        })

        res.json({
            mailboxes: mailboxes.map(sanitizeOutlookMailbox),
        })
    } catch (error) {
        console.error('Error listing Outlook mailboxes:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/mailboxes/:id/send-test', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await db.query.outlookMailboxes.findFirst({
            where: eq(outlookMailboxes.id, mailboxId),
        })

        if (!mailbox) {
            return res.status(404).json({ error: 'Outlook mailbox not found' })
        }

        const { organization, membership } = await checkOutlookAccess(userId, mailbox.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can send Outlook tests' })
        }

        const data = sendTestSchema.parse(req.body)

        await sendMessageWithOutlook({
            organizationId: mailbox.organizationId,
            mailboxId: mailbox.id,
            fromAddress: mailbox.email,
            to: [data.to],
            subject: data.subject,
            plainBody: data.body,
        })

        res.json({
            message: 'Test message sent successfully',
            mailbox: sanitizeOutlookMailbox(mailbox),
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }

        console.error('Error sending Outlook test:', error)
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Internal server error',
        })
    }
})

router.delete('/mailboxes/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await db.query.outlookMailboxes.findFirst({
            where: eq(outlookMailboxes.id, mailboxId),
        })

        if (!mailbox) {
            return res.status(404).json({ error: 'Outlook mailbox not found' })
        }

        const { organization, membership } = await checkOutlookAccess(userId, mailbox.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can disconnect Outlook mailboxes' })
        }

        await db.delete(outlookMailboxes).where(eq(outlookMailboxes.id, mailboxId))

        res.json({ message: 'Outlook mailbox disconnected successfully' })
    } catch (error) {
        console.error('Error disconnecting Outlook mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/mailboxes/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await db.query.outlookMailboxes.findFirst({
            where: eq(outlookMailboxes.id, mailboxId),
        })

        if (!mailbox) {
            return res.status(404).json({ error: 'Outlook mailbox not found' })
        }

        const { organization, membership } = await checkOutlookAccess(userId, mailbox.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const activeMailbox = await resolveOutlookMailboxForServer(mailbox.organizationId, mailbox.id)

        res.json({
            mailbox: sanitizeOutlookMailbox(activeMailbox || mailbox),
        })
    } catch (error) {
        console.error('Error fetching Outlook mailbox:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
