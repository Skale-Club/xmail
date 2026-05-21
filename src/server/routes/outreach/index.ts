import { Router } from 'express'
import emailAccountsRouter from './email-accounts'
import leadsRouter from './leads'
import campaignsRouter from './campaigns'

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

export default router
