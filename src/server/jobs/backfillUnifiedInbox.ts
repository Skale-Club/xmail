/**
 * Bounded, restart-safe Unified Inbox backfill (Phase 21 UIF-05).
 *
 * Closes any crash window between a durable send / staged inbound event and its Unified Inbox
 * materialization WITHOUT resending mail or duplicating side effects. It reuses the LIVE
 * idempotent materializers (`materializeOutboundEmail`, `materializeProviderEvent`) over rows that
 * an anti-join proves are not yet materialized:
 *   - outbound: successful `outreach_emails` missing a `source_key = outreach-email:<id>` message,
 *   - inbound: staged `outreach_provider_events` missing a `source_key = <provider>:<id>` message.
 *
 * Restart-safety without a checkpoint table: a materialized row disappears from the anti-join, and
 * a deterministic `(sent_at,id)` / `(received_at,id)` keyset advances past any errored row within a
 * run, so interruption and restart converge to the same row counts as one uninterrupted run.
 *
 * Outbound batches run BEFORE inbound batches so a historical reply's References/In-Reply-To can
 * attach to its already-materialized outbound root. This is operator-invoked, bounded by lookback
 * and batch/maxBatches limits, and mutates NO campaign/lead/account counters — it only writes the
 * Unified Inbox tables via the live materializers.
 */
import { createLogger } from '../lib/logger'
import { materializeProviderEvent, type UnifiedInboxSql } from '../lib/unified-inbox/ingest'
import { materializeOutboundEmail } from '../lib/unified-inbox/outbound'

const log = createLogger('outreach.unifiedInbox.backfill')

// Stable advisory-lock name so an operator run and a future scheduled run cannot overlap.
export const BACKFILL_LOCK_NAME = 'outreach-unified-inbox-backfill'

export const DEFAULT_BACKFILL_LOOKBACK_DAYS = 30
export const DEFAULT_BACKFILL_BATCH_SIZE = 200
export const DEFAULT_BACKFILL_MAX_BATCHES = 1000

// The keyset origin: strictly before any real (timestamp, uuid) pair.
const MIN_TIMESTAMP_ISO = new Date(0).toISOString()
const MIN_UUID = '00000000-0000-0000-0000-000000000000'

export interface BackfillSectionResult {
    scanned: number
    inserted: number
    duplicates: number
    errors: number
}

export interface BackfillResult {
    outbound: BackfillSectionResult
    inbound: BackfillSectionResult
}

export interface BackfillUnifiedInboxDeps {
    sql?: UnifiedInboxSql
    now?: () => Date
    lookbackDays?: number
    batchSize?: number
    maxBatches?: number
    /** Optional organization scope (set for targeted runs and test isolation on the shared DB). */
    organizationId?: string
    /** Injectable materializers (tests force failures); default to the live services. */
    materializeOutbound?: (outreachEmailId: string) => Promise<{ inserted: boolean }>
    materializeInbound?: (eventId: string) => Promise<{ inserted: boolean }>
}

async function defaultSqlClient(): Promise<UnifiedInboxSql> {
    const { queryClient } = await import('../../db')
    return queryClient as unknown as UnifiedInboxSql
}

interface OutboundCandidate {
    id: string
    sent_at: Date
}

interface InboundCandidate {
    id: string
    received_at: Date
}

async function backfillOutbound(
    sql: UnifiedInboxSql,
    input: {
        cutoffIso: string
        organizationId: string | null
        batchSize: number
        maxBatches: number
        materialize: (id: string) => Promise<{ inserted: boolean }>
    },
): Promise<BackfillSectionResult> {
    const result: BackfillSectionResult = { scanned: 0, inserted: 0, duplicates: 0, errors: 0 }
    let cursorAtIso = MIN_TIMESTAMP_ISO
    let cursorId = MIN_UUID

    for (let batch = 0; batch < input.maxBatches; batch++) {
        const rows = await sql<OutboundCandidate>`
            SELECT oe.id, oe.sent_at
            FROM outreach_emails oe
            WHERE oe.status = 'sent'
              AND oe.sent_at IS NOT NULL
              AND oe.sent_at >= ${input.cutoffIso}::timestamp
              AND (${input.organizationId}::uuid IS NULL OR oe.organization_id = ${input.organizationId}::uuid)
              AND (oe.sent_at, oe.id) > (${cursorAtIso}::timestamp, ${cursorId}::uuid)
              AND NOT EXISTS (
                  SELECT 1 FROM outreach_conversation_messages m
                  WHERE m.organization_id = oe.organization_id
                    AND m.email_account_id = oe.email_account_id
                    AND m.source_key = 'outreach-email:' || oe.id::text
              )
            ORDER BY oe.sent_at, oe.id
            LIMIT ${input.batchSize}
        `
        if (rows.length === 0) break

        for (const row of rows) {
            result.scanned++
            cursorAtIso = new Date(row.sent_at).toISOString()
            cursorId = row.id
            try {
                const outcome = await input.materialize(row.id)
                if (outcome.inserted) result.inserted++
                else result.duplicates++
            } catch (error) {
                result.errors++
                log.warn({
                    action: 'outreach.unifiedInbox.backfill.outbound_error',
                    outreachEmailId: row.id,
                    error: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
                }, 'outbound backfill materialization failed for one row')
            }
        }
    }

    return result
}

