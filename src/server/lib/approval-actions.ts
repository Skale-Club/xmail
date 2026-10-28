import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { campaigns, outreachActionApprovals, type OutreachActionApproval } from '../../db/schema'
import { publishOutreachEvent } from './xphere-events'
import { validateCampaignReadyForActivation } from '../routes/outreach/campaigns'
import {
    CampaignEnrollmentError,
    enrollCampaignLeads,
    summarizeEnrollmentPlan,
} from './campaign-enrollment'
import { jsonbParam } from './jsonb'

/**
 * Approve / reject an outreach action request. Shared by the admin panel
 * (routes/outreach/approvals.ts) and the Telegram buttons (lib/telegram-approvals.ts), so both
 * paths run the same readiness checks, the same state machine and emit the same events.
 * Callers have already established that `actorUserId` is an organization admin acting
 * interactively; nothing here re-checks identity.
 *
 * Results carry an HTTP-shaped status so the panel route can answer as it always did.
 */
export type ApprovalOutcome =
    | { ok: true; status: 200; body: Record<string, unknown> }
    | { ok: false; status: 404 | 409 | 410 | 422; body: { error: string; issues?: unknown } }

export async function approveOutreachAction(input: {
    approvalId: string
    organizationId: string
    actorUserId: string
    note?: string
}): Promise<ApprovalOutcome> {
    const { approvalId, organizationId, actorUserId, note } = input
    const approval = await db.query.outreachActionApprovals.findFirst({
        where: and(eq(outreachActionApprovals.id, approvalId), eq(outreachActionApprovals.organizationId, organizationId)),
    })
    if (!approval) return { ok: false, status: 404, body: { error: 'Approval request not found' } }
    if (approval.status === 'approved' || approval.status === 'executed') {
        return { ok: true, status: 200, body: { approval, idempotentReplay: true } }
    }
    if (approval.status !== 'requested') {
        return { ok: false, status: 409, body: { error: `Approval cannot be approved from status ${approval.status}` } }
    }
    if (approval.expiresAt <= new Date()) {
        await db.update(outreachActionApprovals).set({ status: 'expired', updatedAt: new Date() })
            .where(and(eq(outreachActionApprovals.id, approval.id), eq(outreachActionApprovals.status, 'requested')))
        return { ok: false, status: 410, body: { error: 'Approval request expired' } }
    }

    if (approval.actionKind === 'campaign_enrollment') {
        return executeCampaignEnrollment({ approval, organizationId, actorUserId, note })
    }

    if (approval.actionKind === 'campaign_activation') {
        const campaign = await db.query.campaigns.findFirst({
            where: and(eq(campaigns.id, approval.resourceId), eq(campaigns.organizationId, organizationId)),
        })
        if (!campaign) return { ok: false, status: 404, body: { error: 'Campaign not found' } }
        const issues = await validateCampaignReadyForActivation(campaign.id, organizationId)
        if (issues.length > 0) return { ok: false, status: 422, body: { error: 'Campaign is not ready to activate', issues } }
        const now = new Date()
        let result: { approval: unknown; campaign: unknown } | null
        try {
            result = await db.transaction(async (tx) => {
                const [updatedApproval] = await tx.update(outreachActionApprovals).set({
                    status: 'executed',
                    reviewerUserId: actorUserId,
                    reviewedAt: now,
                    reviewNote: note,
                    executionStartedAt: now,
                    executedAt: now,
                    updatedAt: now,
                }).where(and(
                    eq(outreachActionApprovals.id, approval.id),
                    eq(outreachActionApprovals.organizationId, organizationId),
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
                    eq(campaigns.organizationId, organizationId),
                    inArray(campaigns.status, ['draft', 'paused', 'active']),
                )).returning()
                if (!updatedCampaign) {
                    throw new Error('CAMPAIGN_STATE_CHANGED')
                }
                return { approval: updatedApproval, campaign: updatedCampaign }
            })
        } catch (error) {
            if (error instanceof Error && error.message === 'CAMPAIGN_STATE_CHANGED') {
                return { ok: false, status: 409, body: { error: 'Campaign state changed concurrently' } }
            }
            throw error
        }
        if (!result) return { ok: false, status: 409, body: { error: 'Approval state changed concurrently' } }
        await publishOutreachEvent({
            organizationId,
            eventType: 'campaign.activation_approved',
            aggregateType: 'campaign',
            aggregateId: campaign.id,
            deduplicationKey: `campaign.activation_approved:${approval.id}`,
            payload: { campaign_id: campaign.id, approval_id: approval.id, reviewer_user_id: actorUserId },
        })
        return { ok: true, status: 200, body: { ...result, idempotentReplay: false } }
    }

    const [updated] = await db.update(outreachActionApprovals).set({
        status: 'approved',
        reviewerUserId: actorUserId,
        reviewedAt: new Date(),
        reviewNote: note,
        updatedAt: new Date(),
    }).where(and(
        eq(outreachActionApprovals.id, approval.id),
        eq(outreachActionApprovals.organizationId, organizationId),
        eq(outreachActionApprovals.status, 'requested'),
    )).returning()
    if (!updated) return { ok: false, status: 409, body: { error: 'Approval state changed concurrently' } }
    await publishOutreachEvent({
        organizationId,
        eventType: 'prospecting.enrichment_approved',
        aggregateType: 'prospecting_run',
        aggregateId: approval.resourceId,
        deduplicationKey: `prospecting.enrichment_approved:${approval.id}`,
        payload: { run_id: approval.resourceId, approval_id: approval.id, maximum_credit_cost: approval.maximumCreditCost },
    })
    return { ok: true, status: 200, body: { approval: updated, idempotentReplay: false } }
}

