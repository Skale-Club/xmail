import { Router } from 'express'
import emailAccountsRouter from './email-accounts'
import leadsRouter from './leads'
import campaignsRouter from './campaigns'
import settingsRouter from './settings'
import sendMessageRouter from './send-message'
import unifiedInboxRouter from './unified-inbox'

const router = Router()

router.use(async (req, res, next) => {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
})

// Email Accounts routes
router.use('/email-accounts', emailAccountsRouter)

// Leads routes
router.use('/leads', leadsRouter)

// Campaigns routes
router.use('/campaigns', campaignsRouter)

// Settings routes
router.use('/settings', settingsRouter)

// One-to-one transactional send routes
router.use('/send-message', sendMessageRouter)

// Unified Inbox read API (Phase 21 UIF-04/05): list/detail/unread/read-state
router.use('/unified-inbox', unifiedInboxRouter)

export default router
