import { Router, type Request, type Response } from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { prospectAiAssessments, prospectCandidates, type OutreachAgentScope } from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import { hashProspectAssessmentInput, prospectAssessmentInputSchema } from '../lib/prospecting/assessment'
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
