/**
 * Request-body schema for POST /api/outreach/prospecting/external-runs (Phase 32,
 * migration 054).
 *
 * Kept in its own module — no `db` import — so it is directly unit-testable (see
 * `__tests__/external-run.test.ts`) without pulling in the database connection, the same
 * pattern `hypothesis.ts` already uses for `hypothesisSchema`.
 */

import { z } from 'zod'
import { hypothesisSchema } from './hypothesis'

/**
 * Cobertura do run: quantos dos resultados renderam e-mail, e como a presença web se distribui.
 *
 * Existe porque, sem isso, o Xmail sabe que um run aconteceu, quanto custou e quantos resultados
 * teve — mas não quantos vieram com e-mail. Em 2026-08-15 a pergunta "que % dos prospects tem
 * e-mail?" não pôde ser respondida para 85% da base, e é uma pergunta de decisão de custo
 * recorrente: sem ela não dá para saber se pagar por `enriched` compensa.
 *
 * Tudo é opcional de propósito: produtores antigos podem não enviar estes campos. O que chegar é
 * gravado; o que faltar continua ausente e VISÍVEL
 * (ver o alerta `enriched_count_never_populated` em outreach-silence.ts), nunca preenchido com
 * zero como se fosse medição.
 */
export const runCoverageSchema = z.object({
    /** Resultados que vieram com pelo menos um endereço de e-mail. */
    emailFound: z.number().int().min(0).optional(),
    /** Destes, quantos o verificador classificou como entregáveis. */
    emailVerified: z.number().int().min(0).optional(),
    /** Contagem por `web_presence_type` — chave livre porque o vocabulário é do Xphere. */
    byWebPresence: z.record(z.number().int().min(0)).optional(),
    /** Contagem por `booking_platform`. */
    byBookingPlatform: z.record(z.number().int().min(0)).optional(),
    /**
     * Sem classificação de presença web. NUNCA somar isto a "sem site": desconhecido é
     * desconhecido, e tratá-lo como ausência inventa cobertura comercial que ninguém mediu.
     */
    unclassified: z.number().int().min(0).optional(),
})

export type RunCoverage = z.infer<typeof runCoverageSchema>

const externalRunObjectSchema = z.object({
    // Only value for now — xcraper/Apify is the only run source that has ever shipped a
    // lead in production. See migration 054's header comment.
    provider: z.literal('xcraper'),
    externalRunId: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200).optional(),
    query: z.string().trim().min(1).max(500).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    resultCount: z.number().int().min(0).optional(),
    /**
     * How many prospects xcraper/Apify created or updated at the SOURCE system for this
     * run. This is NOT the number of leads that reached xmail — in production those two
     * numbers diverge badly (e.g. 30/23/25 ingested at the source vs. 0 leads landing in
     * xmail), because a prospect can fail email enrichment, dedupe against an existing
     * lead, or simply never reach `POST /api/outreach/leads/bulk-import`. The xmail-side
     * number is derived separately, from the attribution join
     * (`leads.custom_fields->>'source_run_id' = prospecting_runs.idempotency_key`) that
     * `src/server/jobs/measureProspectingOutcomes.ts` performs — never read this field as
     * a proxy for it.
     */
    ingestedCount: z.number().int().min(0).optional(),
    /**
     * @deprecated Legacy name for `ingestedCount`. Kept only because the
     * currently-deployed Xphere still sends this field under this name — new producers
     * should send `ingestedCount`. If both are present, `ingestedCount` wins.
     */
    importedCount: z.number().int().min(0).optional(),
    // The ACTUAL total cost the provider (Apify) reported for this run, in USD — not a
    // unit price. See outreach-costs.ts's `amountMicrosOverride`.
    costUsd: z.number().min(0).optional(),
    actorId: z.string().trim().min(1).max(200).optional(),
    template: z.string().trim().min(1).max(200).optional(),
    hypothesis: hypothesisSchema.optional(),
    /**
     * Quantos resultados passaram por enriquecimento de contato. Popula `enriched_count`.
     * Opcional de propósito e SEM fallback para 0: produtores antigos não enviam isto, e
     * omitir precisa continuar ausente (não virar zero) para que o alerta
     * `enriched_count_never_populated` (outreach-silence.ts) continue disparando enquanto
     * ninguém está de fato medindo enriquecimento. Ver o comentário em prospecting.ts.
     */
    enrichedCount: z.number().int().min(0).optional(),
    coverage: runCoverageSchema.optional(),
})

/**
 * `ingestedCount` in the parsed output is always the resolved value — preferring the
 * new `ingestedCount` input field over the deprecated `importedCount` alias when both are
 * sent. The raw `importedCount` input field is intentionally dropped from the output so
 * every downstream reader (the route, tests) has exactly one field to consult.
 */
export const externalRunSchema = externalRunObjectSchema.transform(({ importedCount, ingestedCount, ...rest }) => ({
    ...rest,
    ingestedCount: ingestedCount ?? importedCount,
}))

export type ExternalRunInput = z.infer<typeof externalRunSchema>
