import { and, asc, eq, isNull, lt, lte, sql } from 'drizzle-orm'
import { db } from '../../db'
import { outreachEventOutbox } from '../../db/schema'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 10
const BATCH_SIZE = 50
const log = createLogger('outreach.events')

function retryAt(attempt: number): Date {
    const delayMinutes = Math.min(360, 2 ** Math.max(0, attempt - 1))
    return new Date(Date.now() + delayMinutes * 60_000)
}

export async function deliverOutreachEventsToXphere(): Promise<void> {
    const url = process.env.XPHERE_EVENTS_URL?.trim()
    const apiKey = process.env.XPHERE_EVENTS_API_KEY?.trim()
    if (!url || !apiKey) return

    const events = await db.query.outreachEventOutbox.findMany({
        where: and(
            isNull(outreachEventOutbox.xphereDeliveredAt),
            eq(outreachEventOutbox.xphereDeliveryEnabled, true),
            lt(outreachEventOutbox.xphereAttempts, MAX_ATTEMPTS),
            lte(outreachEventOutbox.xphereNextAttemptAt, new Date()),
            // Preserve order inside one aggregate while unrelated leads/campaigns continue.
            sql`NOT EXISTS (
                SELECT 1
                FROM outreach_event_outbox AS prior
                WHERE prior.organization_id = outreach_event_outbox.organization_id
                  AND prior.aggregate_type = outreach_event_outbox.aggregate_type
                  AND prior.aggregate_id = outreach_event_outbox.aggregate_id
                  AND prior.xphere_delivery_enabled = true
                  AND prior.xphere_delivered_at IS NULL
                  AND prior.sequence_number < outreach_event_outbox.sequence_number
            )`,
        ),
        orderBy: [asc(outreachEventOutbox.sequenceNumber)],
        limit: BATCH_SIZE,
    })

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
    await runWithLock('deliverOutreachEventsToXphere', deliverOutreachEventsToXphere)
}
