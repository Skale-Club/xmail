import { Router } from 'express'
import mailboxRoutes from './mailboxes'
import messageRoutes from './messages'
import eventRoutes from './events'
import sendRoutes from './send'
import syncRoutes from './sync'
import filterRoutes from './filters'
import signatureRoutes from './signatures'
import contactRoutes from './contacts'
import trustedImageDomainRoutes from './trusted-image-domains'

const router = Router()

router.use('/mailboxes', mailboxRoutes)
router.use('/mailboxes', eventRoutes)
router.use('/mailboxes', messageRoutes)
router.use('/mailboxes', sendRoutes)
router.use('/mailboxes', syncRoutes)
router.use('/mailboxes', filterRoutes)
router.use('/mailboxes', signatureRoutes)
router.use('/contacts', contactRoutes)
router.use('/trusted-image-domains', trustedImageDomainRoutes)

export default router