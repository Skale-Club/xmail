import { Router, type Request, type Response } from 'express'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
    leadLists,
    leads,
    outreachActionApprovals,
    prospectAiAssessments,
    prospectCandidates,
    prospectingRuns,
    type OutreachAgentScope,
} from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import { createProspectProvider, MAX_APOLLO_CREDITS_PER_PERSON } from '../lib/prospecting/apollo'
import { scoreProspect } from '../lib/prospecting/scoring'
import { PROSPECT_SENIORITIES, type NormalizedProspect, type ProspectScoringCriteria } from '../lib/prospecting/types'
import { sqlTimestamp } from '../lib/sql-timestamp'
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

const boundedTextArray = z.array(z.string().trim().min(1).max(200)).max(25).optional()
const searchFiltersSchema = z.object({
    personTitles: boundedTextArray,
    includeSimilarTitles: z.boolean().optional(),
    keywords: z.string().trim().min(1).max(500).optional(),
    personLocations: boundedTextArray,
    seniorities: z.array(z.enum(PROSPECT_SENIORITIES)).max(PROSPECT_SENIORITIES.length).optional(),
    organizationLocations: boundedTextArray,
    organizationDomains: z.array(z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i)).max(25).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one search filter is required',
})

const scoringCriteriaSchema = z.object({
    targetTitles: boundedTextArray,
    targetSeniorities: z.array(z.enum(PROSPECT_SENIORITIES)).max(PROSPECT_SENIORITIES.length).optional(),
    targetIndustries: boundedTextArray,
    targetLocations: boundedTextArray,
    minEmployees: z.number().int().min(1).max(10_000_000).optional(),
    maxEmployees: z.number().int().min(1).max(10_000_000).optional(),
    requiredCompanyDomains: z.array(z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i)).max(25).optional(),
}).refine((value) => value.minEmployees === undefined || value.maxEmployees === undefined || value.minEmployees <= value.maxEmployees, {
    message: 'minEmployees cannot exceed maxEmployees',
})

const createSearchSchema = z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
    provider: z.literal('apollo').default('apollo'),
    filters: searchFiltersSchema,
    scoringCriteria: scoringCriteriaSchema.default({}),
    qualificationThreshold: z.number().int().min(0).max(100).default(60),
    page: z.number().int().min(1).max(500).default(1),
    limit: z.number().int().min(1).max(100).default(25),
})

const enrichSchema = z.object({
    approvalId: z.string().uuid(),
})

const enrichmentApprovalPayloadSchema = z.object({
    candidateIds: z.array(z.string().uuid()).min(1).max(10),
    provider: z.literal('apollo'),
})

const importSchema = z.object({
    candidateIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    leadListId: z.string().uuid().optional(),
    qualificationThreshold: z.number().int().min(0).max(100).optional(),
    acceptLikelyEmails: z.boolean().default(false),
})

function candidateValues(runId: string, organizationId: string, prospect: NormalizedProspect, criteria: ProspectScoringCriteria) {
    const result = scoreProspect(prospect, criteria)
    return {
        organizationId,
        runId,
        provider: 'apollo' as const,
        externalPersonId: prospect.externalPersonId,
        firstName: prospect.firstName,
        lastName: prospect.lastName,
        title: prospect.title,
        seniority: prospect.seniority,
        linkedinUrl: prospect.linkedinUrl,
        location: prospect.location,
        companyName: prospect.companyName,
        companyDomain: prospect.companyDomain,
        companyIndustry: prospect.companyIndustry,
        companyEmployeeCount: prospect.companyEmployeeCount,
        email: prospect.email,
        emailStatus: prospect.emailStatus,
        score: result.score,
        scoreTier: result.tier,
        scoreBreakdown: result.breakdown,
        rawPayload: prospect.rawPayload,
    }
}

