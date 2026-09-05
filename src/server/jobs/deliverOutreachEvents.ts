import { and, asc, eq, isNull, lt, lte, notExists } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../../db'
import { outreachEventOutbox } from '../../db/schema'
import { JOB_TIMEOUT_BUDGETS_MS, runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 10
const BATCH_SIZE = 50
const log = createLogger('outreach.events')

function retryAt(attempt: number): Date {
    const delayMinutes = Math.min(360, 2 ** Math.max(0, attempt - 1))
    return new Date(Date.now() + delayMinutes * 60_000)
}

export function buildDeliverableOutreachEventsQuery(now: Date = new Date()) {
    const priorEvent = alias(outreachEventOutbox, 'prior_outreach_event')

    return db.select()
        .from(outreachEventOutbox)
        .where(and(
            isNull(outreachEventOutbox.xphereDeliveredAt),
            eq(outreachEventOutbox.xphereDeliveryEnabled, true),
            lt(outreachEventOutbox.xphereAttempts, MAX_ATTEMPTS),
            lte(outreachEventOutbox.xphereNextAttemptAt, now),
            // Preserve order inside one aggregate while unrelated leads/campaigns continue.
            notExists(
                db.select({ id: priorEvent.id })
                    .from(priorEvent)
                    .where(and(
                        eq(priorEvent.organizationId, outreachEventOutbox.organizationId),
                        eq(priorEvent.aggregateType, outreachEventOutbox.aggregateType),
                        eq(priorEvent.aggregateId, outreachEventOutbox.aggregateId),
                        eq(priorEvent.xphereDeliveryEnabled, true),
                        isNull(priorEvent.xphereDeliveredAt),
                        lt(priorEvent.sequenceNumber, outreachEventOutbox.sequenceNumber),
                    )),
            ),
        ))
        .orderBy(asc(outreachEventOutbox.sequenceNumber))
        .limit(BATCH_SIZE)
}

export async function deliverOutreachEventsToXphere(): Promise<void> {
    const url = process.env.XPHERE_EVENTS_URL?.trim()
    const apiKey = process.env.XPHERE_EVENTS_API_KEY?.trim()
    if (!url || !apiKey) return

    const events = await buildDeliverableOutreachEventsQuery()

    for (const event of events) {
        const attempt = event.xphereAttempts + 1
        // Move the next-attempt timestamp before I/O. If the process dies mid-request, another
        // tick retries after the lease window instead of immediately double-delivering.
        await db.update(outreachEventOutbox).set({
            xphereAttempts: attempt,
            xphereNextAttemptAt: retryAt(attempt),
        }).where(and(
            eq(outreachEventOutbox.id, event.id),
            isNull(outreachEventOutbox.xphereDeliveredAt),
            eq(outreachEventOutbox.xphereAttempts, event.xphereAttempts),
        ))

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'Idempotency-Key': event.id,
                },
                body: JSON.stringify({
                    id: event.id,
                    sequence: event.sequenceNumber,
                    event: event.eventType.replace(/^outreach\./, ''),
                    schema_version: event.schemaVersion,
                    occurred_at: event.occurredAt.toISOString(),
                    data: event.payload,
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)

            await db.update(outreachEventOutbox).set({
                xphereDeliveredAt: new Date(),
                xphereLastError: null,
            }).where(eq(outreachEventOutbox.id, event.id))
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            await db.update(outreachEventOutbox).set({
                xphereLastError: message.slice(0, 1_000),
            }).where(eq(outreachEventOutbox.id, event.id))
            log.warn({
                action: 'outreach.events.xphere_delivery_failed',
                eventId: event.id,
                attempt,
                error: message,
            }, 'Xphere event delivery failed; retry scheduled')
        }
    }
}

export async function runOutreachEventDeliveryWithLock(): Promise<void> {
    // jobs/index.ts schedules this every minute. 2026-09-04 (Fase 1 TASK 2): previously a 2-minute
    // guess; retuned to the 30s floor — the 0.4s normal latency measured in production is so far
    // below any reasonable budget that 5x it would be too tight (see JOB_TIMEOUT_BUDGETS_MS in
    // cron-lock.ts for the rule and the full table). 30s still lands at half the 60s cadence.
    await runWithLock(
        'deliverOutreachEventsToXphere',
        deliverOutreachEventsToXphere,
        { timeoutMs: JOB_TIMEOUT_BUDGETS_MS.deliverOutreachEventsToXphere },
    )
}
