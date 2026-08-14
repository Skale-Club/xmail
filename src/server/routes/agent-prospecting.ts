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
    prospectingRunEvents,
    type OutreachAgentScope,
    type ProspectImportedAs,
} from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import { recordCost } from '../lib/outreach-costs'
import { emptyAdvisory, loadAdvisory } from '../lib/prospecting/advisory'
import { createProspectProvider, MAX_APOLLO_CREDITS_PER_PERSON } from '../lib/prospecting/apollo'
import { buildEnrichmentCostDedupKey } from '../lib/prospecting/cost-dedup'
import { normalizeLeadEmail, resolveImportedAs } from '../lib/prospecting/email-normalization'
import { hypothesisSchema } from '../lib/prospecting/hypothesis'
import { recordRunEvent, recordRunEvents, RUN_EVENT_CODES, type RecordRunEventInput } from '../lib/prospecting/journey'
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

router.get('/runs', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'outreach:read')
        if (!principal) return
        const query = z.object({
            provider: z.enum(['apollo', 'xcraper']).optional(),
            externalRunId: z.string().trim().min(1).max(200).optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
        }).parse(req.query)
        const conditions = [eq(prospectingRuns.organizationId, principal.organizationId)]
        if (query.provider) conditions.push(eq(prospectingRuns.provider, query.provider))
        if (query.externalRunId) conditions.push(eq(prospectingRuns.idempotencyKey, query.externalRunId))
        const runs = await db.query.prospectingRuns.findMany({
            where: and(...conditions),
            orderBy: [desc(prospectingRuns.createdAt)],
            limit: query.limit,
            with: {
                events: { orderBy: (events, { asc }) => [asc(events.sequenceNumber)] },
                costEntries: { orderBy: (entries, { asc }) => [asc(entries.occurredAt)] },
            },
        })
        res.json({ runs })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent prospecting Journey list failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

const journeyNoteSchema = z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
    kind: z.enum(['observation', 'decision', 'lesson', 'next_action']),
    summary: z.string().trim().min(1).max(500),
    detail: z.record(z.unknown()).optional().default({}),
    level: z.enum(['info', 'warn']).optional().default('info'),
}).refine((value) => JSON.stringify(value.detail).length <= 4_096, {
    message: 'detail payload exceeds the 4096-byte cap',
})