router.post('/searches', async (req, res) => {
    let runId: string | undefined
    try {
        const principal = requireScope(req, res, 'prospects:search')
        if (!principal) return
        const input = createSearchSchema.parse(req.body)
        const [created] = await db.insert(prospectingRuns).values({
            organizationId: principal.organizationId,
            agentCredentialId: principal.credentialId,
            actorUserId: principal.principalUserId,
            provider: input.provider,
            idempotencyKey: input.idempotencyKey,
            status: 'searching',
            searchFilters: input.filters,
            scoringCriteria: input.scoringCriteria,
            qualificationThreshold: input.qualificationThreshold,
            requestedLimit: input.limit,
            providerPage: input.page,
            startedAt: new Date(),
        }).onConflictDoNothing({
            target: [prospectingRuns.organizationId, prospectingRuns.provider, prospectingRuns.idempotencyKey],
        }).returning()

        if (!created) {
            const replay = await db.query.prospectingRuns.findFirst({
                where: and(
                    eq(prospectingRuns.organizationId, principal.organizationId),
                    eq(prospectingRuns.provider, input.provider),
                    eq(prospectingRuns.idempotencyKey, input.idempotencyKey),
                ),
            })
            if (!replay) throw new Error('Idempotent search conflict could not be resolved')
            const candidates = await db.query.prospectCandidates.findMany({
                where: and(
                    eq(prospectCandidates.organizationId, principal.organizationId),
                    eq(prospectCandidates.runId, replay.id),
                ),
                orderBy: [desc(prospectCandidates.score)],
                limit: replay.requestedLimit,
            })
            return res.status(replay.status === 'searching' ? 202 : 200).json({
                run: replay,
                candidates,
                idempotentReplay: true,
            })
        }
        runId = created.id

        const provider = createProspectProvider(input.provider)
        const search = await provider.search({ filters: input.filters, page: input.page, limit: input.limit })
        const unique = [...new Map(search.prospects.map((prospect) => [prospect.externalPersonId, prospect])).values()]
        const values = unique.map((prospect) => candidateValues(created.id, principal.organizationId, prospect, input.scoringCriteria))
        const candidates = await db.transaction(async (tx) => {
            const inserted = values.length === 0 ? [] : await tx.insert(prospectCandidates).values(values)
                .onConflictDoNothing({
                    target: [prospectCandidates.runId, prospectCandidates.provider, prospectCandidates.externalPersonId],
                }).returning()
            const [run] = await tx.update(prospectingRuns).set({
                status: 'discovered',
                discoveredCount: inserted.length,
                completedAt: new Date(),
                updatedAt: new Date(),
            }).where(and(
                eq(prospectingRuns.id, created.id),
                eq(prospectingRuns.organizationId, principal.organizationId),
            )).returning()
            return { inserted, run }
        })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.prospecting.search.completed',
            resourceType: 'prospecting_run',
            resourceId: created.id,
            metadata: { provider: input.provider, discovered: candidates.inserted.length, requestedLimit: input.limit },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'prospecting.search_completed',
            aggregateType: 'prospecting_run',
            aggregateId: created.id,
            deduplicationKey: `prospecting.search_completed:${created.id}`,
            payload: { run_id: created.id, provider: input.provider, discovered_count: candidates.inserted.length },
        })
        res.status(201).json({
            run: candidates.run,
            candidates: candidates.inserted,
            totalAvailable: search.totalAvailable,
            idempotentReplay: false,
            enrichmentRequiredForContactData: true,
        })
    } catch (error) {
        if (runId) {
            await db.update(prospectingRuns).set({
                status: 'failed',
                lastError: (error instanceof Error ? error.message : 'Search failed').slice(0, 1_000),
                completedAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(prospectingRuns.id, runId)).catch(() => undefined)
        }
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        if (error instanceof Error && error.message === 'APOLLO_API_KEY is required') {
            return res.status(503).json({ error: 'Apollo prospecting is not configured' })
        }
        console.error('Agent prospect search failed:', error instanceof Error ? error.message : error)
        res.status(502).json({ error: 'Prospect provider request failed' })
    }
})

