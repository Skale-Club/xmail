import { Router, type Response } from 'express'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { campaigns } from '../../db/schema'
import { requireScope, isUuid } from '../lib/agent-manage'
import { writeAgentAudit } from '../lib/agent-audit'
import { sendTelegram } from '../lib/telegram'
import { escapeHtml } from '../lib/html-escape'
import { publishOutreachEvent } from '../lib/xphere-events'
import {
    CampaignEnrollmentError,
    enrollCampaignLeads,
    isTerminalCampaignStatus,
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
 *   draft | active | paused   enroll now through the shared service (lib/campaign-enrollment.ts),
 *                             audited. On an active or paused campaign the owner gets an FYI message
 *                             on the outreach Telegram chat ("Hermes adicionou N leads"), not an
 *                             approval card: Vanildo decided on 2026-10-31 that feeding a running
 *                             campaign must not wait for a tap (three daily batches expired unapproved
 *                             and the campaign ran dry). The safety lives in the service: only verified
 *                             emails, no unsubscribed / suppressed / booking-platform addresses, only
 *                             campaign-eligible Icemail inboxes as senders, dedup per campaign.
 *   completed | archived      409.
 *
 * Activating a campaign (draft -> active) still goes through the approval card.
 *
 * There is no small batch cap: up to 1000 leads per call is only a bound on request size, the agent
 * calls again for more. The real daily ceiling is the number of sending inboxes times the per-inbox
 * daily limit; the delivery policy defers what does not fit to the next day.
 */

const LEFT_OUT_LABELS: Record<string, string> = {
    already_enrolled: 'já estavam na campanha',
    unsubscribed: 'descadastrados',
    suppressed: 'suprimidos',
    platform_email: 'e-mail de plataforma',
    email_not_verified: 'sem e-mail verificado',
    no_email: 'sem e-mail',
    invalid_email: 'e-mail inválido',
    not_found: 'não encontrados',
}

/** FYI on the outreach chat when Hermes feeds a running campaign. Best effort, never fails the call. */
async function notifyRunningCampaignFed(input: {
    campaignName: string
    campaignStatus: string
    added: number
    summary: EnrollmentSummary
    reason: string | null
}): Promise<void> {
    try {
        const lines: string[] = []
        lines.push(`Campanha: ${escapeHtml(input.campaignName)}${input.campaignStatus === 'paused' ? ' (pausada: recebem a sequência quando voltar)' : ''}`)
        if (input.summary.senders.length > 0) {
            lines.push('', 'Remetentes')
            for (const sender of input.summary.senders) lines.push(`• ${escapeHtml(sender.email)}: ${sender.count}`)
        }
        const leftOut = Object.entries(input.summary.leftOutByReason)
        if (leftOut.length > 0) {
            lines.push('', 'Ficaram de fora')
            for (const [reason, count] of leftOut) lines.push(`• ${count} ${escapeHtml(LEFT_OUT_LABELS[reason] ?? reason)}`)
        }
        if (input.reason) lines.push('', `Motivo do Hermes: ${escapeHtml(input.reason.slice(0, 300))}`)
        await sendTelegram(`<b>📥 Hermes adicionou ${input.added} lead(s) à campanha</b>`, lines.join('\n'), 'outreach')
    } catch (error) {
        console.error('[agent-campaign-enroll] could not post the FYI message:', error instanceof Error ? error.message : error)
    }
}

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

        if (campaign.status !== 'draft') await requireCampaignFirstStep(principal.organizationId, campaign.id)
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
            eventType: campaign.status === 'draft' ? 'campaign.draft_enrolled' : 'campaign.leads_enrolled',
            aggregateType: 'campaign',
            aggregateId: campaign.id,
            deduplicationKey: `campaign.enrolled:${campaign.id}:${createHash('sha256').update([...leadIds].sort().join(',')).digest('hex')}`,
            payload: { campaign_id: campaign.id, requested_count: leadIds.length, added_count: added },
        })
        if (campaign.status !== 'draft' && added > 0) {
            void notifyRunningCampaignFed({ campaignName: campaign.name, campaignStatus: campaign.status, added, summary, reason: input.reason ?? null })
        }
        return res.status(added > 0 ? 201 : 200).json({
            approvalRequired: false,
            campaignStatus: campaign.status,
            added,
            ...dryRunBody(plan, summary),
            activationRequired: campaign.status === 'draft',
            ...(campaign.status === 'paused' ? { note: 'The campaign is paused: the new leads start receiving the sequence when it is resumed.' } : {}),
        })
    } catch (error) {
        if (error instanceof CampaignEnrollmentError) return respondEnrollmentError(res, error)
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign enrollment failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
