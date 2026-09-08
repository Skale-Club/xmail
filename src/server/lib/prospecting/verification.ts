/**
 * Request-body schema for POST
 * /api/outreach/prospecting/external-runs/:externalRunId/verification (Phase 34, migration
 * 064).
 *
 * Kept in its own module -- no `db` import -- so it is directly unit-testable without
 * pulling in the database connection, the same pattern `external-run.ts` already
 * documents and uses for its sibling route.
 *
 * WHY THIS ROUTE EXISTS: the `email_verification` cost category has had a seeded
 * MillionVerifier rate since migrations 055/056 and, measured on 2026-09-08, ZERO ledger
 * entries -- the MillionVerifier balance dropped 253 -> 215 credits (98 verifications)
 * with nothing recorded. Xphere calls this route once per verification batch, after the
 * fact, the same "record-after-the-fact" shape as `external-run.ts`'s `/external-runs`.
 */

import { z } from 'zod'

const runVerificationObjectSchema = z.object({
    // Only value for now -- xcraper is the only run source that registers runs via
    // POST /external-runs (see external-run.ts). Used to resolve the target
    // prospecting_runs row together with `:externalRunId`, exactly the same
    // (organizationId, provider, idempotencyKey) triple /external-runs upserts on.
    provider: z.literal('xcraper'),
    checked: z.number().int().min(0),
    ok: z.number().int().min(0),
    catchAll: z.number().int().min(0),
    unknown: z.number().int().min(0),
    invalid: z.number().int().min(0),
    // Credits the provider reports as actually consumed for this batch -- see migration
    // 056's header on why this must never be assumed equal to `checked` (MillionVerifier
    // bills only conclusive results, not risky/unknown ones). `null` is a valid value
    // (the caller genuinely doesn't know), distinct from omitting the field.
    creditsUsed: z.number().int().min(0).nullable(),
    verificationProvider: z.enum(['millionverifier', 'neverbounce', 'mixed']),
    placeholdersRejected: z.number().int().min(0).optional(),
    // ISO-8601. `{ offset: true }` accepts both a bare 'Z' and an explicit numeric offset.
    verifiedAt: z.string().datetime({ offset: true }),
}).superRefine((value, ctx) => {
    const sum = value.ok + value.catchAll + value.unknown + value.invalid
    if (value.checked !== sum) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['checked'],
            message: `checked (${value.checked}) must equal ok + catchAll + unknown + invalid `
                + `(${value.ok} + ${value.catchAll} + ${value.unknown} + ${value.invalid} = ${sum})`,
        })
    }
})

export const runVerificationSchema = runVerificationObjectSchema
export type RunVerificationInput = z.infer<typeof runVerificationSchema>