router.get('/searches/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'outreach:read')
        if (!principal) return
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, req.params.id), eq(prospectingRuns.organizationId, principal.organizationId)),
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })
        res.json({ run })
    } catch (error) {
        console.error('Agent prospecting run lookup failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/searches/:id/candidates', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'outreach:read')
        if (!principal) return
        const query = z.object({
            minimumScore: z.coerce.number().int().min(0).max(100).default(0),
            limit: z.coerce.number().int().min(1).max(100).default(50),
        }).parse(req.query)
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, req.params.id), eq(prospectingRuns.organizationId, principal.organizationId)),
            columns: { id: true },
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })
        const candidates = await db.query.prospectCandidates.findMany({
            where: and(
                eq(prospectCandidates.organizationId, principal.organizationId),
                eq(prospectCandidates.runId, run.id),
                sql`${prospectCandidates.score} >= ${query.minimumScore}`,
            ),
            orderBy: [desc(prospectCandidates.score), desc(prospectCandidates.createdAt)],
            limit: query.limit,
        })
        res.json({ candidates })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent prospect candidate list failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/searches/:id/enrich', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'prospects:enrich')
        if (!principal) return
        const input = enrichSchema.parse(req.body)
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, req.params.id), eq(prospectingRuns.organizationId, principal.organizationId)),
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })

        const approval = await db.query.outreachActionApprovals.findFirst({
            where: and(
                eq(outreachActionApprovals.id, input.approvalId),
                eq(outreachActionApprovals.organizationId, principal.organizationId),
                eq(outreachActionApprovals.requesterAgentCredentialId, principal.credentialId),
                eq(outreachActionApprovals.actionKind, 'prospect_enrichment'),
                eq(outreachActionApprovals.resourceId, run.id),
            ),
        })
        if (!approval) return res.status(404).json({ error: 'Enrichment approval not found' })
        const approvalPayload = enrichmentApprovalPayloadSchema.parse(approval.requestPayload)
        if (approval.status === 'executed') {
            const candidates = await db.query.prospectCandidates.findMany({
                where: and(
                    eq(prospectCandidates.organizationId, principal.organizationId),
                    eq(prospectCandidates.runId, run.id),
                    inArray(prospectCandidates.id, approvalPayload.candidateIds),
                ),
            })
            return res.json({ run, approval, candidates, idempotentReplay: true, maximumCreditEstimate: approval.maximumCreditCost })
        }
        if (approval.status !== 'approved') {
            return res.status(409).json({ error: `Enrichment approval is ${approval.status}; human approval is required` })
        }
        if (approval.expiresAt <= new Date()) {
            await db.update(outreachActionApprovals).set({ status: 'expired', updatedAt: new Date() })
                .where(and(eq(outreachActionApprovals.id, approval.id), eq(outreachActionApprovals.status, 'approved')))
            return res.status(410).json({ error: 'Enrichment approval expired' })
        }
        const maximumCreditEstimate = approvalPayload.candidateIds.length * MAX_APOLLO_CREDITS_PER_PERSON
        if (maximumCreditEstimate > approval.maximumCreditCost) {
            return res.status(422).json({ error: 'Approval credit ceiling does not cover this immutable candidate set' })
        }
        if (!['discovered', 'ready'].includes(run.status)) {
            return res.status(409).json({ error: `Run cannot be enriched from status ${run.status}` })
        }
        const candidates = await db.query.prospectCandidates.findMany({
            where: and(
                eq(prospectCandidates.organizationId, principal.organizationId),
                eq(prospectCandidates.runId, run.id),
                inArray(prospectCandidates.id, approvalPayload.candidateIds),
            ),
        })
        if (candidates.length !== new Set(approvalPayload.candidateIds).size) {
            return res.status(400).json({ error: 'One or more candidates do not belong to this prospecting run' })
        }
        const pending = candidates.filter((candidate) => !candidate.enrichedAt)
        if (pending.length === 0) {
            const [executedApproval] = await db.update(outreachActionApprovals).set({
                status: 'executed',
                executionStartedAt: new Date(),
                executedAt: new Date(),
                updatedAt: new Date(),
            }).where(and(
                eq(outreachActionApprovals.id, approval.id),
                eq(outreachActionApprovals.status, 'approved'),
            )).returning()
            return res.json({ run, approval: executedApproval ?? approval, candidates, idempotentReplay: true, maximumCreditEstimate: 0 })
        }

        try {
            await db.transaction(async (tx) => {
                const now = new Date()
                const [approvalClaim] = await tx.update(outreachActionApprovals).set({
                    status: 'executing',
                    executionStartedAt: now,
                    updatedAt: now,
                }).where(and(
                    eq(outreachActionApprovals.id, approval.id),
                    eq(outreachActionApprovals.organizationId, principal.organizationId),
                    eq(outreachActionApprovals.status, 'approved'),
                    sql`${outreachActionApprovals.expiresAt} > ${sqlTimestamp(now)}`,
                )).returning({ id: outreachActionApprovals.id })
                if (!approvalClaim) throw new Error('approval_claim_failed')
                const [runClaim] = await tx.update(prospectingRuns).set({
                    status: 'enriching',
                    approvedCreditCeiling: approval.maximumCreditCost,
                    enrichmentApprovalId: approval.id,
                    lastError: null,
                    updatedAt: now,
                }).where(and(
                    eq(prospectingRuns.id, run.id),
                    eq(prospectingRuns.organizationId, principal.organizationId),
                    inArray(prospectingRuns.status, ['discovered', 'ready']),
                )).returning({ id: prospectingRuns.id })
                if (!runClaim) throw new Error('run_claim_failed')
            })
        } catch (error) {
            if (error instanceof Error && ['approval_claim_failed', 'run_claim_failed'].includes(error.message)) {
                return res.status(409).json({ error: 'Approval or prospecting run is already being executed' })
            }
            throw error
        }

        try {
            const provider = createProspectProvider(run.provider)
            const result = await provider.enrich(pending.map((candidate) => candidate.externalPersonId))
            if (result.maximumCreditEstimate > approval.maximumCreditCost) {
                throw new Error('Provider credit estimate exceeded the human-approved ceiling')
            }
            const enrichedByExternalId = new Map(result.prospects.map((prospect) => [prospect.externalPersonId, prospect]))
            const criteria = run.scoringCriteria as ProspectScoringCriteria
            const updatedCandidates = await db.transaction(async (tx) => {
                const updated = []
                for (const candidate of pending) {
                    const prospect = enrichedByExternalId.get(candidate.externalPersonId)
                    if (!prospect) {
                        const [failed] = await tx.update(prospectCandidates).set({ status: 'failed', updatedAt: new Date() })
                            .where(and(eq(prospectCandidates.id, candidate.id), eq(prospectCandidates.organizationId, principal.organizationId)))
                            .returning()
                        updated.push(failed)
                        continue
                    }
                    const values = candidateValues(run.id, principal.organizationId, prospect, criteria)
                    const [enriched] = await tx.update(prospectCandidates).set({
                        ...values,
                        status: values.score >= run.qualificationThreshold ? 'qualified' : 'enriched',
                        enrichedAt: new Date(),
                        updatedAt: new Date(),
                    }).where(and(eq(prospectCandidates.id, candidate.id), eq(prospectCandidates.organizationId, principal.organizationId)))
                        .returning()
                    updated.push(enriched)
                }
                await tx.update(prospectingRuns).set({
                    status: 'ready',
                    enrichedCount: sql`${prospectingRuns.enrichedCount} + ${result.prospects.length}`,
                    consumedCreditEstimate: sql`${prospectingRuns.consumedCreditEstimate} + ${result.maximumCreditEstimate}`,
                    completedAt: new Date(),
                    updatedAt: new Date(),
                }).where(and(eq(prospectingRuns.id, run.id), eq(prospectingRuns.organizationId, principal.organizationId)))
                await tx.update(outreachActionApprovals).set({
                    status: 'executed',
                    executedAt: new Date(),
                    updatedAt: new Date(),
                }).where(and(
                    eq(outreachActionApprovals.id, approval.id),
                    eq(outreachActionApprovals.organizationId, principal.organizationId),
                    eq(outreachActionApprovals.status, 'executing'),
                ))
                return updated
            })
            await writeAgentAudit({
                principal,
                request: req,
                action: 'agent.prospecting.enriched',
                resourceType: 'prospecting_run',
                resourceId: run.id,
                metadata: { approvalId: approval.id, requested: pending.length, enriched: result.prospects.length, maximumCreditEstimate: result.maximumCreditEstimate },
            })
            await publishOutreachEvent({
                organizationId: principal.organizationId,
                eventType: 'prospecting.enriched',
                aggregateType: 'prospecting_run',
                aggregateId: run.id,
                deduplicationKey: `prospecting.enriched:${approval.id}`,
                payload: { run_id: run.id, approval_id: approval.id, enriched_count: result.prospects.length, maximum_credit_estimate: result.maximumCreditEstimate },
            })
            res.json({ candidates: updatedCandidates, idempotentReplay: false, maximumCreditEstimate: result.maximumCreditEstimate })
        } catch (error) {
            // A failed/ambiguous provider call is terminal for this run so a retry cannot silently double-spend credits.
            await db.update(prospectingRuns).set({
                status: 'failed',
                lastError: (error instanceof Error ? error.message : 'Enrichment failed').slice(0, 1_000),
                completedAt: new Date(),
                updatedAt: new Date(),
            }).where(and(eq(prospectingRuns.id, run.id), eq(prospectingRuns.organizationId, principal.organizationId)))
            await db.update(outreachActionApprovals).set({
                status: 'failed',
                failureReason: (error instanceof Error ? error.message : 'Enrichment failed').slice(0, 1_000),
                updatedAt: new Date(),
            }).where(and(
                eq(outreachActionApprovals.id, approval.id),
                eq(outreachActionApprovals.organizationId, principal.organizationId),
                eq(outreachActionApprovals.status, 'executing'),
            ))
            await writeAgentAudit({
                principal,
                request: req,
                action: 'agent.prospecting.enrichment_failed',
                outcome: 'failed',
                resourceType: 'prospecting_run',
                resourceId: run.id,
                metadata: {
                    attemptedCandidates: pending.length,
                    approvalId: approval.id,
                    maximumCreditEstimate: pending.length * MAX_APOLLO_CREDITS_PER_PERSON,
                    ambiguousProviderOutcome: true,
                },
            }).catch(() => undefined)
            throw error
        }
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        if (error instanceof Error && error.message === 'APOLLO_API_KEY is required') {
            return res.status(503).json({ error: 'Apollo prospecting is not configured' })
        }
        console.error('Agent prospect enrichment failed:', error instanceof Error ? error.message : error)
        res.status(502).json({ error: 'Prospect enrichment failed; the run was closed to prevent duplicate credit use' })
    }
})

