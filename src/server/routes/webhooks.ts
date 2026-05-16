import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { webhooks, webhookRequests, organizations, organizationUsers } from '../../db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { isPlatformAdmin } from '../lib/admin'
import { createHmac } from 'crypto'
import { isPrivateHostWithDns } from '../lib/network-guard'

const router = Router()

// Validation schemas
const createWebhookSchema = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1).max(100),
    url: z.string().url(),
    secret: z.string().optional(),
    active: z.boolean().default(true),
    events: z.array(z.enum([
        'message_sent',
        'message_delivered',
        'message_bounced',
        'message_held',
        'message_opened',
        'link_clicked',
        'domain_verified',
        'spam_alert'
    ])).min(1),
})

const updateWebhookSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    url: z.string().url().optional(),
    secret: z.string().optional(),
    active: z.boolean().optional(),
    events: z.array(z.string()).min(1).optional(),
})

// Helper to check access
export async function checkWebhookAccess(userId: string, organizationId: string) {
    const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
    })

    if (!organization) return { organization: null, membership: null }

    if (await isPlatformAdmin(userId)) {
        return { organization, membership: { role: 'admin' as const } }
    }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organization.id),
            eq(organizationUsers.userId, userId)
        ),
    })

    return { organization, membership }
}

// List webhooks for organization
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'Organization ID required' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const webhooksList = await db.query.webhooks.findMany({
            where: eq(webhooks.organizationId, organizationId),
            orderBy: [desc(webhooks.createdAt)],
        })

        res.json({ webhooks: webhooksList })
    } catch (error) {
        console.error('Error fetching webhooks:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get webhook by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const webhookId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const webhook = await db.query.webhooks.findFirst({
            where: eq(webhooks.id, webhookId),
            with: {
                organization: true,
            },
        })

        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, webhook.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ webhook })
    } catch (error) {
        console.error('Error fetching webhook:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create webhook
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = createWebhookSchema.parse(req.body)

        // SEC-01 — block SSRF at webhook write time (DNS-resolving, rebinding-safe)
        try {
            const parsed = new URL(data.url)
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return res.status(400).json({ error: 'Webhook URL must use http or https' })
            }
            if (await isPrivateHostWithDns(parsed.hostname)) {
                return res.status(400).json({ error: 'Webhook URL resolves to a private/internal host' })
            }
        } catch {
            return res.status(400).json({ error: 'Webhook URL is invalid' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, data.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can create webhooks' })
        }

        const [webhook] = await db.insert(webhooks).values({
            organizationId: data.organizationId,
            name: data.name,
            url: data.url,
            secret: data.secret,
            active: data.active,
            events: data.events,
        }).returning()

        res.status(201).json({ webhook })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating webhook:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update webhook
router.patch('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const webhookId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const updates = updateWebhookSchema.parse(req.body)

        // SEC-01 — re-validate URL on update (DNS-resolving, rebinding-safe)
        if (updates.url !== undefined) {
            try {
                const parsed = new URL(updates.url)
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return res.status(400).json({ error: 'Webhook URL must use http or https' })
                }
                if (await isPrivateHostWithDns(parsed.hostname)) {
                    return res.status(400).json({ error: 'Webhook URL resolves to a private/internal host' })
                }
            } catch {
                return res.status(400).json({ error: 'Webhook URL is invalid' })
            }
        }

        const webhook = await db.query.webhooks.findFirst({
            where: eq(webhooks.id, webhookId),
        })

        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, webhook.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can update webhooks' })
        }

        const [updatedWebhook] = await db
            .update(webhooks)
            .set({
                ...updates,
                updatedAt: new Date(),
            })
            .where(eq(webhooks.id, webhookId))
            .returning()

        res.json({ webhook: updatedWebhook })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating webhook:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete webhook
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const webhookId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const webhook = await db.query.webhooks.findFirst({
            where: eq(webhooks.id, webhookId),
        })

        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, webhook.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete webhooks' })
        }

        // Delete webhook requests first
        await db.delete(webhookRequests).where(eq(webhookRequests.webhookId, webhookId))
        // Delete webhook
        await db.delete(webhooks).where(eq(webhooks.id, webhookId))

        res.json({ message: 'Webhook deleted successfully' })
    } catch (error) {
        console.error('Error deleting webhook:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get webhook request history
router.get('/:id/requests', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const webhookId = req.params.id
        const limit = parseInt(req.query.limit as string) || 50

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const webhook = await db.query.webhooks.findFirst({
            where: eq(webhooks.id, webhookId),
        })

        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, webhook.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const requests = await db.query.webhookRequests.findMany({
            where: eq(webhookRequests.webhookId, webhookId),
            orderBy: [desc(webhookRequests.createdAt)],
            limit,
        })

        res.json({ requests })
    } catch (error) {
        console.error('Error fetching webhook requests:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Test webhook
router.post('/:id/test', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const webhookId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const webhook = await db.query.webhooks.findFirst({
            where: eq(webhooks.id, webhookId),
        })

        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found' })
        }

        const { organization, membership } = await checkWebhookAccess(userId, webhook.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can test webhooks' })
        }

        // Create a test payload
        const testPayload = {
            event: 'test',
            timestamp: new Date().toISOString(),
            organization: {
                id: organization.id,
                name: organization.name,
            },
            data: {
                message: 'This is a test webhook from SkaleClub Mail',
            },
        }

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'X-Webhook-Event': 'test',
            }

            if (webhook.secret) {
                const sig = createHmac('sha256', webhook.secret)
                    .update(JSON.stringify(testPayload))
                    .digest('hex')
                headers['X-Webhook-Signature'] = `sha256=${sig}`
            }

            const response = await fetch(webhook.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(testPayload),
                // COR-01 — see audit H2. Bound the test call so an admin entering a broken URL can't hang the request.
                signal: AbortSignal.timeout(10_000),
            })

            const responseBody = await response.text()

            // Log the request
            await db.insert(webhookRequests).values({
                webhookId: webhook.id,
                event: 'test',
                payload: testPayload,
                responseCode: response.status,
                responseBody: responseBody.substring(0, 5000),
                success: response.ok,
            })

            res.json({
                success: response.ok,
                statusCode: response.status,
                response: responseBody.substring(0, 1000),
            })
        } catch (fetchError) {
            // Log failed request
            await db.insert(webhookRequests).values({
                webhookId: webhook.id,
                event: 'test',
                payload: testPayload,
                success: false,
                error: fetchError instanceof Error ? fetchError.message : 'Unknown error',
            })

            res.status(400).json({
                success: false,
                error: fetchError instanceof Error ? fetchError.message : 'Failed to send webhook',
            })
        }
    } catch (error) {
        console.error('Error testing webhook:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router