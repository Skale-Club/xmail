import { Router, type Response } from 'express'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { campaigns, outreachActionApprovals } from '../../db/schema'
import { requireScope, isUuid } from '../lib/agent-manage'
import { writeAgentAudit } from '../lib/agent-audit'
import { findOrCreateApproval } from '../lib/agent-approval-request'
import { publishOutreachEvent } from '../lib/xphere-events'
import {
    CampaignEnrollmentError,
    enrollCampaignLeads,
    isTerminalCampaignStatus,
    planCampaignEnrollment,
    requireCampaignFirstStep,
    summarizeEnrollmentPlan,
    type EnrollmentPlan,
    type EnrollmentSummary,
    type SenderSelection,
} from '../lib/campaign-enrollment'

/**
 * Hermes feeds a campaign.
 *
 *   POST /campaigns/:id/enroll      scope campaigns:draft (the scope enroll-draft already uses)
 *
 *   draft            enroll now through the shared service (lib/campaign-enrollment.ts), audited.
 *   active | paused  enroll NOTHING. Dry-run with the same service and file a `campaign_enrollment`
 *                    approval request; the leads enter only after the owner approves the Telegram
 *                    card (or the panel). Adding recipients to a running campaign starts real email,
 *                    and the agent reads untrusted prospect replies, so a self-confirmed flag is not
 *                    an approval and there is none to pass.
 *   completed | archived   409.
 *
 * There is no small batch cap: up to 1000 leads per call is only a bound on request size, the agent
 * calls again for more. The real daily ceiling is the number of sending inboxes times the per-inbox
 * daily limit; the delivery policy defers what does not fit to the next day.
 */

const router = Router()

export const ENROLL_MAX_LEADS_PER_CALL = 1000

const enrollSchema = z.object({
    leadIds: z.array(z.string().uuid()).min(1).max(ENROLL_MAX_LEADS_PER_CALL),
    emailAccountId: z.string().uuid().optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    reason: z.string().trim().max(500).optional(),
}).strict()

function sendersFor(emailAccountId: string | undefined): SenderSelection {
    return emailAccountId ? { mode: 'explicit', emailAccountId } : { mode: 'auto' }
}

function dryRunBody(plan: EnrollmentPlan, summary: EnrollmentSummary) {
    return {
        ...summary,
        ineligibleLeads: plan.ineligible,
    }
}

function respondEnrollmentError(res: Response, error: CampaignEnrollmentError) {
    const body: Record<string, unknown> = { error: error.message, code: error.code }
    return res.status(error.status).json(body)
}

