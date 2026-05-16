import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../../../db'
import { mailFilters, mailMessages, mailFolders } from '../../../db/schema'
import { checkUserMailboxAccess } from './mailboxes'

const router = Router()

interface FilterCondition {
    field: 'from' | 'to' | 'subject' | 'body' | 'hasAttachment'
    operator: 'contains' | 'equals' | 'startsWith' | 'notContains' | 'regex'
    value: string
}

interface FilterAction {
    action: 'markRead' | 'markUnread' | 'markStarred' | 'unmarkStarred' | 'moveToFolder' | 'markSpam' | 'markNotSpam' | 'archive' | 'addLabel'
    value?: string
}

function evaluateCondition(condition: FilterCondition, message: any): boolean {
    let fieldValue: string = ''

    switch (condition.field) {
        case 'from':
            fieldValue = message.fromAddress?.toLowerCase() || ''
            break
        case 'to':
            fieldValue = Array.isArray(message.toAddresses)
                ? message.toAddresses.map((t: any) => t.address).join(' ').toLowerCase()
                : ''
            break
        case 'subject':
            fieldValue = message.subject?.toLowerCase() || ''
            break
        case 'body':
            fieldValue = (message.plainBody || message.htmlBody || '').toLowerCase()
            break
        case 'hasAttachment':
            return condition.value === 'yes' ? message.hasAttachments : !message.hasAttachments
    }

    const searchValue = condition.value.toLowerCase()

    switch (condition.operator) {
        case 'contains':
            return fieldValue.includes(searchValue)
        case 'notContains':
            return !fieldValue.includes(searchValue)
        case 'equals':
            return fieldValue === searchValue
        case 'startsWith':
            return fieldValue.startsWith(searchValue)
        case 'regex':
            try {
                const regex = new RegExp(condition.value, 'i')
                return regex.test(fieldValue)
            } catch {
                return false
            }
        default:
            return false
    }
}

async function applyFilter(message: any, actions: FilterAction[]): Promise<void> {
    const updates: any = { updatedAt: new Date() }

    for (const action of actions) {
        switch (action.action) {
            case 'markRead':
                updates.isRead = true
                break
            case 'markUnread':
                updates.isRead = false
                break
            case 'markStarred':
                updates.isStarred = true
                break
            case 'unmarkStarred':
                updates.isStarred = false
                break
            case 'markSpam':
                updates.isSpam = true
                break
            case 'markNotSpam':
                updates.isSpam = false
                break
            case 'archive': {
                const archiveFolder = await db.query.mailFolders.findFirst({
                    where: and(
                        eq(mailFolders.mailboxId, message.mailboxId),
                        eq(mailFolders.remoteId, 'Archive')
                    ),
                })
                if (archiveFolder) {
                    updates.folderId = archiveFolder.id
                }
                break
            }
            case 'moveToFolder':
                if (action.value) {
                    const targetFolder = await db.query.mailFolders.findFirst({
                        where: and(
                            eq(mailFolders.mailboxId, message.mailboxId),
                            eq(mailFolders.id, action.value)
                        ),
                    })
                    if (targetFolder) {
                        updates.folderId = targetFolder.id
                    }
                }
                break
        }
    }

    if (Object.keys(updates).length > 1) {
        await db.update(mailMessages)
            .set(updates)
            .where(eq(mailMessages.id, message.id))
    }
}

