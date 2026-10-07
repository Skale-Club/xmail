import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { db } from '../../db'
import { outreachAgentAuditLog } from '../../db/schema'

/**
 * Version history of agent copy edits, kept in `outreach_agent_audit_log` instead of a table of
 * its own. Every edit and every revert already has to be audited (who: credential + principal,
 * when: created_at, what: metadata), so the same row carries the full before/after of the changed
 * fields and there is exactly one place to look. Rows are append-only and nothing prunes them.
 *
 * Events are keyed by (organization, campaign id as `resource_id`, `metadata.stepOrder`). The
 * step uuid is recorded for reference but deliberately not used as the key: a human re-saving the
 * sequence in the admin UI replaces the step rows, and the history should survive that.
 */

export const STEP_COPY_UPDATED_ACTION = 'agent.campaign.step_copy_updated'
export const STEP_COPY_REVERTED_ACTION = 'agent.campaign.step_copy_reverted'

/** The step columns an agent edit can change, and therefore the ones a version snapshot holds. */
export const VERSIONED_STEP_FIELDS = ['subject', 'plainBody', 'htmlBody', 'delayHours', 'delayHoursMax'] as const
export type VersionedStepField = typeof VERSIONED_STEP_FIELDS[number]

/** Only the fields that changed in one edit; absent means "not touched". */
export interface StepSnapshot {
    subject?: string | null
    plainBody?: string | null
    htmlBody?: string | null
    delayHours?: number
    delayHoursMax?: number | null
}

export interface StepCopyEvent {
    action: typeof STEP_COPY_UPDATED_ACTION | typeof STEP_COPY_REVERTED_ACTION
    before: StepSnapshot
    after: StepSnapshot
    createdAt: Date
}

export type StepCopyEventReader = Pick<typeof db, 'select'>

const MAX_EVENTS_READ = 200

/** Copy the versioned fields present in `source` (own properties), nothing else. */
export function snapshotFields(
    source: Record<string, unknown>,
    fields: readonly VersionedStepField[] = VERSIONED_STEP_FIELDS,
): StepSnapshot {
    const snapshot: Record<string, unknown> = {}
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(source, field)) snapshot[field] = source[field]
    }
    return snapshot as StepSnapshot
}

function lineCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>()
    for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
    return counts
}

function changedLines(from: string, to: string): { added: number; removed: number } {
    const fromCounts = lineCounts(from)
    const toCounts = lineCounts(to)
    let removed = 0
    let added = 0
    for (const [line, count] of fromCounts) removed += Math.max(0, count - (toCounts.get(line) ?? 0))
    for (const [line, count] of toCounts) added += Math.max(0, count - (fromCounts.get(line) ?? 0))
    return { added, removed }
}

export interface StepChangeSummary {
    /** One line, safe to read in a log or a chat: "subject; plainBody +2/-1 lines". */
    text: string
    fields: Record<string, Record<string, unknown>>
}

/**
 * Short, human-readable description of what changed between two snapshots. Subjects are quoted in
 * full (they are short); bodies are summarized by size and changed-line counts, because the full
 * text is already in `before`/`after`.
 */
export function summarizeStepChange(before: StepSnapshot, after: StepSnapshot): StepChangeSummary {
    const fields: Record<string, Record<string, unknown>> = {}
    const parts: string[] = []
    for (const field of VERSIONED_STEP_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(after, field)) continue
        const from = before[field] ?? null
        const to = after[field] ?? null
        if (from === to) continue
        if (field === 'plainBody' || field === 'htmlBody') {
            const lines = changedLines(String(from ?? ''), String(to ?? ''))
            fields[field] = {
                beforeChars: String(from ?? '').length,
                afterChars: String(to ?? '').length,
                linesAdded: lines.added,
                linesRemoved: lines.removed,
            }
            parts.push(`${field} +${lines.added}/-${lines.removed} lines`)
        } else {
            fields[field] = { from, to }
            parts.push(field)
        }
    }
    return { text: parts.join('; ') || 'no field changed', fields }
}

/**
 * The edit a revert would undo: replay the events oldest-first, an edit pushes, a revert pops, and
 * whatever is left on top is the latest edit that has not been undone. That makes consecutive
 * reverts walk back through history instead of toggling between the last two versions.
 */
export function pickRevertTarget(eventsOldestFirst: readonly StepCopyEvent[]): StepCopyEvent | null {
    const stack: StepCopyEvent[] = []
    for (const event of eventsOldestFirst) {
        if (event.action === STEP_COPY_UPDATED_ACTION) stack.push(event)
        else stack.pop()
    }
    return stack.length > 0 ? stack[stack.length - 1] : null
}

function asSnapshot(value: unknown): StepSnapshot {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as StepSnapshot : {}
}

/**
 * Edit/revert events for one step of one campaign, oldest first (the most recent 200 at most).
 * Org-scoped like every other query in the gateway. Pass the transaction as `executor` when the
 * read must see the same snapshot as the write that follows.
 */
export async function loadStepCopyEvents(
    executor: StepCopyEventReader,
    input: { organizationId: string; campaignId: string; stepOrder: number },
): Promise<StepCopyEvent[]> {
    const rows = await executor
        .select({
            action: outreachAgentAuditLog.action,
            metadata: outreachAgentAuditLog.metadata,
            createdAt: outreachAgentAuditLog.createdAt,
        })
        .from(outreachAgentAuditLog)
        .where(and(
            eq(outreachAgentAuditLog.organizationId, input.organizationId),
            eq(outreachAgentAuditLog.resourceType, 'campaign'),
            eq(outreachAgentAuditLog.resourceId, input.campaignId),
            eq(outreachAgentAuditLog.outcome, 'success'),
            inArray(outreachAgentAuditLog.action, [STEP_COPY_UPDATED_ACTION, STEP_COPY_REVERTED_ACTION]),
            sql`${outreachAgentAuditLog.metadata}->>'stepOrder' = ${String(input.stepOrder)}`,
        ))
        .orderBy(desc(outreachAgentAuditLog.createdAt))
        .limit(MAX_EVENTS_READ)

    return rows
        .map((row) => ({
            action: row.action as StepCopyEvent['action'],
            before: asSnapshot(row.metadata?.before),
            after: asSnapshot(row.metadata?.after),
            createdAt: row.createdAt,
        }))
        .reverse()
}