// ---------------------------------------------------------------------------
// campaign_enrollment: add leads to an ACTIVE or PAUSED campaign, after the owner said yes
// ---------------------------------------------------------------------------

const enrollmentPayloadSchema = z.object({
    leadIds: z.array(z.string().uuid()).min(1).max(1000),
    emailAccountId: z.string().uuid().optional(),
})

class ApprovalStateChangedError extends Error {}

/**
 * What the owner approved is the request, not a promise about the world: leads may have unsubscribed,
 * been suppressed or been enrolled elsewhere since Hermes asked, and the campaign may have finished.
 * So execution re-plans against the CURRENT state inside the transaction that locks the campaign row
 * (`planInsideTransaction`), enrolls only what is still eligible, and writes the approval's
 * `executed` row in that same transaction: either the leads are on the campaign and the approval says
 * so, or neither happened. A campaign that can no longer take leads fails the approval with the reason.
 */
async function executeCampaignEnrollment(input: {
    approval: OutreachActionApproval
    organizationId: string
    actorUserId: string
    note?: string
}): Promise<ApprovalOutcome> {
    const { approval, organizationId, actorUserId, note } = input
    const payload = enrollmentPayloadSchema.safeParse(approval.requestPayload)
    if (!payload.success || !z.string().uuid().safeParse(approval.resourceId).success) {
        return failEnrollmentApproval(input, 422, 'Approval request is malformed (campaign or lead list missing)')
    }
    const now = new Date()
    let executedApproval: OutreachActionApproval | null = null
    let summary: ReturnType<typeof summarizeEnrollmentPlan>
    let added = 0
    try {
        const result = await enrollCampaignLeads({
            organizationId,
            campaignId: approval.resourceId,
            leadIds: payload.data.leadIds,
            policy: 'agent',
            senders: payload.data.emailAccountId
                ? { mode: 'explicit', emailAccountId: payload.data.emailAccountId }
                : { mode: 'auto' },
            planInsideTransaction: true,
            beforeCommit: async (tx, enrolled) => {
                const planSummary = summarizeEnrollmentPlan(enrolled.plan)
                const leftOut = payload.data.leadIds.length - enrolled.inserted.length
                const executionResult = {
                    added: enrolled.inserted.length,
                    leftOut,
                    leftOutByReason: planSummary.leftOutByReason,
                    senders: planSummary.senders,
                    executedAt: now.toISOString(),
                }
                const [row] = await tx.update(outreachActionApprovals).set({
                    status: 'executed',
                    reviewerUserId: actorUserId,
                    reviewedAt: now,
                    reviewNote: note,
                    executionStartedAt: now,
                    executedAt: now,
                    requestPayload: sql`${outreachActionApprovals.requestPayload} || ${jsonbParam({ executionResult })}`,
                    updatedAt: now,
                }).where(and(
                    eq(outreachActionApprovals.id, approval.id),
                    eq(outreachActionApprovals.organizationId, organizationId),
                    eq(outreachActionApprovals.status, 'requested'),
                )).returning()
                if (!row) throw new ApprovalStateChangedError()
                executedApproval = row
            },
        })
        added = result.inserted.length
        summary = summarizeEnrollmentPlan(result.plan)
    } catch (error) {
        if (error instanceof ApprovalStateChangedError) {
            return { ok: false, status: 409, body: { error: 'Approval state changed concurrently' } }
        }
        if (error instanceof CampaignEnrollmentError) {
            return failEnrollmentApproval(input, error.status === 400 ? 422 : error.status, error.message)
        }
        throw error
    }

    const leftOut = payload.data.leadIds.length - added
    await publishOutreachEvent({
        organizationId,
        eventType: 'campaign.enrollment_approved',
        aggregateType: 'campaign',
        aggregateId: approval.resourceId,
        deduplicationKey: `campaign.enrollment_approved:${approval.id}`,
        payload: {
            campaign_id: approval.resourceId,
            approval_id: approval.id,
            reviewer_user_id: actorUserId,
            added_count: added,
            left_out_count: leftOut,
        },
    })
    return {
        ok: true,
        status: 200,
        body: {
            approval: executedApproval,
            result: { added, leftOut, leftOutByReason: summary.leftOutByReason, senders: summary.senders },
            idempotentReplay: false,
        },
    }
}