router.post('/runs/:id/notes', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'prospects:write')
        if (!principal) return
        const input = journeyNoteSchema.parse(req.body)
        const run = await db.query.prospectingRuns.findFirst({
            where: and(
                eq(prospectingRuns.id, req.params.id),
                eq(prospectingRuns.organizationId, principal.organizationId),
            ),
            columns: { id: true },
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })

        const result = await db.transaction(async (tx) => {
            const lockKey = `${principal.organizationId}:${run.id}:${input.idempotencyKey}`
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`)
            const existing = await tx.query.prospectingRunEvents.findFirst({
                where: and(
                    eq(prospectingRunEvents.organizationId, principal.organizationId),
                    eq(prospectingRunEvents.runId, run.id),
                    eq(prospectingRunEvents.code, RUN_EVENT_CODES.assess.ORCHESTRATOR_NOTE),
                    sql`${prospectingRunEvents.detail}->>'idempotency_key' = ${input.idempotencyKey}`,
                ),
            })
            if (existing) return { event: existing, idempotentReplay: true }
            const [event] = await tx.insert(prospectingRunEvents).values({
                organizationId: principal.organizationId,
                runId: run.id,
                phase: 'assess',
                level: input.level,
                code: RUN_EVENT_CODES.assess.ORCHESTRATOR_NOTE,
                summary: input.summary,
                detail: {
                    ...input.detail,
                    note_kind: input.kind,
                    idempotency_key: input.idempotencyKey,
                    agent_credential_id: principal.credentialId,
                },
            }).returning()
            return { event, idempotentReplay: false }
        })
        if (result.idempotentReplay) return res.json(result)
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.prospecting.journey_note_appended',
            resourceType: 'prospecting_run',
            resourceId: run.id,
            metadata: { eventId: result.event.id, kind: input.kind, idempotencyKey: input.idempotencyKey },
        })
        res.status(201).json(result)
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent prospecting Journey note failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

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
    // Optional stated pre-run hypothesis (Phase 31, migration 051) — advisory only, never
    // read by the search/score/enrich/import flow. See prospecting/hypothesis.ts.
    hypothesis: hypothesisSchema.default({}),
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
        // Normalized here (not just relied upon from the provider) so prospect_candidates.email
        // stays consistent even if a future provider doesn't already lowercase — see
        // email-normalization.ts for why this matters for the downstream leads import.
        email: prospect.email ? normalizeLeadEmail(prospect.email) : prospect.email,
        emailStatus: prospect.emailStatus,
        score: result.score,
        scoreTier: result.tier,
        scoreBreakdown: result.breakdown,
        rawPayload: prospect.rawPayload,
    }
}

router.post('/searches', async (req, res) => {
    let runId: string | undefined
    let organizationId: string | undefined
    try {
        const principal = requireScope(req, res, 'prospects:search')
        if (!principal) return
        organizationId = principal.organizationId
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
            hypothesis: input.hypothesis,
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

        await recordRunEvent(db, {
            organizationId: principal.organizationId,
            runId: created.id,
            code: RUN_EVENT_CODES.search.QUERY_ISSUED,
            detail: { filters: input.filters, requestedLimit: input.limit },
        })

        const provider = createProspectProvider(input.provider)
        const search = await provider.search({ filters: input.filters, page: input.page, limit: input.limit })
        if (search.prospects.length === 0) {
            await recordRunEvent(db, {
                organizationId: principal.organizationId,
                runId: created.id,
                code: RUN_EVENT_CODES.search.ZERO_RESULTS,
                detail: { filters: input.filters, requestedLimit: input.limit },
            })
        }
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

            // Batch per-candidate scoring telemetry in the same tx/round-trip as the insert
            // above (constraint: no per-candidate DB round-trips). A candidate whose score
            // came from the "no criteria configured" baseline (see scoreProspect) is called
            // out once for the whole run instead of once per such candidate.
            const scoreEvents: RecordRunEventInput[] = []
            let sawNoCriteria = false
            for (const candidate of inserted) {
                const breakdown = candidate.scoreBreakdown as Record<string, unknown>
                if (breakdown?.reason === 'no_scoring_criteria') {
                    sawNoCriteria = true
                    continue
                }
                scoreEvents.push({
                    organizationId: principal.organizationId,
                    runId: created.id,
                    candidateId: candidate.id,
                    code: candidate.score >= input.qualificationThreshold
                        ? RUN_EVENT_CODES.score.CANDIDATE_QUALIFIED
                        : RUN_EVENT_CODES.score.CANDIDATE_BELOW_THRESHOLD,
                    detail: { score: candidate.score, tier: candidate.scoreTier, breakdown: candidate.scoreBreakdown },
                })
            }
            if (sawNoCriteria) {
                scoreEvents.push({
                    organizationId: principal.organizationId,
                    runId: created.id,
                    code: RUN_EVENT_CODES.score.NO_CRITERIA,
                })
            }
            await recordRunEvents(tx, scoreEvents)

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
        // Prior-run learning, folded directly into this response rather than a separate
        // "insights" endpoint the agent would have to remember to call. Advisory
        // computation must never break or delay the run itself: the run and its
        // candidates are already committed above, so a failure here only degrades this
        // additive field, never the run's own outcome.
        let advisory
        try {
            advisory = await loadAdvisory(db, {
                organizationId: principal.organizationId,
                searchFilters: input.filters,
                excludeRunId: created.id,
            })
        } catch (advisoryError) {
            console.error('Agent prospecting advisory failed:', advisoryError instanceof Error ? advisoryError.message : advisoryError)
            advisory = emptyAdvisory()
        }
        res.status(201).json({
            run: candidates.run,
            candidates: candidates.inserted,
            totalAvailable: search.totalAvailable,
            idempotentReplay: false,
            enrichmentRequiredForContactData: true,
            advisory,
        })
    } catch (error) {
        if (runId) {
            const message = (error instanceof Error ? error.message : 'Search failed').slice(0, 1_000)
            await db.update(prospectingRuns).set({
                status: 'failed',
                lastError: message,
                completedAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(prospectingRuns.id, runId)).catch(() => undefined)
            if (organizationId) {
                await recordRunEvent(db, {
                    organizationId,
                    runId,
                    code: RUN_EVENT_CODES.search.FAILED,
                    detail: { message },
                })
            }
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

        await recordRunEvent(db, {
            organizationId: principal.organizationId,
            runId: run.id,
            code: RUN_EVENT_CODES.enrich.REQUESTED,
            detail: { candidateCount: pending.length, maximumCreditEstimate },
        })

        try {
            // Phase 32 (migration 054) widened prospecting_runs.provider to also allow
            // 'xcraper', but createProspectProvider only ever implements Apollo — an
            // 'xcraper' run is registered directly as already 'imported' (see
            // routes/outreach/prospecting.ts's /external-runs) and so can never reach
            // 'discovered'/'ready' status to get here in practice. This guard narrows the
            // type for createProspectProvider and turns that invariant into an explicit
            // runtime check instead of a silent cast.
            if (run.provider !== 'apollo') {
                throw new Error(`Unsupported prospect provider for enrichment: ${run.provider}`)
            }
            const provider = createProspectProvider(run.provider)
            const result = await provider.enrich(pending.map((candidate) => candidate.externalPersonId))
            if (result.maximumCreditEstimate > approval.maximumCreditCost) {
                throw new Error('Provider credit estimate exceeded the human-approved ceiling')
            }
            const enrichedByExternalId = new Map(result.prospects.map((prospect) => [prospect.externalPersonId, prospect]))
            const criteria = run.scoringCriteria as ProspectScoringCriteria
            const updatedCandidates = await db.transaction(async (tx) => {
                const updated = []
                const noEmailEvents: RecordRunEventInput[] = []
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
                    if (enriched && (!enriched.email || ['unavailable', 'invalid'].includes(enriched.emailStatus))) {
                        noEmailEvents.push({
                            organizationId: principal.organizationId,
                            runId: run.id,
                            candidateId: enriched.id,
                            code: RUN_EVENT_CODES.enrich.NO_EMAIL,
                            detail: { email: enriched.email, emailStatus: enriched.emailStatus },
                        })
                    }
                }
                await recordRunEvents(tx, noEmailEvents)
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
                // Cost is recorded as the documented worst-case ceiling, not actual consumption:
                // Apollo's bulk_match endpoint does not return per-call credit usage, so
                // result.maximumCreditEstimate (externalPersonIds.length * MAX_APOLLO_CREDITS_PER_PERSON)
                // is the same upper-bound figure already surfaced in the response and used for the
                // ceiling check above. A future reconciliation job (once Apollo exposes actual usage,
                // e.g. via account/usage APIs) may post a correcting entry against this one.
                await recordCost(tx, {
                    organizationId: principal.organizationId,
                    // Phase 32 (migration 054): 'apollo_credits' was renamed to the
                    // provider-agnostic 'lead_source' — this call's `provider: 'apollo'`
                    // below already carries the vendor distinction.
                    category: 'lead_source',
                    basis: 'estimated',
                    quantity: result.maximumCreditEstimate,
                    unit: 'credit',
                    provider: 'apollo',
                    runId: run.id,
                    // Stable across retries: an outreach_action_approvals row is created for one
                    // immutable candidateIds set, and this branch only runs once per approval
                    // (idempotent replay short-circuits above once status becomes 'executed'), so
                    // (runId, approvalId) uniquely and stably identifies this enrichment call.
                    dedupKey: buildEnrichmentCostDedupKey(run.id, approval.id),
                })
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
            const message = (error instanceof Error ? error.message : 'Enrichment failed').slice(0, 1_000)
            await db.update(prospectingRuns).set({
                status: 'failed',
                lastError: message,
                completedAt: new Date(),
                updatedAt: new Date(),
            }).where(and(eq(prospectingRuns.id, run.id), eq(prospectingRuns.organizationId, principal.organizationId)))
            await db.update(outreachActionApprovals).set({
                status: 'failed',
                failureReason: message,
                updatedAt: new Date(),
            }).where(and(
                eq(outreachActionApprovals.id, approval.id),
                eq(outreachActionApprovals.organizationId, principal.organizationId),
                eq(outreachActionApprovals.status, 'executing'),
            ))
            await recordRunEvent(db, {
                organizationId: principal.organizationId,
                runId: run.id,
                code: RUN_EVENT_CODES.enrich.FAILED,
                detail: { message },
            })
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
        // Every write/lookup below must agree on the SAME normalized email or `importedAs`
        // resolution goes wrong (see email-normalization.ts). Compute it once per candidate
        // here and reuse it everywhere instead of re-deriving it at each call site.
        const normalizedEmailByCandidateId = new Map<string, string>()
        const eligibleByEmail = new Map(candidates.filter((candidate) => (
            candidate.email
            && acceptedStatuses.has(candidate.emailStatus)
            && candidate.score >= threshold
            && candidate.status !== 'imported'
        )).map((candidate) => {
            const normalizedEmail = normalizeLeadEmail(candidate.email!)
            normalizedEmailByCandidateId.set(candidate.id, normalizedEmail)
            return [normalizedEmail, candidate] as const
        }))
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
                email: normalizedEmailByCandidateId.get(candidate.id)!,
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
                    inArray(leads.email, eligible.map((candidate) => normalizedEmailByCandidateId.get(candidate.id)!)),
                ),
            })
            // Normalize the lookup key on both sides so a lead row written before this fix
            // (or by any other path) still matches correctly.
            const leadByEmail = new Map(resolved.map((lead) => [normalizeLeadEmail(lead.email), lead]))
            // A candidate's lead came from this call's own insert ('created') vs. matched an
            // already-existing lead row via onConflictDoNothing ('existing').
            const insertedEmails = new Set(inserted.map((lead) => normalizeLeadEmail(lead.email)))
            const importEvents: RecordRunEventInput[] = []
            for (const candidate of eligible) {
                const normalizedEmail = normalizedEmailByCandidateId.get(candidate.id)!
                const lead = leadByEmail.get(normalizedEmail)
                if (!lead) continue
                const importedAs: ProspectImportedAs = resolveImportedAs(normalizedEmail, insertedEmails)
                await tx.update(prospectCandidates).set({
                    status: 'imported',
                    leadId: lead.id,
                    importedAt: new Date(),
                    importedAs,
                    updatedAt: new Date(),
                }).where(and(eq(prospectCandidates.id, candidate.id), eq(prospectCandidates.organizationId, principal.organizationId)))
                importEvents.push({
                    organizationId: principal.organizationId,
                    runId: run.id,
                    candidateId: candidate.id,
                    code: importedAs === 'created' ? RUN_EVENT_CODES.import.LEAD_CREATED : RUN_EVENT_CODES.import.LEAD_EXISTING,
                    detail: { leadId: lead.id, importedAs },
                })
            }
            await recordRunEvents(tx, importEvents)
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
