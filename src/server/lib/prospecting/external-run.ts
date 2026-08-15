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

export const externalRunSchema = z.object({
    // Only value for now — xcraper/Apify is the only run source that has ever shipped a
    // lead in production. See migration 054's header comment.
    provider: z.literal('xcraper'),
    externalRunId: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200).optional(),
    query: z.string().trim().min(1).max(500).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    resultCount: z.number().int().min(0).optional(),
    importedCount: z.number().int().min(0).optional(),
    // The ACTUAL total cost the provider (Apify) reported for this run, in USD — not a
    // unit price. See outreach-costs.ts's `amountMicrosOverride`.
    costUsd: z.number().min(0).optional(),
    actorId: z.string().trim().min(1).max(200).optional(),
    template: z.string().trim().min(1).max(200).optional(),
    hypothesis: hypothesisSchema.optional(),
})

export type ExternalRunInput = z.infer<typeof externalRunSchema>
