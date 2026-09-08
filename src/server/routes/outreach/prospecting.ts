import { Router } from 'express'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import { outreachCostEntries, prospectAiAssessments, prospectCandidates, prospectingRunEvents, prospectingRuns } from '../../../db/schema'
import { requireOutreachRead, requireOutreachWrite } from '../../lib/outreach-access'
import { recordCost } from '../../lib/outreach-costs'
import { jsonbParam } from '../../lib/jsonb'
import { externalRunSchema } from '../../lib/prospecting/external-run'
import { runVerificationSchema } from '../../lib/prospecting/verification'
import { emptyAdvisory, loadAdvisory } from '../../lib/prospecting/advisory'
import { recordRunEvent, RUN_EVENT_CODES } from '../../lib/prospecting/journey'
import { measureProspectingOutcomes } from '../../jobs/measureProspectingOutcomes'

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
//
// `input.ingestedCount` (accepting the deprecated `importedCount` alias — see
// external-run.ts) is how many prospects xcraper/Apify created or updated at the SOURCE
// system for this run, NOT how many leads reached xmail. It is still written into the
// `imported_count` column below, unchanged. Do not read it as "leads imported into
// xmail" — that number is derived from the attribution join
// (`leads.custom_fields->>'source_run_id' = prospecting_runs.idempotency_key`) that
// `src/server/jobs/measureProspectingOutcomes.ts` performs, and in production the two
// numbers diverge badly (source-side counts of 30/23/25 against 0 leads that actually
// landed in xmail).
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
            importedCount: input.ingestedCount ?? 0,
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
                importedCount: input.ingestedCount ?? replay.importedCount,
                enrichedCount: input.enrichedCount ?? replay.enrichedCount,
                updatedAt: new Date(),
            }).where(and(
                eq(prospectingRuns.id, replay.id),
                eq(prospectingRuns.organizationId, organizationId),
            )).returning()
            const finalReplayRun = reconciled ?? replay
            // Advisory on the replay path too — unlike the Apollo pre-flight case this
            // route mirrors, a caller retrying registration should still get the learning,
            // not just the caller that happened to create the row. Same never-break
            // contract as below: on failure fall back to the shared empty shape.
            let advisory
            try {
                advisory = await loadAdvisory(db, {
                    organizationId,
                    searchFilters: finalReplayRun.searchFilters,
                    excludeRunId: finalReplayRun.id,
                })
            } catch (advisoryError) {
                console.error('External-run advisory failed:', advisoryError instanceof Error ? advisoryError.message : advisoryError)
                advisory = emptyAdvisory()
            }
            return res.status(200).json({ run: finalReplayRun, idempotentReplay: true, advisory })
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
                importedCount: input.ingestedCount ?? 0,
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

        // Prior-run learning, folded directly into this response — mirrors
        // agent-prospecting.ts's POST /searches (which never runs in production; this
        // /external-runs route is where the real Hermes/Xphere flow can actually see it).
        // Must never break or delay run registration: the run, its event, and its cost
        // entry are already committed above, so a failure here only degrades this
        // additive field.
        let advisory
        try {
            advisory = await loadAdvisory(db, {
                organizationId,
                searchFilters: created.searchFilters,
                excludeRunId: created.id,
            })
        } catch (advisoryError) {
            console.error('External-run advisory failed:', advisoryError instanceof Error ? advisoryError.message : advisoryError)
            advisory = emptyAdvisory()
        }

        res.status(201).json({ run: created, idempotentReplay: false, advisory })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error registering external prospecting run:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============================================================
// POST /external-runs/:externalRunId/verification (Phase 34, migration 064) — Xphere
// registers the result of an already-completed MillionVerifier/NeverBounce batch for a
// run that was previously registered via POST /external-runs above.
//
// Evidence this closes (measured 2026-09-08): the `email_verification` ledger category
// has had a seeded MillionVerifier rate since migrations 055/056 and ZERO entries — the
// MillionVerifier balance dropped 253 -> 215 credits across 98 verifications and nothing
// recorded it. Journeys only learned verified counts from human-dictated Hermes notes.
//
// Same auth shape as POST /external-runs: x-service-key service principal through
// requireOutreachWrite, ?organizationId= required (see CLAUDE.md Authentication Flow —
// authorization is JS-side, there is no DB safety net).
//
// Idempotency: identical repeats key on (runId, 'verify.completed', verifiedAt) — mirrors
// agent-prospecting.ts's POST /runs/:id/notes (same detail->>'idempotency_key' pattern,
// same pg_advisory_xact_lock-guarded transaction), NOT the onConflictDoNothing-on-the-row
// idempotency /external-runs uses, because there is no dedicated "verification" row to
// upsert here — the event + cost entry + run-counter update are the three things a
// second identical call must not repeat.
// ============================================================

