/**
 * Bounded, leased consumer that materializes staged provider events into the Unified Inbox.
 *
 * This job is the ONLY thing that drives the Phase 21 materialization lifecycle on
 * outreach_provider_events. It reuses the Phase 18/19 lease conventions but on the DEDICATED
 * materialization columns — it never reads, filters, claims, or writes Phase 19's
 * `processed_at` (reply/bounce classification owns that, independently). It does not poll any
 * provider; it consumes rows the provider-staging job already persisted.
 *
 * Claim: one compare-and-swap picks the oldest reclaimable row (pending, or processing with an
 * expired lease) via `FOR UPDATE SKIP LOCKED`, flips it to processing, sets a fresh lease, and
 * increments attempts. The materializer then atomically commits the normalized message plus
 * the `materialized` timestamp/link in one transaction — there is no separate acknowledgement
 * window, so a crash after that commit is safe (the row is already materialized and never
 * re-claimed). A materialization failure is retried until a bounded attempt limit, after which
 * the poison event is parked in `failed` so it can never starve newer mail.
 */
import { randomUUID } from 'node:crypto'
import { createLogger } from '../lib/logger'
import { materializeProviderEvent, type UnifiedInboxSql } from '../lib/unified-inbox/ingest'
import { publishInboxEvent } from '../lib/inbox-events'

const log = createLogger('outreach.unifiedInbox')

// Stable advisory-lock name — renaming would let old/new instances overlap during a rollout.
export const MATERIALIZE_LOCK_NAME = 'outreach-unified-inbox-materializer'

export const DEFAULT_MATERIALIZE_LIMIT = 200
export const MATERIALIZE_MAX_ATTEMPTS = 5
export const MATERIALIZE_LEASE_MINUTES = 5
const MAX_ERROR_LENGTH = 1000

export interface MaterializeInboxResult {
    claimed: number
    materialized: number
    duplicates: number
    failed: number
}

export interface MaterializeInboxDeps {
    sql?: UnifiedInboxSql
    now?: () => Date
    limit?: number
    maxAttempts?: number
    leaseMinutes?: number
    /**
     * Optional organization scope for the claim. Unset in production (the queue is org-wide
     * and materializeProviderEvent scopes each event by its own organization, mirroring the
     * Phase 19 classification queue). Set for targeted operational reprocessing and for test
     * isolation against the shared disposable database.
     */
    organizationId?: string
    /** Injectable materializer (tests force failures); defaults to the real service. */
    materialize?: (eventId: string) => Promise<{ inserted: boolean; organizationId?: string | null; conversationId?: string | null }>
    /** Injectable fanout publisher (tests assert it is called post-commit); defaults to the in-process bus. */
    publish?: (event: { organizationId: string; conversationId: string | null }) => void
}

interface ClaimRow {
    id: string
    attempts: number
}

async function defaultSqlClient(): Promise<UnifiedInboxSql> {
    const { queryClient } = await import('../../db')
    return queryClient as unknown as UnifiedInboxSql
}

function sanitizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.slice(0, MAX_ERROR_LENGTH)
}

/**
 * Materializes up to `limit` staged events, one lease at a time. One at a time (not a batch
 * lease) so a crash costs at most the single in-flight event, re-materialized on a later tick.
 */