router.get('/:mailboxId/filters', async (req: Request, res: Response) => {
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

        const filters = await db.query.mailFilters.findMany({
            where: eq(mailFilters.mailboxId, mailboxId),
            orderBy: [desc(mailFilters.priority), desc(mailFilters.createdAt)],
        })

        res.json({ filters })
    } catch (error) {
        console.error('Error fetching filters:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/filters', async (req: Request, res: Response) => {
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
            name: z.string().min(1).max(100),
            conditions: z.array(z.object({
                field: z.enum(['from', 'to', 'subject', 'body', 'hasAttachment']),
                operator: z.enum(['contains', 'equals', 'startsWith', 'notContains', 'regex']),
                value: z.string(),
            })).min(1),
            actions: z.array(z.object({
                action: z.enum(['markRead', 'markUnread', 'markStarred', 'unmarkStarred', 'moveToFolder', 'markSpam', 'markNotSpam', 'archive', 'addLabel']),
                value: z.string().optional(),
            })).min(1),
            isActive: z.boolean().default(true),
            priority: z.number().int().default(0),
        })

        const data = schema.parse(req.body)

        const [created] = await db.insert(mailFilters).values({
            mailboxId,
            name: data.name,
            conditions: data.conditions,
            actions: data.actions,
            isActive: data.isActive,
            priority: data.priority,
        }).returning()

        res.status(201).json({ filter: created })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating filter:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.put('/:mailboxId/filters/:filterId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const filterId = req.params.filterId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const schema = z.object({
            name: z.string().min(1).max(100).optional(),
            conditions: z.array(z.object({
                field: z.enum(['from', 'to', 'subject', 'body', 'hasAttachment']),
                operator: z.enum(['contains', 'equals', 'startsWith', 'notContains', 'regex']),
                value: z.string(),
            })).min(1).optional(),
            actions: z.array(z.object({
                action: z.enum(['markRead', 'markUnread', 'markStarred', 'unmarkStarred', 'moveToFolder', 'markSpam', 'markNotSpam', 'archive', 'addLabel']),
                value: z.string().optional(),
            })).min(1).optional(),
            isActive: z.boolean().optional(),
            priority: z.number().int().optional(),
        })

        const data = schema.parse(req.body)

        const existing = await db.query.mailFilters.findFirst({
            where: and(
                eq(mailFilters.id, filterId),
                eq(mailFilters.mailboxId, mailboxId)
            ),
        })

        if (!existing) {
            return res.status(404).json({ error: 'Filter not found' })
        }

        const updateData: any = { updatedAt: new Date() }
        if (data.name !== undefined) updateData.name = data.name
        if (data.conditions !== undefined) updateData.conditions = data.conditions
        if (data.actions !== undefined) updateData.actions = data.actions
        if (data.isActive !== undefined) updateData.isActive = data.isActive
        if (data.priority !== undefined) updateData.priority = data.priority

        const [updated] = await db.update(mailFilters)
            .set(updateData)
            .where(eq(mailFilters.id, filterId))
            .returning()

        res.json({ filter: updated })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating filter:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:mailboxId/filters/:filterId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const filterId = req.params.filterId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        await db.delete(mailFilters).where(
            and(
                eq(mailFilters.id, filterId),
                eq(mailFilters.mailboxId, mailboxId)
            )
        )

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting filter:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:mailboxId/filters/:filterId/test', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const mailboxId = req.params.mailboxId
        const filterId = req.params.filterId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const mailbox = await checkUserMailboxAccess(userId, mailboxId)
        if (!mailbox) {
            return res.status(404).json({ error: 'Mailbox not found' })
        }

        const filter = await db.query.mailFilters.findFirst({
            where: and(
                eq(mailFilters.id, filterId),
                eq(mailFilters.mailboxId, mailboxId)
            ),
        })

        if (!filter) {
            return res.status(404).json({ error: 'Filter not found' })
        }

        const conditions = filter.conditions as FilterCondition[]
        const messages = await db.query.mailMessages.findMany({
            where: eq(mailMessages.mailboxId, mailboxId),
            limit: 50,
        })

        const matchingMessages: any[] = []
        
        for (const message of messages) {
            const matches = conditions.every(cond => evaluateCondition(cond, message))
            if (matches) {
                matchingMessages.push(message)
            }
        }

        res.json({
            filter: filter.name,
            matchingCount: matchingMessages.length,
            sampleMessages: matchingMessages.slice(0, 5).map(m => ({
                id: m.id,
                subject: m.subject,
                from: m.fromAddress,
            })),
        })
    } catch (error) {
        console.error('Error testing filter:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export async function runFiltersOnMessage(messageId: string): Promise<void> {
    const message = await db.query.mailMessages.findFirst({
        where: eq(mailMessages.id, messageId),
    })

    if (!message) return

    const filters = await db.query.mailFilters.findMany({
        where: and(
            eq(mailFilters.mailboxId, message.mailboxId),
            eq(mailFilters.isActive, true)
        ),
        orderBy: [desc(mailFilters.priority)],
    })

    for (const filter of filters) {
        const conditions = filter.conditions as FilterCondition[]
        const matches = conditions.every(cond => evaluateCondition(cond, message))

        if (matches) {
            const actions = filter.actions as FilterAction[]
            await applyFilter(message, actions)
        }
    }
}

export default router