async function backfillInbound(
    sql: UnifiedInboxSql,
    input: {
        cutoffIso: string
        organizationId: string | null
        batchSize: number
        maxBatches: number
        materialize: (id: string) => Promise<{ inserted: boolean }>
    },
): Promise<BackfillSectionResult> {
    const result: BackfillSectionResult = { scanned: 0, inserted: 0, duplicates: 0, errors: 0 }
    let cursorAtIso = MIN_TIMESTAMP_ISO
    let cursorId = MIN_UUID

    for (let batch = 0; batch < input.maxBatches; batch++) {
        const rows = await sql<InboundCandidate>`
            SELECT e.id, e.received_at
            FROM outreach_provider_events e
            WHERE e.received_at >= ${input.cutoffIso}::timestamp
              AND (${input.organizationId}::uuid IS NULL OR e.organization_id = ${input.organizationId}::uuid)
              AND (e.received_at, e.id) > (${cursorAtIso}::timestamp, ${cursorId}::uuid)
              AND NOT EXISTS (
                  SELECT 1 FROM outreach_conversation_messages m
                  WHERE m.organization_id = e.organization_id
                    AND m.email_account_id = e.email_account_id
                    AND m.source_key = e.provider || ':' || e.provider_message_id
              )
            ORDER BY e.received_at, e.id
            LIMIT ${input.batchSize}
        `
        if (rows.length === 0) break

        for (const row of rows) {
            result.scanned++
            cursorAtIso = new Date(row.received_at).toISOString()
            cursorId = row.id
            try {
                const outcome = await input.materialize(row.id)
                if (outcome.inserted) result.inserted++
                else result.duplicates++
            } catch (error) {
                result.errors++
                log.warn({
                    action: 'outreach.unifiedInbox.backfill.inbound_error',
                    eventId: row.id,
                    error: { message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) },
                }, 'inbound backfill materialization failed for one row')
            }
        }
    }

    return result
}

/**
 * Runs one bounded backfill pass. Outbound first, then inbound, so a historical reply attaches to
 * its outbound root. Never resends mail and never mutates the source rows.
 */
export async function backfillUnifiedInbox(deps: BackfillUnifiedInboxDeps = {}): Promise<BackfillResult> {
    const sql = deps.sql ?? (await defaultSqlClient())
    const now = deps.now ?? (() => new Date())
    const lookbackDays = deps.lookbackDays ?? DEFAULT_BACKFILL_LOOKBACK_DAYS
    const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BACKFILL_BATCH_SIZE)
    const maxBatches = Math.max(1, deps.maxBatches ?? DEFAULT_BACKFILL_MAX_BATCHES)
    const organizationId = deps.organizationId ?? null
    const materializeOutbound = deps.materializeOutbound
        ?? ((id: string) => materializeOutboundEmail(id, { sql, now }))
    const materializeInbound = deps.materializeInbound
        ?? ((id: string) => materializeProviderEvent(id, { sql, now }))

    const cutoffIso = new Date(now().getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()

    const outbound = await backfillOutbound(sql, {
        cutoffIso,
        organizationId,
        batchSize,
        maxBatches,
        materialize: materializeOutbound,
    })
    const inbound = await backfillInbound(sql, {
        cutoffIso,
        organizationId,
        batchSize,
        maxBatches,
        materialize: materializeInbound,
    })

    log.info({
        action: 'outreach.unifiedInbox.backfill.complete',
        outbound,
        inbound,
    }, 'unified inbox backfill pass complete')

    return { outbound, inbound }
}

/**
 * Operator entrypoint: runs the backfill behind a named advisory lock so a scheduled materializer
 * or a second operator run cannot overlap it. `cron-lock` is imported lazily so this module stays
 * importable (e.g. in .db tests) without DATABASE_URL.
 */
export async function runBackfillUnifiedInboxWithLock(deps: BackfillUnifiedInboxDeps = {}): Promise<BackfillResult | null> {
    const { runWithLock } = await import('../lib/cron-lock')
    let outcome: BackfillResult | null = null
    await runWithLock(BACKFILL_LOCK_NAME, async () => {
        outcome = await backfillUnifiedInbox(deps)
    })
    return outcome
}
