import { Router, type Request, type Response } from 'express'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
    campaigns,
    outreachActionApprovals,
    prospectCandidates,
    prospectingRuns,
    type OutreachAgentScope,
} from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import { MAX_APOLLO_CREDITS_PER_PERSON } from '../lib/prospecting/apollo'
import { publishOutreachEvent } from '../lib/xphere-events'

const router = Router()

function requireScope(req: Request, res: Response, scope: OutreachAgentScope): AgentPrincipal | null {
    const principal = getAgentPrincipal(req)
    if (!principal) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    if (!agentHasScope(principal, scope)) {
        void writeAgentAudit({
            principal,
            request: req,
            action: 'agent.scope.denied',
            outcome: 'denied',
            metadata: { requiredScope: scope },
        }).catch(() => undefined)
        res.status(403).json({ error: `Missing required scope: ${scope}` })
        return null
    }
    return principal
}

async function findOrCreateApproval(input: {
    principal: AgentPrincipal
    actionKind: 'prospect_enrichment' | 'campaign_activation'
    resourceType: string
    resourceId: string
    idempotencyKey: string
    requestPayload: Record<string, unknown>
    maximumCreditCost?: number
}) {
    const [created] = await db.insert(outreachActionApprovals).values({
        organizationId: input.principal.organizationId,
        requesterAgentCredentialId: input.principal.credentialId,
        requesterUserId: input.principal.principalUserId,
        actionKind: input.actionKind,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        idempotencyKey: input.idempotencyKey,
        requestPayload: input.requestPayload,
        maximumCreditCost: input.maximumCreditCost ?? 0,
    }).onConflictDoNothing({
        target: [
            outreachActionApprovals.organizationId,
            outreachActionApprovals.requesterAgentCredentialId,
            outreachActionApprovals.actionKind,
            outreachActionApprovals.idempotencyKey,
        ],
    }).returning()
    if (created) return { approval: created, idempotentReplay: false }
    const existing = await db.query.outreachActionApprovals.findFirst({
        where: and(
            eq(outreachActionApprovals.organizationId, input.principal.organizationId),
            eq(outreachActionApprovals.requesterAgentCredentialId, input.principal.credentialId),
            eq(outreachActionApprovals.actionKind, input.actionKind),
            eq(outreachActionApprovals.idempotencyKey, input.idempotencyKey),
        ),
    })
    if (!existing) throw new Error('Idempotent approval conflict could not be resolved')
    return { approval: existing, idempotentReplay: true }
}

router.post('/approvals/prospect-enrichment', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'prospects:enrich')
        if (!principal) return
        const input = z.object({
            idempotencyKey: z.string().trim().min(8).max(200),
            runId: z.string().uuid(),
            candidateIds: z.array(z.string().uuid()).min(1).max(10),
        }).parse(req.body)
        const candidateIds = [...new Set(input.candidateIds)].sort()
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, input.runId), eq(prospectingRuns.organizationId, principal.organizationId)),
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })
        if (!['discovered', 'ready'].includes(run.status)) {
            return res.status(409).json({ error: `Run cannot request enrichment from status ${run.status}` })
        }
        const candidates = await db.query.prospectCandidates.findMany({
            where: and(
                eq(prospectCandidates.organizationId, principal.organizationId),
                eq(prospectCandidates.runId, run.id),
                inArray(prospectCandidates.id, candidateIds),
            ),
            columns: { id: true, enrichedAt: true },
        })
        if (candidates.length !== candidateIds.length) {
            return res.status(400).json({ error: 'One or more candidates do not belong to this prospecting run' })
        }
        if (candidates.some((candidate) => candidate.enrichedAt)) {
            return res.status(409).json({ error: 'Already-enriched candidates cannot be included in a new paid approval' })
        }
        const maximumCreditCost = candidateIds.length * MAX_APOLLO_CREDITS_PER_PERSON
        const result = await findOrCreateApproval({
            principal,
            actionKind: 'prospect_enrichment',
            resourceType: 'prospecting_run',
            resourceId: run.id,
            idempotencyKey: input.idempotencyKey,
            requestPayload: { candidateIds, provider: run.provider },
            maximumCreditCost,
        })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.approval.requested',
            resourceType: 'outreach_action_approval',
            resourceId: result.approval.id,
            metadata: { actionKind: 'prospect_enrichment', maximumCreditCost, idempotentReplay: result.idempotentReplay },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'action.approval_requested',
            aggregateType: 'prospecting_run',
            aggregateId: run.id,
            deduplicationKey: `action.approval_requested:${result.approval.id}`,
            payload: { approval_id: result.approval.id, action_kind: 'prospect_enrichment', maximum_credit_cost: maximumCreditCost },
        })
        res.status(result.idempotentReplay ? 200 : 201).json(result)
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent enrichment approval request failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/campaigns/:id/activation-requests', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:request_activation')
        if (!principal) return
        const input = z.object({ idempotencyKey: z.string().trim().min(8).max(200) }).parse(req.body)
        const campaign = await db.query.campaigns.findFirst({
            where: and(eq(campaigns.id, req.params.id), eq(campaigns.organizationId, principal.organizationId)),
        })
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
        if (!['draft', 'paused'].includes(campaign.status)) {
            return res.status(409).json({ error: `Campaign cannot request activation from status ${campaign.status}` })
        }
        const result = await findOrCreateApproval({
            principal,
            actionKind: 'campaign_activation',
            resourceType: 'campaign',
            resourceId: campaign.id,
            idempotencyKey: input.idempotencyKey,
            requestPayload: { campaignId: campaign.id, campaignName: campaign.name, currentStatus: campaign.status },
        })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.approval.requested',
            resourceType: 'outreach_action_approval',
            resourceId: result.approval.id,
            metadata: { actionKind: 'campaign_activation', campaignId: campaign.id, idempotentReplay: result.idempotentReplay },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'action.approval_requested',
            aggregateType: 'campaign',
            aggregateId: campaign.id,
            deduplicationKey: `action.approval_requested:${result.approval.id}`,
            payload: { approval_id: result.approval.id, action_kind: 'campaign_activation', campaign_id: campaign.id },
        })
        res.status(result.idempotentReplay ? 200 : 201).json(result)
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign activation request failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/approvals/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'approvals:read')
        if (!principal) return
        const approval = await db.query.outreachActionApprovals.findFirst({
            where: and(
                eq(outreachActionApprovals.id, req.params.id),
                eq(outreachActionApprovals.organizationId, principal.organizationId),
                eq(outreachActionApprovals.requesterAgentCredentialId, principal.credentialId),
            ),
        })
        if (!approval) return res.status(404).json({ error: 'Approval request not found' })
        res.json({ approval })
    } catch (error) {
        console.error('Agent approval lookup failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
