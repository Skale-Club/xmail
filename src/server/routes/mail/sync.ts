import { Router, Request, Response } from 'express'
import { syncMailbox, syncAllMailboxes } from '../../lib/mail-sync'
import { checkUserMailboxAccess } from './mailboxes'
import { db } from '../../../db'
import { users } from '../../../db/schema'
import { eq } from 'drizzle-orm'

const router = Router()

router.post('/:mailboxId/sync', async (req: Request, res: Response) => {
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

        const result = await syncMailbox(mailboxId)

        res.json({
            success: result.errors.length === 0,
            newMessages: result.newMessages,
            errors: result.errors,
        })

    } catch (error) {
        console.error('Error syncing mailbox:', error)
        res.status(500).json({ error: 'Sync failed' })
    }
})

router.post('/sync-all', async (req: Request, res: Response) => {
    try {
        // Syncing every mailbox in the system is a platform-wide operation:
        // only platform admins may trigger it.
        const userId = req.headers['x-user-id'] as string
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }
        const requester = await db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: { id: true, isAdmin: true },
        })
        if (!requester?.isAdmin) {
            return res.status(403).json({ error: 'Admin access required' })
        }

        const results = await syncAllMailboxes()

        const totalNew = results.reduce((sum, r) => sum + r.newMessages, 0)
        const totalErrors = results.flatMap(r => r.errors)

        res.json({
            success: totalErrors.length === 0,
            mailboxesProcessed: results.length,
            totalNewMessages: totalNew,
            errors: totalErrors,
        })

    } catch (error) {
        console.error('Error syncing all mailboxes:', error)
        res.status(500).json({ error: 'Sync failed' })
    }
})

export default router
