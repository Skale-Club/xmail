import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { eq, and, desc, like, sql } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../../db'
import { messages, organizations, organizationUsers, deliveries, templates } from '../../db/schema'
import { isPlatformAdmin } from '../lib/admin'
import { injectTracking, incrementStat, fireWebhooks } from '../lib/tracking'
import { resolveOutlookMailboxForServer, sendMessageWithOutlook } from '../lib/outlook'

const router = Router()

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

const sendMessageSchema = z.object({
    organizationId: z.string().uuid(),
    outlookMailboxId: z.string().uuid().optional(),
    from: z.string().email(),
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
    subject: z.string().min(1).max(998),
    plainBody: z.string().max(5_000_000).optional(),
    htmlBody: z.string().max(5_000_000).optional(),
    headers: z.record(z.string()).optional(),
    attachments: z.array(z.object({
        filename: z.string(),
        content: z.string(),
        contentType: z.string(),
    })).optional(),
    templateId: z.string().uuid().optional(),
    templateVariables: z.record(z.string()).optional(),
})

const searchMessagesSchema = z.object({
    query: z.string().optional(),
    status: z.enum(['pending', 'queued', 'sent', 'delivered', 'bounced', 'held', 'failed']).optional(),
    direction: z.enum(['incoming', 'outgoing']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})

export async function checkMessageAccess(userId: string, organizationId: string) {
    const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
    })

    if (!organization) return { organization: null, membership: null }

    if (await isPlatformAdmin(userId)) {
        return { organization, membership: { role: 'admin' as const } }
    }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId)
        ),
    })

    return { organization, membership }
}

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

        const { organization, membership } = await checkMessageAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const { query, status, direction, from, to, page, limit } = searchMessagesSchema.parse(req.query)
        const offset = (page - 1) * limit
        const conditions = [eq(messages.organizationId, organizationId)]

        if (status) {
            conditions.push(eq(messages.status, status))
        }

        if (direction) {
            conditions.push(eq(messages.direction, direction))
        }

        if (from) {
            const fromPattern = `%${from}%`
            conditions.push(like(messages.fromAddress, fromPattern))
        }

        if (to) {
            const toPattern = `%${to}%`
            conditions.push(sql`${messages.toAddresses}::text ilike ${toPattern}`)
        }

        if (query) {
            const queryPattern = `%${query}%`
            conditions.push(
                sql`(
                    ${messages.subject} ilike ${queryPattern}
                    OR ${messages.fromAddress} ilike ${queryPattern}
                    OR ${messages.toAddresses}::text ilike ${queryPattern}
                )`
            )
        }

        const messagesList = await db.query.messages.findMany({
            where: and(...conditions),
            columns: {
                htmlBody: false,
                plainBody: false,
                attachments: false,
                headers: false,
                spamChecks: false,
            },
            orderBy: [desc(messages.createdAt)],
            limit,
            offset,
        })

        const [{ count }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(messages)
            .where(and(...conditions))

        res.json({
            messages: messagesList,
            pagination: {
                page,
                limit,
                total: Number(count),
                totalPages: Math.ceil(Number(count) / limit),
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error fetching messages:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const messageId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const message = await db.query.messages.findFirst({
            where: eq(messages.id, messageId),
            with: {
                deliveries: true,
            },
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const { organization, membership } = await checkMessageAccess(userId, message.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ message })
    } catch (error) {
        console.error('Error fetching message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = sendMessageSchema.parse(req.body)
        const { organization, membership } = await checkMessageAccess(userId, data.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const sendMode: 'smtp' | 'outlook' = data.outlookMailboxId ? 'outlook' : 'smtp'
        const trackOpens = true
        const trackClicks = true
        const privacyMode = false

        let subject = data.subject
        let plainBody = data.plainBody
        let htmlBody = data.htmlBody

        if (data.templateId) {
            const template = await db.query.templates.findFirst({
                where: eq(templates.id, data.templateId),
            })

            if (!template) {
                return res.status(404).json({ error: 'Template not found' })
            }

            if (template.organizationId !== data.organizationId) {
                return res.status(403).json({ error: 'Template does not belong to this organization' })
            }

            const variables = data.templateVariables || {}
            const render = (text: string | null, isHtml: boolean): string | null => {
                if (!text) return text
                return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
                    const value = variables[key] ?? `{{${key}}}`
                    return isHtml ? escapeHtml(value) : value
                })
            }

            subject = render(template.subject, false) || subject
            plainBody = render(template.plainBody, false) || plainBody
            htmlBody = render(template.htmlBody, true) || htmlBody
        }

        const outlookMailbox = sendMode === 'outlook'
            ? await resolveOutlookMailboxForServer(data.organizationId, data.outlookMailboxId)
            : null

        if (sendMode === 'outlook') {
            if (!outlookMailbox) {
                return res.status(400).json({ error: 'No active Outlook mailbox configured for this organization' })
            }

            if (data.from.toLowerCase() !== outlookMailbox.email.toLowerCase()) {
                return res.status(400).json({
                    error: `Outlook send mode requires the from address to match the connected mailbox (${outlookMailbox.email})`,
                })
            }
        }

        if (!plainBody && !htmlBody) {
            return res.status(400).json({ error: 'Message body is required' })
        }

        const messageToken = uuidv4()

        if (htmlBody && !privacyMode && (trackOpens || trackClicks)) {
            const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 9001}`
            htmlBody = injectTracking(htmlBody, messageToken, baseUrl, trackOpens, trackClicks)
        }

        const [message] = await db.insert(messages).values({
            organizationId: data.organizationId,
            messageId: `<${uuidv4()}@mail.local>`,
            token: messageToken,
            direction: 'outgoing',
            fromAddress: data.from,
            toAddresses: data.to,
            ccAddresses: data.cc || [],
            bccAddresses: data.bcc || [],
            subject,
            plainBody,
            htmlBody,
            headers: data.headers || {},
            attachments: data.attachments || [],
            status: 'queued',
        }).returning()

        const allRecipients = [...data.to, ...(data.cc || []), ...(data.bcc || [])]

        if (allRecipients.length > 0) {
            await db.insert(deliveries).values(
                allRecipients.map(recipient => ({
                    messageId: message.id,
                    organizationId: data.organizationId,
                    rcptTo: recipient,
                    status: 'pending' as const,
                }))
            )
        }

        if (sendMode === 'outlook' && outlookMailbox) {
            try {
                await sendMessageWithOutlook({
                    organizationId: data.organizationId,
                    mailboxId: outlookMailbox.id,
                    fromAddress: data.from,
                    to: data.to,
                    cc: data.cc,
                    bcc: data.bcc,
                    subject,
                    plainBody,
                    htmlBody,
                    attachments: data.attachments,
                })

                const sentAt = new Date()

                await db
                    .update(messages)
                    .set({
                        status: 'sent',
                        sentAt,
                        updatedAt: sentAt,
                    })
                    .where(eq(messages.id, message.id))

                await db
                    .update(deliveries)
                    .set({
                        status: 'sent',
                        sentAt,
                    })
                    .where(eq(deliveries.messageId, message.id))

                message.status = 'sent'
                message.sentAt = sentAt
            } catch (error) {
                const details = error instanceof Error ? error.message : 'Outlook send failed'
                const failedAt = new Date()

                await db
                    .update(messages)
                    .set({
                        status: 'failed',
                        updatedAt: failedAt,
                    })
                    .where(eq(messages.id, message.id))

                await db
                    .update(deliveries)
                    .set({
                        status: 'failed',
                        details,
                    })
                    .where(eq(deliveries.messageId, message.id))

                return res.status(502).json({
                    error: details,
                    message: {
                        ...message,
                        status: 'failed',
                    },
                })
            }
        }

        Promise.allSettled([
            incrementStat(data.organizationId, 'messagesSent'),
            fireWebhooks(data.organizationId, 'message_sent', {
                messageId: message.id,
                subject: message.subject,
                from: message.fromAddress,
                to: message.toAddresses,
                recipients: allRecipients.length,
            }),
        ]).catch(() => {})

        res.status(201).json({
            message,
            recipients: allRecipients.length,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error sending message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:id/release', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const messageId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const message = await db.query.messages.findFirst({
            where: eq(messages.id, messageId),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const { organization, membership } = await checkMessageAccess(userId, message.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can release held messages' })
        }

        if (!message.held) {
            return res.status(400).json({ error: 'Message is not held' })
        }

        const [updatedMessage] = await db
            .update(messages)
            .set({
                held: false,
                holdExpiry: null,
                heldReason: null,
                status: 'queued',
                updatedAt: new Date(),
            })
            .where(eq(messages.id, messageId))
            .returning()

        res.json({ message: updatedMessage })
    } catch (error) {
        console.error('Error releasing message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const messageId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const message = await db.query.messages.findFirst({
            where: eq(messages.id, messageId),
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const { organization, membership } = await checkMessageAccess(userId, message.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete messages' })
        }

        await db.delete(deliveries).where(eq(deliveries.messageId, messageId))
        await db.delete(messages).where(eq(messages.id, messageId))

        res.json({ message: 'Message deleted successfully' })
    } catch (error) {
        console.error('Error deleting message:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:id/attachments', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const messageId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const message = await db.query.messages.findFirst({
            where: eq(messages.id, messageId),
            columns: {
                id: true,
                organizationId: true,
                attachments: true,
            },
        })

        if (!message) {
            return res.status(404).json({ error: 'Message not found' })
        }

        const { organization, membership } = await checkMessageAccess(userId, message.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ attachments: message.attachments || [] })
    } catch (error) {
        console.error('Error fetching attachments:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
