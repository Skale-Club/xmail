/**
 * Deterministic `dedupKey` builders for `outreach_cost_entries` rows written from the
 * prospecting flow. `recordCost` (src/server/lib/outreach-costs.ts) dedupes writes on
 * (organizationId, dedupKey), so a key here must be:
 *   - stable across retries of the same logical operation (a retry must reuse the exact
 *     same key so the insert is skipped instead of double-billing), and
 *   - distinct across different operations (different runs, different assessments).
 *
 * Kept as small pure functions (no DB, no framework) specifically so the stability
 * property is unit-testable without mocking a route or a database call.
 */

/**
 * One enrichment "operation" is a specific (run, approval) pair: an
 * `outreach_action_approvals` row is created for one immutable candidateIds set, and the
 * enrich route claims it with a conditional `status = 'approved' -> 'executing'` update
 * before ever calling the provider — so re-POSTing the same approvalId can only ever
 * correspond to the same logical enrichment attempt. Keying on runId+approvalId
 * piggybacks on that existing uniqueness instead of re-deriving a hash of the candidate
 * id set.
 */
export function buildEnrichmentCostDedupKey(runId: string, approvalId: string): string {
    return `enrich:${runId}:${approvalId}`
}

/**
 * A `prospect_ai_assessments` row is itself already idempotent per
 * (organizationId, agentCredentialId, candidateId, idempotencyKey) — see
 * `prospect_ai_assessments_idempotency_unique` in src/db/schema.ts — so its own id is
 * already a stable, unique-per-logical-operation key for the cost entry it produces.
 */
export function buildAssessmentCostDedupKey(assessmentId: string): string {
    return `assess:${assessmentId}`
}