router.post('/external-runs/:externalRunId/verification', async (req, res) => {
    try {
        const organizationId = req.query.organizationId as string | undefined
        if (!organizationId) return res.status(400).json({ error: 'organizationId is required' })
        if (!await requireOutreachWrite(req, res, organizationId)) return

        const externalRunId = req.params.externalRunId
        const input = runVerificationSchema.parse(req.body)

        const run = await db.query.prospectingRuns.findFirst({
            where: and(
                eq(prospectingRuns.organizationId, organizationId),
                eq(prospectingRuns.provider, input.provider),
                eq(prospectingRuns.idempotencyKey, externalRunId),
            ),
        })
        if (!run) {
            return res.status(404).json({ error: `No prospecting run found for provider=${input.provider} externalRunId=${externalRunId}` })
        }

        // 'mixed' has no rate-book row of its own (only 'millionverifier' is seeded, migration
        // 056) — collapse it to 'millionverifier' for pricing/ledger purposes and note the
        // collapse in detail so it stays visible rather than silently misattributed.
        const ledgerProvider = input.verificationProvider === 'mixed' ? 'millionverifier' : input.verificationProvider
        const idempotencyKey = `verify:${externalRunId}:${input.verifiedAt}`
        const dedupKey = `email_verification:${ledgerProvider}:${externalRunId}:${input.verifiedAt}`

        const result = await db.transaction(async (tx) => {
            // Same per-key serialization agent-prospecting.ts's /runs/:id/notes uses: two
            // identical calls racing each other must not both observe "no existing event yet".
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${organizationId}:${run.id}:${idempotencyKey}`}))`)

            const existingEvent = await tx.query.prospectingRunEvents.findFirst({
                where: and(
                    eq(prospectingRunEvents.organizationId, organizationId),
                    eq(prospectingRunEvents.runId, run.id),
                    eq(prospectingRunEvents.code, RUN_EVENT_CODES.verify.COMPLETED),
                    sql`${prospectingRunEvents.detail}->>'idempotency_key' = ${idempotencyKey}`,
                ),
            })
            if (existingEvent) {
                const existingCostEntry = await tx.query.outreachCostEntries.findFirst({
                    where: and(
                        eq(outreachCostEntries.organizationId, organizationId),
                        eq(outreachCostEntries.dedupKey, dedupKey),
                    ),
                })
                return { idempotentReplay: true, eventId: existingEvent.id, costEntryId: existingCostEntry?.id ?? null }
            }

            // Same convention as external-run.ts's coverage fields: null (not 0) when the
            // denominator hasn't been measured, so an absent discoveredCount never masquerades
            // as "0% verified".
            const verifiedEmailRate = run.discoveredCount > 0 ? input.ok / run.discoveredCount : null
            const summary = `${input.checked} checked: ${input.ok} ok, ${input.catchAll} catch-all, `
                + `${input.unknown} unknown, ${input.invalid} invalid (${input.verificationProvider})`

            // recordRunEvent never throws (see journey.ts doc comment) — a broken events table
            // must not break run registration. The follow-up SELECT below is what recovers the
            // id for the response; the WHERE clause is unique for this (run, code, verifiedAt)
            // triple under the advisory lock above.
            await recordRunEvent(tx, {
                organizationId,
                runId: run.id,
                code: RUN_EVENT_CODES.verify.COMPLETED,
                summary,
                detail: {
                    ...input,
                    externalRunId,
                    idempotency_key: idempotencyKey,
                    verifiedEmailRate,
                },
            })
            const event = await tx.query.prospectingRunEvents.findFirst({
                where: and(
                    eq(prospectingRunEvents.organizationId, organizationId),
                    eq(prospectingRunEvents.runId, run.id),
                    eq(prospectingRunEvents.code, RUN_EVENT_CODES.verify.COMPLETED),
                    sql`${prospectingRunEvents.detail}->>'idempotency_key' = ${idempotencyKey}`,
                ),
            })

            // Actual credits reported by the provider outrank an estimate from `checked` — same
            // "provider-reported beats price-book" preference outreach-costs.ts documents for
            // amountMicrosOverride, but here we still want the price book applied (frozen
            // unit_cost_micros from the seeded 056 rate), so quantity is what changes, not the
            // pricing path. When no rate resolves, recordCost already writes the entry unpriced
            // (unitCostMicros=0, detail.rate_missing=true) rather than inventing a price.
            const costResult = await recordCost(tx, {
                organizationId,
                category: 'email_verification',
                basis: input.creditsUsed !== null ? 'actual' : 'estimated',
                quantity: input.creditsUsed ?? input.checked,
                unit: 'credit',
                provider: ledgerProvider,
                runId: run.id,
                dedupKey,
                detail: input.verificationProvider === 'mixed'
                    ? { verification_provider_mixed_collapsed_to: ledgerProvider }
                    : {},
            })

            await tx.update(prospectingRuns).set({
                verifiedOkCount: input.ok,
                verifiedAt: new Date(input.verifiedAt),
                updatedAt: new Date(),
            }).where(and(
                eq(prospectingRuns.id, run.id),
                eq(prospectingRuns.organizationId, organizationId),
            ))

            return { idempotentReplay: false, eventId: event?.id ?? null, costEntryId: costResult.entry?.id ?? null }
        })

        // Fase 35 "score sooner": a run's hypothesis verdict used to go stale for up to 6 hours
        // (measureProspectingOutcomes.ts's own cron cadence) after the very event
        // (verify.completed) that usually makes verified_email_rate computable for the first
        // time. Only worth doing on a genuine write -- an idempotent replay recorded nothing
        // new, so there is nothing for a fresh measurement pass to pick up. Reuses the exact
        // same recompute-everything function the 6-hourly job calls, rather than duplicating
        // its attribution/scoring logic here; measureProspectingOutcomes() already catches and
        // logs every failure mode internally and never throws (see its own doc comment), so
        // this can never turn a successful verification write into a failed HTTP response.
        if (!result.idempotentReplay) {
            await measureProspectingOutcomes()
        }

        res.status(result.idempotentReplay ? 200 : 201).json({
            runId: run.id,
            eventId: result.eventId,
            costEntryId: result.costEntryId,
            ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
        })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error registering prospecting run verification:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