router.post('/campaigns/:id/enroll', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:draft')
        if (!principal) return
        if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Campaign not found' })
        const input = enrollSchema.parse(req.body)
        const leadIds = [...new Set(input.leadIds)]

        const campaign = await db.query.campaigns.findFirst({
            where: and(eq(campaigns.id, req.params.id), eq(campaigns.organizationId, principal.organizationId)),
        })
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
        if (isTerminalCampaignStatus(campaign.status)) {
            return res.status(409).json({
                error: `Cannot enroll leads into a ${campaign.status} campaign`,
                code: 'campaign_enrollment_closed',
            })
        }

        const enrollment = {
            organizationId: principal.organizationId,
            campaignId: campaign.id,
            leadIds,
            senders: sendersFor(input.emailAccountId),
            policy: 'agent' as const,
        }

        if (campaign.status === 'draft') {
            const { plan, inserted } = await enrollCampaignLeads({ ...enrollment, planInsideTransaction: true })
            const summary = summarizeEnrollmentPlan(plan)
            const added = inserted.length
            await writeAgentAudit({
                principal,
                request: req,
                action: 'agent.campaign.enrolled',
                resourceType: 'campaign',
                resourceId: campaign.id,
                metadata: {
                    campaignStatus: campaign.status,
                    requested: leadIds.length,
                    added,
                    alreadyEnrolled: summary.alreadyEnrolled,
                    leftOutByReason: summary.leftOutByReason,
                    senders: summary.senders,
                    idempotencyKey: input.idempotencyKey,
                    reason: input.reason ?? null,
                },
            })
            await publishOutreachEvent({
                organizationId: principal.organizationId,
                eventType: 'campaign.draft_enrolled',
                aggregateType: 'campaign',
                aggregateId: campaign.id,
                deduplicationKey: `campaign.draft_enrolled:${campaign.id}:${createHash('sha256').update([...leadIds].sort().join(',')).digest('hex')}`,
                payload: { campaign_id: campaign.id, requested_count: leadIds.length, added_count: added },
            })
            return res.status(added > 0 ? 201 : 200).json({
                approvalRequired: false,
                campaignStatus: campaign.status,
                added,
                ...dryRunBody(plan, summary),
                activationRequired: true,
            })
        }

        // active | paused: never enroll here. Replay first, so a retry returns the same request even
        // after the leads it asked for are already on the campaign.
        const existing = await db.query.outreachActionApprovals.findFirst({
            where: and(
                eq(outreachActionApprovals.organizationId, principal.organizationId),
                eq(outreachActionApprovals.requesterAgentCredentialId, principal.credentialId),
                eq(outreachActionApprovals.actionKind, 'campaign_enrollment'),
                eq(outreachActionApprovals.idempotencyKey, input.idempotencyKey),
            ),
        })
        if (existing) {
            if (existing.resourceId !== campaign.id) {
                return res.status(409).json({
                    error: 'This idempotencyKey was already used for a different campaign',
                    code: 'idempotency_key_reused',
                })
            }
            const pending = existing.status === 'requested'
            return res.status(pending ? 202 : 200).json({
                approvalRequired: pending,
                approvalId: existing.id,
                approvalStatus: existing.status,
                idempotentReplay: true,
                dryRun: (existing.requestPayload as { dryRun?: unknown }).dryRun ?? null,
            })
        }

        await requireCampaignFirstStep(principal.organizationId, campaign.id)
        const plan = await planCampaignEnrollment(db, enrollment)
        const summary = summarizeEnrollmentPlan(plan)
        if (plan.toAdd.length === 0) {
            return res.status(200).json({
                approvalRequired: false,
                campaignStatus: campaign.status,
                added: 0,
                dryRun: dryRunBody(plan, summary),
                note: 'Nothing to add: every lead is already on the campaign or not eligible. No approval was requested.',
            })
        }

        const result = await findOrCreateApproval({
            principal,
            actionKind: 'campaign_enrollment',
            resourceType: 'campaign',
            resourceId: campaign.id,
            idempotencyKey: input.idempotencyKey,
            requestPayload: {
                campaignId: campaign.id,
                campaignName: campaign.name,
                campaignStatus: campaign.status,
                leadIds: plan.toAdd.map((lead) => lead.leadId),
                ...(input.emailAccountId ? { emailAccountId: input.emailAccountId } : {}),
                reason: input.reason ?? null,
                dryRun: summary,
            },
        })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.approval.requested',
            resourceType: 'outreach_action_approval',
            resourceId: result.approval.id,
            metadata: {
                actionKind: 'campaign_enrollment',
                campaignId: campaign.id,
                campaignStatus: campaign.status,
                willAdd: summary.willAdd,
                leftOutByReason: summary.leftOutByReason,
                reason: input.reason ?? null,
                idempotentReplay: result.idempotentReplay,
            },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'action.approval_requested',
            aggregateType: 'campaign',
            aggregateId: campaign.id,
            deduplicationKey: `action.approval_requested:${result.approval.id}`,
            payload: {
                approval_id: result.approval.id,
                action_kind: 'campaign_enrollment',
                campaign_id: campaign.id,
                lead_count: summary.willAdd,
            },
        })
        res.status(202).json({
            approvalRequired: true,
            approvalId: result.approval.id,
            approvalStatus: result.approval.status,
            idempotentReplay: result.idempotentReplay,
            dryRun: dryRunBody(plan, summary),
            note: 'The leads enter the campaign only after the owner approves the Telegram card. Nothing was enrolled.',
        })
    } catch (error) {
        if (error instanceof CampaignEnrollmentError) return respondEnrollmentError(res, error)
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign enrollment failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
