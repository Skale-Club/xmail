import { Router, type Request, type Response } from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { prospectAiAssessments, prospectCandidates, type OutreachAgentScope } from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import { recordCost } from '../lib/outreach-costs'
import { hashProspectAssessmentInput, prospectAssessmentInputSchema } from '../lib/prospecting/assessment'
import { buildAssessmentCostDedupKey } from '../lib/prospecting/cost-dedup'
import { recordRunEvents, RUN_EVENT_CODES, type RecordRunEventInput } from '../lib/prospecting/journey'
import { publishOutreachEvent } from '../lib/xphere-events'

const router = Router()

function requireScope(req: Request, res: Response, scope: OutreachAgentScope): AgentPrincipal | null {
    const principal = getAgentPrincipal(req)
    if (!principal) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    if (!agentHasScope(principal, scope)) {
        void writeAgentAudit({ principal, request: req, action: 'agent.scope.denied', outcome: 'denied', metadata: { requiredScope: scope } })
            .catch(() => undefined)
        res.status(403).json({ error: `Missing required scope: ${scope}` })
        return null
    }
    return principal
}

router.post('/prospecting/candidates/:id/assessments', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'prospects:assess')
        if (!principal) return
        const input = prospectAssessmentInputSchema.parse(req.body)
        const candidate = await db.query.prospectCandidates.findFirst({
            where: and(eq(prospectCandidates.id, req.params.id), eq(prospectCandidates.organizationId, principal.organizationId)),
        })
        if (!candidate) return res.status(404).json({ error: 'Prospect candidate not found' })
        const candidateInputHash = hashProspectAssessmentInput(candidate)
        const [created] = await db.insert(prospectAiAssessments).values({
            organizationId: principal.organizationId,
            candidateId: candidate.id,
            agentCredentialId: principal.credentialId,
            idempotencyKey: input.idempotencyKey,
            modelProvider: input.modelProvider,
            modelName: input.modelName,
            candidateInputHash,
            recommendation: input.recommendation,
            confidence: input.confidence,
            rationale: input.rationale,
            personalization: input.personalization,
            evidenceFields: input.evidenceFields,
            riskFlags: input.riskFlags,
            promptTokens: input.promptTokens ?? null,
            completionTokens: input.completionTokens ?? null,
        }).onConflictDoNothing({
            target: [
                prospectAiAssessments.organizationId,
                prospectAiAssessments.agentCredentialId,
                prospectAiAssessments.candidateId,
                prospectAiAssessments.idempotencyKey,
            ],
        }).returning()
        const assessment = created ?? await db.query.prospectAiAssessments.findFirst({
            where: and(
                eq(prospectAiAssessments.organizationId, principal.organizationId),
                eq(prospectAiAssessments.agentCredentialId, principal.credentialId),
                eq(prospectAiAssessments.candidateId, candidate.id),
                eq(prospectAiAssessments.idempotencyKey, input.idempotencyKey),
            ),
        })
        if (!assessment) throw new Error('Idempotent assessment conflict could not be resolved')

        const assessEvents: RecordRunEventInput[] = [{
            organizationId: principal.organizationId,
            runId: candidate.runId,
            candidateId: candidate.id,
            code: RUN_EVENT_CODES.assess.RECORDED,
            detail: { assessmentId: assessment.id, recommendation: assessment.recommendation, confidence: assessment.confidence },
        }]
        if (assessment.recommendation === 'rejected') {
            assessEvents.push({
                organizationId: principal.organizationId,
                runId: candidate.runId,
                candidateId: candidate.id,
                code: RUN_EVENT_CODES.assess.REJECTED,
                detail: { assessmentId: assessment.id },
            })
        }
        await recordRunEvents(db, assessEvents)

        // Read the persisted token counts (not `input`) so a replay of an idempotent
        // request bills the same figure the original call recorded, rather than whatever
        // the replaying caller happened to pass this time.
        if (assessment.promptTokens !== null && assessment.completionTokens !== null) {
            await recordCost(db, {
                organizationId: principal.organizationId,
                category: 'llm_tokens',
                basis: 'actual',
                quantity: assessment.promptTokens + assessment.completionTokens,
                unit: 'token',
                provider: assessment.modelProvider,
                model: assessment.modelName,
                assessmentId: assessment.id,
                // Stable across retries: an assessment row is itself already idempotent per
                // (organizationId, agentCredentialId, candidateId, idempotencyKey), so its id
                // uniquely identifies this logical assessment operation.
                dedupKey: buildAssessmentCostDedupKey(assessment.id),
            })
        }

        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.prospect.assessed',
            resourceType: 'prospect_candidate',
            resourceId: candidate.id,
            metadata: { assessmentId: assessment.id, recommendation: assessment.recommendation, confidence: assessment.confidence, idempotentReplay: !created },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'prospecting.candidate_assessed',
            aggregateType: 'prospect_candidate',
            aggregateId: candidate.id,
            deduplicationKey: `prospecting.candidate_assessed:${assessment.id}`,
            payload: { candidate_id: candidate.id, assessment_id: assessment.id, recommendation: assessment.recommendation, confidence: assessment.confidence },
        })
        res.status(created ? 201 : 200).json({ assessment, idempotentReplay: !created, advisoryOnly: true })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent prospect assessment failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/prospecting/candidates/:id/assessments', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'outreach:read')
        if (!principal) return
        const candidate = await db.query.prospectCandidates.findFirst({
            where: and(eq(prospectCandidates.id, req.params.id), eq(prospectCandidates.organizationId, principal.organizationId)),
            columns: { id: true },
        })
        if (!candidate) return res.status(404).json({ error: 'Prospect candidate not found' })
        const assessments = await db.query.prospectAiAssessments.findMany({
            where: and(eq(prospectAiAssessments.organizationId, principal.organizationId), eq(prospectAiAssessments.candidateId, candidate.id)),
            orderBy: [desc(prospectAiAssessments.createdAt)],
            limit: 20,
        })
        res.json({ assessments })
    } catch (error) {
        console.error('Agent prospect assessment list failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