router.post('/searches/:id/import', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'prospects:write')
        if (!principal) return
        const input = importSchema.parse(req.body)
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, req.params.id), eq(prospectingRuns.organizationId, principal.organizationId)),
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })
        if (input.leadListId) {
            const list = await db.query.leadLists.findFirst({
                where: and(eq(leadLists.id, input.leadListId), eq(leadLists.organizationId, principal.organizationId)),
                columns: { id: true },
            })
            if (!list) return res.status(400).json({ error: 'Lead list not found or access denied' })
        }
        const candidateWhere = [
            eq(prospectCandidates.organizationId, principal.organizationId),
            eq(prospectCandidates.runId, run.id),
        ]
        if (input.candidateIds) candidateWhere.push(inArray(prospectCandidates.id, input.candidateIds))
        const candidates = await db.query.prospectCandidates.findMany({
            where: and(...candidateWhere),
            orderBy: [desc(prospectCandidates.score)],
            limit: 100,
        })
        if (input.candidateIds && candidates.length !== new Set(input.candidateIds).size) {
            return res.status(400).json({ error: 'One or more candidates do not belong to this prospecting run' })
        }
        const threshold = input.qualificationThreshold ?? run.qualificationThreshold
        const acceptedStatuses = input.acceptLikelyEmails ? new Set(['verified', 'likely']) : new Set(['verified'])
        const eligibleByEmail = new Map(candidates.filter((candidate) => (
            candidate.email
            && acceptedStatuses.has(candidate.emailStatus)
            && candidate.score >= threshold
            && candidate.status !== 'imported'
        )).map((candidate) => [candidate.email!, candidate]))
        const eligible = [...eligibleByEmail.values()]
        if (eligible.length === 0) {
            return res.status(422).json({
                error: 'No candidates satisfy the score and verified-email import policy',
                qualificationThreshold: threshold,
                acceptLikelyEmails: input.acceptLikelyEmails,
            })
        }
        const assessments = await db.query.prospectAiAssessments.findMany({
            where: and(
                eq(prospectAiAssessments.organizationId, principal.organizationId),
                inArray(prospectAiAssessments.candidateId, eligible.map((candidate) => candidate.id)),
                eq(prospectAiAssessments.recommendation, 'qualified'),
            ),
            orderBy: [desc(prospectAiAssessments.createdAt)],
        })
        const latestAssessmentByCandidate = new Map<string, typeof assessments[number]>()
        for (const assessment of assessments) {
            if (!latestAssessmentByCandidate.has(assessment.candidateId)) {
                latestAssessmentByCandidate.set(assessment.candidateId, assessment)
            }
        }
        const result = await db.transaction(async (tx) => {
            const inserted = await tx.insert(leads).values(eligible.map((candidate) => ({
                organizationId: principal.organizationId,
                email: candidate.email!,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                companyName: candidate.companyName,
                companySize: candidate.companyEmployeeCount === null ? undefined : String(candidate.companyEmployeeCount),
                industry: candidate.companyIndustry,
                title: candidate.title,
                website: candidate.companyDomain ? `https://${candidate.companyDomain}` : undefined,
                linkedinUrl: candidate.linkedinUrl,
                location: candidate.location,
                source: run.provider,
                leadListId: input.leadListId,
                emailVerificationStatus: candidate.emailStatus,
                emailVerificationProvider: run.provider,
                emailVerifiedAt: candidate.enrichedAt,
                icpScore: candidate.score,
                icpTier: candidate.scoreTier,
                icpScoreBreakdown: candidate.scoreBreakdown,
                enrichedAt: candidate.enrichedAt,
                customFields: {
                    prospectingRunId: run.id,
                    externalPersonId: candidate.externalPersonId,
                    seniority: candidate.seniority,
                    aiAssessment: latestAssessmentByCandidate.has(candidate.id) ? {
                        id: latestAssessmentByCandidate.get(candidate.id)!.id,
                        confidence: latestAssessmentByCandidate.get(candidate.id)!.confidence,
                        personalization: latestAssessmentByCandidate.get(candidate.id)!.personalization,
                        evidenceFields: latestAssessmentByCandidate.get(candidate.id)!.evidenceFields,
                    } : null,
                },
            }))).onConflictDoNothing({ target: [leads.organizationId, leads.email] }).returning()
            const resolved = await tx.query.leads.findMany({
                where: and(
                    eq(leads.organizationId, principal.organizationId),
                    inArray(leads.email, eligible.map((candidate) => candidate.email!)),
                ),
            })
            const leadByEmail = new Map(resolved.map((lead) => [lead.email, lead]))
            for (const candidate of eligible) {
                const lead = leadByEmail.get(candidate.email!)
                if (!lead) continue
                await tx.update(prospectCandidates).set({
                    status: 'imported',
                    leadId: lead.id,
                    importedAt: new Date(),
                    updatedAt: new Date(),
                }).where(and(eq(prospectCandidates.id, candidate.id), eq(prospectCandidates.organizationId, principal.organizationId)))
            }
            if (input.leadListId && inserted.length > 0) {
                await tx.update(leadLists).set({
                    leadCount: sql`${leadLists.leadCount} + ${inserted.length}`,
                    updatedAt: new Date(),
                }).where(and(eq(leadLists.id, input.leadListId), eq(leadLists.organizationId, principal.organizationId)))
            }
            await tx.update(prospectingRuns).set({
                status: 'imported',
                importedCount: sql`(
                    SELECT count(*)::integer FROM ${prospectCandidates}
                    WHERE ${prospectCandidates.runId} = ${run.id}
                      AND ${prospectCandidates.organizationId} = ${principal.organizationId}
                      AND ${prospectCandidates.status} = 'imported'
                )`,
                completedAt: new Date(),
                updatedAt: new Date(),
            }).where(and(eq(prospectingRuns.id, run.id), eq(prospectingRuns.organizationId, principal.organizationId)))
            return { inserted, resolved }
        })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.prospecting.imported',
            resourceType: 'prospecting_run',
            resourceId: run.id,
            metadata: { eligible: eligible.length, created: result.inserted.length, resolved: result.resolved.length, threshold },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'prospecting.imported',
            aggregateType: 'prospecting_run',
            aggregateId: run.id,
            deduplicationKey: `prospecting.imported:${run.id}:${eligible.map((candidate) => candidate.id).sort().join(',')}`,
            payload: { run_id: run.id, created_count: result.inserted.length, resolved_count: result.resolved.length },
        })
        res.status(result.inserted.length > 0 ? 201 : 200).json({
            created: result.inserted.length,
            existing: result.resolved.length - result.inserted.length,
            leads: result.resolved,
        })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent prospect import failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