async function failEnrollmentApproval(
    input: { approval: OutreachActionApproval; organizationId: string; actorUserId: string; note?: string },
    status: 404 | 409 | 422,
    reason: string,
): Promise<ApprovalOutcome> {
    const now = new Date()
    await db.update(outreachActionApprovals).set({
        status: 'failed',
        reviewerUserId: input.actorUserId,
        reviewedAt: now,
        reviewNote: input.note,
        executionStartedAt: now,
        failureReason: reason,
        updatedAt: now,
    }).where(and(
        eq(outreachActionApprovals.id, input.approval.id),
        eq(outreachActionApprovals.organizationId, input.organizationId),
        eq(outreachActionApprovals.status, 'requested'),
    ))
    return { ok: false, status, body: { error: reason } }
}

export async function rejectOutreachAction(input: {
    approvalId: string
    organizationId: string
    actorUserId: string
    reason: string
}): Promise<ApprovalOutcome> {
    const { approvalId, organizationId, actorUserId, reason } = input
    const [approval] = await db.update(outreachActionApprovals).set({
        status: 'rejected',
        reviewerUserId: actorUserId,
        reviewedAt: new Date(),
        reviewNote: reason,
        updatedAt: new Date(),
    }).where(and(
        eq(outreachActionApprovals.id, approvalId),
        eq(outreachActionApprovals.organizationId, organizationId),
        inArray(outreachActionApprovals.status, ['requested', 'approved']),
    )).returning()
    if (!approval) return { ok: false, status: 409, body: { error: 'Approval not found or no longer rejectable' } }
    await publishOutreachEvent({
        organizationId,
        eventType: 'action.rejected',
        aggregateType: approval.resourceType,
        aggregateId: approval.resourceId,
        deduplicationKey: `action.rejected:${approval.id}`,
        payload: { approval_id: approval.id, action_kind: approval.actionKind },
    })
    return { ok: true, status: 200, body: { approval } }
}
