import { Router } from 'express'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import { prospectAiAssessments, prospectCandidates, prospectingRuns } from '../../../db/schema'
import { requireOutreachRead, requireOutreachWrite } from '../../lib/outreach-access'
import { recordCost } from '../../lib/outreach-costs'
import { jsonbParam } from '../../lib/jsonb'
import { externalRunSchema } from '../../lib/prospecting/external-run'
import { recordRunEvent, RUN_EVENT_CODES } from '../../lib/prospecting/journey'

const router = Router()

router.get('/runs', async (req, res) => {
    try {
        const query = z.object({
            organizationId: z.string().uuid(),
            status: z.enum(['pending', 'searching', 'discovered', 'enriching', 'ready', 'imported', 'failed']).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
        }).parse(req.query)
        if (!await requireOutreachRead(req, res, query.organizationId)) return
        const where = query.status
            ? and(eq(prospectingRuns.organizationId, query.organizationId), eq(prospectingRuns.status, query.status))
            : eq(prospectingRuns.organizationId, query.organizationId)
        const runs = await db.query.prospectingRuns.findMany({
            where,
            orderBy: [desc(prospectingRuns.createdAt)],
            limit: query.limit,
        })
        res.json({ runs })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error listing prospecting runs:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/runs/:id/candidates', async (req, res) => {
    try {
        const query = z.object({ organizationId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(req.query)
        if (!await requireOutreachRead(req, res, query.organizationId)) return
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, req.params.id), eq(prospectingRuns.organizationId, query.organizationId)),
            columns: { id: true },
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })
        const candidates = await db.query.prospectCandidates.findMany({
            where: and(eq(prospectCandidates.organizationId, query.organizationId), eq(prospectCandidates.runId, run.id)),
            orderBy: [desc(prospectCandidates.score), desc(prospectCandidates.createdAt)],
            limit: query.limit,
        })
        const candidateIds = candidates.map((candidate) => candidate.id)
        const assessments = candidateIds.length === 0 ? [] : await db.query.prospectAiAssessments.findMany({
            where: and(
                eq(prospectAiAssessments.organizationId, query.organizationId),
                inArray(prospectAiAssessments.candidateId, candidateIds),
            ),
            orderBy: [desc(prospectAiAssessments.createdAt)],
        })
        res.json({ candidates, assessments })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error listing prospect candidates:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============================================================
// POST /external-runs (Phase 32, migration 054) — register a prospecting run that
// happened entirely OUTSIDE xmail's own search/score/enrich flow. The real production
// lead pipeline is xcraper (scrapes Google Maps via Apify, recording the actual run
// cost) -> Xphere (stores it) -> xmail (leads land via
// POST /api/outreach/leads/bulk-import carrying custom_fields.xcraper_run_id). This
// route lets Xphere additionally register the *run itself* — for journey/cost
// visibility — after the fact, once xcraper has already finished and imported. It is
// therefore a record-after-the-fact upsert, not a live multi-step flow like
// agent-prospecting.ts's /searches (which drives Apollo interactively and has never
// run in production).
//
// Written by Xphere over x-service-key, so it goes through the exact same
// requireOutreachWrite tenant-scope enforcement as every other outreach route — there
// is no separate/weaker check for the service-key path (see CLAUDE.md Authentication
// Flow: authorization is JS-side, the DB role bypasses RLS).
// ============================================================

router.post('/external-runs', async (req, res) => {
    try {
        const organizationId = req.query.organizationId as string | undefined
        // Same resolution as every other outreach write route (e.g.
        // agent-credentials.ts, send-message.ts): for a service-key caller this is the
        // server-bound XMAIL_SERVICE_USER_ID (see service-auth.ts applyServicePrincipal),
        // for a human caller it is their own verified id. Never invented.
        const actorUserId = req.headers['x-user-id'] as string | undefined
        if (!organizationId) return res.status(400).json({ error: 'organizationId is required' })
        if (!actorUserId) return res.status(401).json({ error: 'Unauthorized' })
        if (!await requireOutreachWrite(req, res, organizationId)) return

        const input = externalRunSchema.parse(req.body)

        const [created] = await db.insert(prospectingRuns).values({
            organizationId,
            actorUserId,
            provider: input.provider,
            idempotencyKey: input.externalRunId,
            status: 'imported',
            searchFilters: jsonbParam({
                label: input.label ?? null,
                query: input.query ?? null,
                location: input.location ?? null,
                actorId: input.actorId ?? null,
                template: input.template ?? null,
            }),
            discoveredCount: input.resultCount ?? 0,
            importedCount: input.importedCount ?? 0,
            // Ausente continua ausente: sem enrichedCount o contador fica 0 e o alerta
            // `enriched_count_never_populated` (outreach-silence.ts) permanece firing. Preencher
            // com zero como se fosse medicao esconderia exatamente o que precisa ser visto.
            ...(input.enrichedCount !== undefined ? { enrichedCount: input.enrichedCount } : {}),
            hypothesis: jsonbParam(input.hypothesis ?? {}),
            startedAt: new Date(),
            completedAt: new Date(),
        }).onConflictDoNothing({
            // Reuses the same unique index every other run-creation path relies on
            // (see agent-prospecting.ts's /searches) — a repeated call for the same
            // externalRunId can only ever no-op here, never create a second row.
            target: [prospectingRuns.organizationId, prospectingRuns.provider, prospectingRuns.idempotencyKey],
        }).returning()

        if (!created) {
            const replay = await db.query.prospectingRuns.findFirst({
                where: and(
                    eq(prospectingRuns.organizationId, organizationId),
                    eq(prospectingRuns.provider, input.provider),
                    eq(prospectingRuns.idempotencyKey, input.externalRunId),
                ),
            })
            if (!replay) throw new Error('Idempotent external-run conflict could not be resolved')
            // A source can repair/reconcile its own import and replay with a newer count.
            // Keep the single run current while preserving the append-only event and cost
            // ledgers below: neither is re-recorded, so a replay can never double-bill.
            const [reconciled] = await db.update(prospectingRuns).set({
                discoveredCount: input.resultCount ?? replay.discoveredCount,
                importedCount: input.importedCount ?? replay.importedCount,
                enrichedCount: input.enrichedCount ?? replay.enrichedCount,
                updatedAt: new Date(),
            }).where(and(
                eq(prospectingRuns.id, replay.id),
                eq(prospectingRuns.organizationId, organizationId),
            )).returning()
            return res.status(200).json({ run: reconciled ?? replay, idempotentReplay: true })
        }

        await recordRunEvent(db, {
            organizationId,
            runId: created.id,
            code: RUN_EVENT_CODES.import.EXTERNAL_RUN_REGISTERED,
            summary: input.label ?? null,
            detail: {
                provider: input.provider,
                externalRunId: input.externalRunId,
                resultCount: input.resultCount ?? 0,
                importedCount: input.importedCount ?? 0,
                costUsd: input.costUsd ?? null,
                // `code` e valor de maquina, entao a cobertura vai no detail e fica agregavel por
                // GROUP BY code depois. null quando o produtor nao mandou — nunca zero inventado.
                enrichedCount: input.enrichedCount ?? null,
                coverage: input.coverage ?? null,
            },
        })

        if (input.costUsd !== undefined) {
            await recordCost(db, {
                organizationId,
                category: 'lead_source',
                basis: 'actual',
                quantity: input.resultCount ?? 0,
                unit: 'result',
                provider: 'apify',
                runId: created.id,
                // The provider (Apify, via xcraper/Xphere) already reports the actual
                // total spend for this run — see outreach-costs.ts's
                // amountMicrosOverride doc comment for why this is written verbatim
                // instead of being priced against the local rate book.
                amountMicrosOverride: Math.round(input.costUsd * 1_000_000),
                dedupKey: `lead_source:xcraper:${input.externalRunId}`,
                detail: { externalRunId: input.externalRunId },
            })
        }

        res.status(201).json({ run: created, idempotentReplay: false })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error registering external prospecting run:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