export async function materializeUnifiedInbox(deps: MaterializeInboxDeps = {}): Promise<MaterializeInboxResult> {
    const sql = deps.sql ?? (await defaultSqlClient())
    const now = deps.now ?? (() => new Date())
    const limit = deps.limit ?? DEFAULT_MATERIALIZE_LIMIT
    const maxAttempts = deps.maxAttempts ?? MATERIALIZE_MAX_ATTEMPTS
    const leaseMinutes = deps.leaseMinutes ?? MATERIALIZE_LEASE_MINUTES
    const organizationId = deps.organizationId ?? null
    const materialize = deps.materialize ?? ((eventId: string) => materializeProviderEvent(eventId, { sql, now }))
    const publish = deps.publish ?? ((event: { organizationId: string; conversationId: string | null }) => {
        // Post-commit, organization-scoped fanout of a SIGNAL only (no bodies) so open Unified
        // Inbox clients invalidate their unread/list/thread caches near-real-time. Best-effort:
        // a fanout failure must never affect the durable materialization outcome.
        try {
            publishInboxEvent({
                organizationId: event.organizationId,
                kind: 'conversation.updated',
                conversationId: event.conversationId,
                version: now().getTime(),
                at: now().toISOString(),
            })
        } catch { /* fanout is a best-effort side channel; the polling fallback covers misses */ }
    })

    const result: MaterializeInboxResult = { claimed: 0, materialized: 0, duplicates: 0, failed: 0 }

    for (let i = 0; i < limit; i++) {
        const leaseToken = randomUUID()
        // Atomic claim: oldest reclaimable row, skipping any a peer worker holds. The partial
        // materialization-claim index backs this predicate; failed/materialized are excluded.
        const claimed = await sql<ClaimRow>`
            WITH candidate AS (
                SELECT id FROM outreach_provider_events
                WHERE (
                    materialization_status = 'pending'
                    OR (materialization_status = 'processing' AND materialization_lease_expires_at < now())
                )
                  AND (${organizationId}::uuid IS NULL OR organization_id = ${organizationId}::uuid)
                ORDER BY received_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE outreach_provider_events e
            SET materialization_status = 'processing',
                materialization_lease_token = ${leaseToken}::uuid,
                materialization_lease_expires_at = now() + (${leaseMinutes}::int * interval '1 minute'),
                materialization_attempts = e.materialization_attempts + 1,
                updated_at = now()
            FROM candidate
            WHERE e.id = candidate.id
            RETURNING e.id, e.materialization_attempts AS attempts
        `

        const claim = claimed[0]
        if (!claim) break
        result.claimed++
        const attempts = Number(claim.attempts)

        try {
            const outcome = await materialize(claim.id)
            if (outcome.inserted) {
                result.materialized++
                // Publish AFTER the materializer's transaction has committed (materializeProviderEvent
                // resolves post-commit) — a subscriber that invalidates its cache reads committed state.
                if (outcome.organizationId) {
                    publish({ organizationId: outcome.organizationId, conversationId: outcome.conversationId ?? null })
                }
            } else {
                result.duplicates++
            }
        } catch (error) {
            const sanitized = sanitizeError(error)
            if (attempts >= maxAttempts) {
                // Poison: park it so it never heads the queue forever. Visible via
                // materialization_status = 'failed' + materialization_error.
                await sql`
                    UPDATE outreach_provider_events
                    SET materialization_status = 'failed',
                        materialization_lease_token = NULL,
                        materialization_lease_expires_at = NULL,
                        materialization_error = ${sanitized},
                        updated_at = now()
                    WHERE id = ${claim.id}
                `
                result.failed++
                log.warn({ action: 'outreach.unifiedInbox.materialize_failed', eventId: claim.id, attempts }, 'materialization exhausted attempts')
            } else {
                // Return to the pool for a bounded retry on a later claim.
                await sql`
                    UPDATE outreach_provider_events
                    SET materialization_status = 'pending',
                        materialization_lease_token = NULL,
                        materialization_lease_expires_at = NULL,
                        materialization_error = ${sanitized},
                        updated_at = now()
                    WHERE id = ${claim.id}
                `
            }
        }
    }

    if (result.claimed > 0) {
        log.info({
            action: 'outreach.unifiedInbox.materialize_tick',
            claimed: result.claimed,
            materialized: result.materialized,
            duplicates: result.duplicates,
            failed: result.failed,
        }, 'unified inbox materialization tick')
    }

    return result
}

// P0-06 / advisory lock: prevents concurrent runs across Node instances (blue-green overlap,
// future horizontal scale). Session-scoped, released automatically on crash. cron-lock is
// imported lazily so this module stays importable (e.g. in .db tests) without DATABASE_URL.
export async function runMaterializerWithLock(): Promise<void> {
    const { runWithLock } = await import('../lib/cron-lock')
    await runWithLock(MATERIALIZE_LOCK_NAME, async () => {
        await materializeUnifiedInbox()
    })
}
