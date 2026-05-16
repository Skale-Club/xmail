import { Router, Request, Response } from 'express'
import { db } from '../../db'
import { userNotifications } from '../../db/schema'
import { eq, and, desc, sql } from 'drizzle-orm'
import { getAuthenticatedUserFromRequest } from '../lib/user-sync'

const router = Router()

// NOTE: createNotificationSchema + updateNotificationSchema + notificationTypes previously defined
// here were removed (Phase 12 COR-07 lint cleanup). Re-add when their endpoints are implemented.

router.get('/', async (req: Request, res: Response) => {
    try {
        const user = getAuthenticatedUserFromRequest(req)
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const page = Math.max(1, parseInt(req.query.page as string) || 1)
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
        const offset = (page - 1) * limit

        const notifications = await db.select()
            .from(userNotifications)
            .where(eq(userNotifications.userId, user.id))
            .orderBy(desc(userNotifications.createdAt))
            .limit(limit)
            .offset(offset)

        const countResult = await db.select({ count: sql<number>`count(*)` })
            .from(userNotifications)
            .where(eq(userNotifications.userId, user.id))

        const total = Number(countResult[0]?.count || 0)

        res.json({
            data: notifications,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        })
    } catch (error) {
        console.error('Error fetching notifications:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/unread-count', async (req: Request, res: Response) => {
    try {
        const user = getAuthenticatedUserFromRequest(req)
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const result = await db.select({ count: sql<number>`count(*)` })
            .from(userNotifications)
            .where(and(
                eq(userNotifications.userId, user.id),
                eq(userNotifications.read, false)
            ))

        const unreadCount = Number(result[0]?.count || 0)

        res.json({ unreadCount })
    } catch (error) {
        console.error('Error fetching unread count:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.put('/:id/read', async (req: Request, res: Response) => {
    try {
        const user = getAuthenticatedUserFromRequest(req)
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { id } = req.params

        const existing = await db.query.userNotifications.findFirst({
            where: and(
                eq(userNotifications.id, id),
                eq(userNotifications.userId, user.id)
            ),
        })

        if (!existing) {
            return res.status(404).json({ error: 'Notification not found' })
        }

        await db.update(userNotifications)
            .set({ read: true })
            .where(eq(userNotifications.id, id))

        res.json({ success: true })
    } catch (error) {
        console.error('Error marking notification as read:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.put('/read-all', async (req: Request, res: Response) => {
    try {
        const user = getAuthenticatedUserFromRequest(req)
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        await db.update(userNotifications)
            .set({ read: true })
            .where(eq(userNotifications.userId, user.id))

        res.json({ success: true })
    } catch (error) {
        console.error('Error marking all notifications as read:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const user = getAuthenticatedUserFromRequest(req)
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { id } = req.params

        const existing = await db.query.userNotifications.findFirst({
            where: and(
                eq(userNotifications.id, id),
                eq(userNotifications.userId, user.id)
            ),
        })

        if (!existing) {
            return res.status(404).json({ error: 'Notification not found' })
        }

        await db.delete(userNotifications)
            .where(eq(userNotifications.id, id))

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting notification:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router