/**
 * Optional pre-run hypothesis attached to a prospecting run (Phase 31, migration 051,
 * `prospecting_runs.hypothesis`).
 *
 * A hypothesis states what the agent expects a run to prove ("premise"), the measurable
 * signal it expects to see ("expected"), and why ("basis"). It is advisory metadata only
 * — nothing in the search/score/enrich/import flow reads or branches on it — so the
 * schema is deliberately permissive (every field optional) and the only hard rule is a
 * size cap, to stop an agent from stuffing an unbounded blob into a jsonb column that has
 * no other size limit at the database layer.
 */

import { z } from 'zod'

/** Serialized-size cap for a hypothesis payload, in bytes (~4KB). */
export const MAX_HYPOTHESIS_BYTES = 4_096

export const hypothesisSchema = z.object({
    premise: z.string().trim().min(1).max(2_000).optional(),
    expected: z.record(z.union([z.string().max(500), z.number()])).optional(),
    basis: z.string().trim().min(1).max(2_000).optional(),
}).refine((value) => JSON.stringify(value).length <= MAX_HYPOTHESIS_BYTES, {
    message: `hypothesis payload exceeds the ${MAX_HYPOTHESIS_BYTES}-byte cap`,
})

export type ProspectingHypothesis = z.infer<typeof hypothesisSchema>
