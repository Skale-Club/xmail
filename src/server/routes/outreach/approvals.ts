import { Router, type Request, type Response } from 'express'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import { campaigns, outreachActionApprovals } from '../../../db/schema'
import { publishOutreachEvent } from '../../lib/xphere-events'
import { requireOutreachWrite, SERVICE_PRINCIPAL_HEADER } from '../../lib/outreach-access'
import { validateCampaignReadyForActivation } from './campaigns'

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
        res.json({ approvals })
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
        const approval = await db.query.outreachActionApprovals.findFirst({
            where: and(eq(outreachActionApprovals.id, req.params.id), eq(outreachActionApprovals.organizationId, query.organizationId)),
        })
        if (!approval) return res.status(404).json({ error: 'Approval request not found' })
        if (approval.status === 'approved' || approval.status === 'executed') {
            return res.json({ approval, idempotentReplay: true })
        }
        if (approval.status !== 'requested') {
            return res.status(409).json({ error: `Approval cannot be approved from status ${approval.status}` })
        }
        if (approval.expiresAt <= new Date()) {
            await db.update(outreachActionApprovals).set({ status: 'expired', updatedAt: new Date() })
                .where(and(eq(outreachActionApprovals.id, approval.id), eq(outreachActionApprovals.status, 'requested')))
            return res.status(410).json({ error: 'Approval request expired' })
        }

        if (approval.actionKind === 'campaign_activation') {
            const campaign = await db.query.campaigns.findFirst({
                where: and(eq(campaigns.id, approval.resourceId), eq(campaigns.organizationId, query.organizationId)),
            })
            if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
            const issues = await validateCampaignReadyForActivation(campaign.id, query.organizationId)
            if (issues.length > 0) return res.status(422).json({ error: 'Campaign is not ready to activate', issues })
            const now = new Date()
            const result = await db.transaction(async (tx) => {
                const [updatedApproval] = await tx.update(outreachActionApprovals).set({
                    status: 'executed',
                    reviewerUserId: actorUserId,
                    reviewedAt: now,
                    reviewNote: body.note,
                    executionStartedAt: now,
                    executedAt: now,
                    updatedAt: now,
                }).where(and(
                    eq(outreachActionApprovals.id, approval.id),
                    eq(outreachActionApprovals.organizationId, query.organizationId),
                    eq(outreachActionApprovals.status, 'requested'),
                )).returning()
                if (!updatedApproval) return null
                const [updatedCampaign] = await tx.update(campaigns).set({
                    status: 'active',
                    activationApprovalId: approval.id,
                    startedAt: campaign.startedAt ?? now,
                    pausedAt: null,
                    pausedReason: null,
                    updatedAt: now,
                }).where(and(
                    eq(campaigns.id, campaign.id),
                    eq(campaigns.organizationId, query.organizationId),
                    inArray(campaigns.status, ['draft', 'paused', 'active']),
                )).returning()
                if (!updatedCampaign) {
                    throw new Error('CAMPAIGN_STATE_CHANGED')
                }
                return { approval: updatedApproval, campaign: updatedCampaign }
            })
            if (!result) return res.status(409).json({ error: 'Approval state changed concurrently' })
            await publishOutreachEvent({
                organizationId: query.organizationId,
                eventType: 'campaign.activation_approved',
                aggregateType: 'campaign',
                aggregateId: campaign.id,
                deduplicationKey: `campaign.activation_approved:${approval.id}`,
                payload: { campaign_id: campaign.id, approval_id: approval.id, reviewer_user_id: actorUserId },
            })
            return res.json({ ...result, idempotentReplay: false })
        }

        const [updated] = await db.update(outreachActionApprovals).set({
            status: 'approved',
            reviewerUserId: actorUserId,
            reviewedAt: new Date(),
            reviewNote: body.note,
            updatedAt: new Date(),
        }).where(and(
            eq(outreachActionApprovals.id, approval.id),
            eq(outreachActionApprovals.organizationId, query.organizationId),
            eq(outreachActionApprovals.status, 'requested'),
        )).returning()
        if (!updated) return res.status(409).json({ error: 'Approval state changed concurrently' })
        await publishOutreachEvent({
            organizationId: query.organizationId,
            eventType: 'prospecting.enrichment_approved',
            aggregateType: 'prospecting_run',
            aggregateId: approval.resourceId,
            deduplicationKey: `prospecting.enrichment_approved:${approval.id}`,
            payload: { run_id: approval.resourceId, approval_id: approval.id, maximum_credit_cost: approval.maximumCreditCost },
        })
        res.json({ approval: updated, idempotentReplay: false })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        if (error instanceof Error && error.message === 'CAMPAIGN_STATE_CHANGED') {
            return res.status(409).json({ error: 'Campaign state changed concurrently' })
        }
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
        const [approval] = await db.update(outreachActionApprovals).set({
            status: 'rejected',
            reviewerUserId: actorUserId,
            reviewedAt: new Date(),
            reviewNote: body.reason,
            updatedAt: new Date(),
        }).where(and(
            eq(outreachActionApprovals.id, req.params.id),
            eq(outreachActionApprovals.organizationId, query.organizationId),
            inArray(outreachActionApprovals.status, ['requested', 'approved']),
        )).returning()
        if (!approval) return res.status(409).json({ error: 'Approval not found or no longer rejectable' })
        await publishOutreachEvent({
            organizationId: query.organizationId,
            eventType: 'action.rejected',
            aggregateType: approval.resourceType,
            aggregateId: approval.resourceId,
            deduplicationKey: `action.rejected:${approval.id}`,
            payload: { approval_id: approval.id, action_kind: approval.actionKind },
        })
        res.json({ approval })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error rejecting outreach action:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
