import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import { emailAccounts, organizationUsers } from '../../../db/schema'
import { isPlatformAdmin } from '../../lib/admin'
import { dispatchOutreachMessage } from '../../lib/outreach-dispatch'
import { createThreadedDispatchProvider } from '../../lib/outreach-dispatch-provider'
import { incrementAccountStats } from '../../lib/outreach-sender'

const router = Router()

const sendMessageSchema = z.object({
    from: z.string().email('Invalid from address'),
    to: z.string().email('Invalid to address'),
    subject: z.string().min(1, 'Subject is required'),
    html: z.string().min(1, 'html is required'),
    text: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
})

async function checkOrgMembership(userId: string, organizationId: string) {
    const admin = await isPlatformAdmin(userId)
    if (admin) return { role: 'admin' as const }
    return db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId),
        ),
    })
}

function canWriteOutreach(membership: Awaited<ReturnType<typeof checkOrgMembership>>): boolean {
    return membership?.role === 'admin' || membership?.role === 'member'
}

router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })
        if (!organizationId) return res.status(400).json({ error: 'organizationId is required' })

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) return res.status(403).json({ error: 'Access denied' })
        if (!canWriteOutreach(membership)) return res.status(403).json({ error: 'Write access denied' })

        const { from, to, subject, html, text, idempotencyKey } = sendMessageSchema.parse(req.body)
        const requestId = idempotencyKey || req.get('Idempotency-Key')?.trim() || randomUUID()
        const account = await db.query.emailAccounts.findFirst({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                eq(emailAccounts.email, from),
                eq(emailAccounts.status, 'verified'),
            ),
        })
        if (!account) {
            return res.status(400).json({ error: `No verified sending inbox for ${from} in this organization` })
        }

        const dispatchResult = await dispatchOutreachMessage({
            origin: 'manual',
            organizationId,
            emailAccountId: account.id,
            idempotencyKey: `manual:${requestId}`,
            to,
            subject,
            html,
            text,
        }, {
            provider: createThreadedDispatchProvider({ account, fromName: account.displayName }),
        })

        if (dispatchResult.status === 'sent') {
            await incrementAccountStats(account.id, 'totalSent')
            return res.json({ success: true, messageId: dispatchResult.messageId, requestId })
        }
        if (dispatchResult.status === 'duplicate') {
            return res.json({ success: true, duplicate: true, requestId })
        }
        if (dispatchResult.status === 'deferred') {
            return res.status(dispatchResult.code === 'organization_disabled' ? 423 : 409).json({
                error: 'Outreach delivery is currently blocked',
                code: dispatchResult.code,
                retryAt: dispatchResult.retryAt,
                requestId,
            })
        }
        if (dispatchResult.status === 'failed' || dispatchResult.status === 'exhausted') {
            return res.status(502).json({ error: 'Provider delivery failed', code: dispatchResult.status, requestId })
        }
        return res.status(409).json({
            error: 'Delivery is not ready to repeat safely',
            code: dispatchResult.status,
            retryAt: dispatchResult.status === 'retry_scheduled' ? dispatchResult.nextAttemptAt : undefined,
            requestId,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error sending transactional message:', error)
        return res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
