import { Router, type Request, type Response } from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import { outreachActionApprovals } from '../../../db/schema'
import { requireOutreachWrite, SERVICE_PRINCIPAL_HEADER } from '../../lib/outreach-access'
import { approveOutreachAction, rejectOutreachAction } from '../../lib/approval-actions'
import { buildCampaignActivationPreview, type CampaignActivationPreview } from '../../lib/outreach-approval-preview'

const router = Router()

async function requireInteractiveAdmin(req: Request, res: Response, organizationId: string) {
    if (req.headers[SERVICE_PRINCIPAL_HEADER] === 'true') {
        res.status(403).json({ error: 'Action approvals require an interactive human session' })
        return null
    }
    const membership = await requireOutreachWrite(req, res, organizationId)
    if (!membership) return null
    if (membership.role !== 'admin') {
        res.status(403).json({ error: 'Organization admin access required' })
        return null
    }
    return membership
}

const approvalQuerySchema = z.object({
    organizationId: z.string().uuid(),
    status: z.enum(['requested', 'approved', 'rejected', 'executing', 'executed', 'failed', 'expired', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
})

router.get('/', async (req, res) => {
    try {
        const query = approvalQuerySchema.parse(req.query)
        if (!await requireInteractiveAdmin(req, res, query.organizationId)) return
        const where = query.status
            ? and(eq(outreachActionApprovals.organizationId, query.organizationId), eq(outreachActionApprovals.status, query.status))
            : eq(outreachActionApprovals.organizationId, query.organizationId)
        const approvals = await db.query.outreachActionApprovals.findMany({
            where,
            orderBy: [desc(outreachActionApprovals.requestedAt)],
            limit: query.limit,
        })
        // Fase 37 / audit finding 2: a reviewer must see the campaign, subject, body, lead
        // counts, sending inbox and compliance state BEFORE approving, not just a resource id.
        // Computed only for the pending campaign_activation requests a reviewer would actually
        // act on — historical approved/executed rows keep their original (lighter) shape.
        const enriched: Array<typeof approvals[number] & { campaignPreview?: CampaignActivationPreview | null }> =
            await Promise.all(approvals.map(async (approval) => {
                if (approval.actionKind !== 'campaign_activation' || approval.status !== 'requested') {
                    return approval
                }
                try {
                    const campaignPreview = await buildCampaignActivationPreview(approval.resourceId, query.organizationId)
                    return { ...approval, campaignPreview }
                } catch (error) {
                    console.error('Error building campaign activation preview:', error)
                    return { ...approval, campaignPreview: null }
                }
            }))
        res.json({ approvals: enriched })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error listing outreach approvals:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:id/approve', async (req, res) => {
    try {
        const query = z.object({ organizationId: z.string().uuid() }).parse(req.query)
        const body = z.object({ confirm: z.literal(true), note: z.string().trim().max(2_000).optional() }).parse(req.body)
        const actorUserId = req.headers['x-user-id'] as string | undefined
        if (!actorUserId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await requireInteractiveAdmin(req, res, query.organizationId)) return
        // Same code path as the Telegram buttons (lib/telegram-approvals.ts).
        const outcome = await approveOutreachAction({
            approvalId: req.params.id,
            organizationId: query.organizationId,
            actorUserId,
            note: body.note,
        })
        res.status(outcome.status).json(outcome.body)
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error approving outreach action:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:id/reject', async (req, res) => {
    try {
        const query = z.object({ organizationId: z.string().uuid() }).parse(req.query)
        const body = z.object({ reason: z.string().trim().min(1).max(2_000) }).parse(req.body)
        const actorUserId = req.headers['x-user-id'] as string | undefined
        if (!actorUserId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await requireInteractiveAdmin(req, res, query.organizationId)) return
        const outcome = await rejectOutreachAction({
            approvalId: req.params.id,
            organizationId: query.organizationId,
            actorUserId,
            reason: body.reason,
        })
        res.status(outcome.status).json(outcome.body)
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error rejecting outreach action:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
