import { and, asc, count, eq, isNull, lt, lte, notExists } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../../db'
import { outreachEventOutbox } from '../../db/schema'
import { JOB_TIMEOUT_BUDGETS_MS, runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'

const REQUEST_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 10
const BATCH_SIZE = 50
const log = createLogger('outreach.events')

/**
 * How often the benign "config missing, but the outbox is empty anyway" state is logged.
 *
 * This job runs every minute (jobs/index.ts); logging that observation every tick would just be
 * log-spam for a state nobody needs to act on (see error-spike-alert.ts's BASELINE_LOG_INTERVAL_MS
 * for the same "don't repeat a benign observation every tick" shape, and ops-alert.ts's REPEAT_MS
 * for the same idea applied to a real alert). One hour is long enough that a human tailing logs
 * still sees it eventually, short enough that a genuinely-forgotten config isn't invisible for a
 * whole day.
 */
const MISSING_CONFIG_LOG_INTERVAL_MS = 60 * 60_000

/** Test seam — this module-level timestamp is process-global, so tests must be able to reset it. */
export function __resetDeliverOutreachEventsLogState(): void {
    lastMissingConfigLogAt = 0
}

let lastMissingConfigLogAt = 0

function retryAt(attempt: number): Date {
    const delayMinutes = Math.min(360, 2 ** Math.max(0, attempt - 1))
    return new Date(Date.now() + delayMinutes * 60_000)
}

/**
 * Count of rows still owed a delivery attempt, regardless of attempt count or backoff schedule —
 * this is used only to tell "config missing, nothing pending" (benign) apart from "config
 * missing, events piling up" (silent event loss), so it deliberately ignores the
 * xphereAttempts/xphereNextAttemptAt gating that `buildDeliverableOutreachEventsQuery` applies.
 */
async function countPendingXphereEvents(): Promise<number> {
    const [row] = await db.select({ value: count() })
        .from(outreachEventOutbox)
        .where(and(
            eq(outreachEventOutbox.xphereDeliveryEnabled, true),
            isNull(outreachEventOutbox.xphereDeliveredAt),
        ))
    return Number(row?.value ?? 0)
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
    if (!url || !apiKey) {
        const pending = await countPendingXphereEvents()
        if (pending > 0) {
            // Noisy on purpose, every tick: this is silent event loss, not a benign idle state —
            // events are piling up in the outbox and NOTHING is retrying them while config is
            // missing. outreach-silence.ts's xphere_events_undelivered rule is what makes this
            // reach the ops watchdog/Telegram; this log line is the process-local half of the
            // same signal (grep-able without waiting for that check's own cadence).
            log.error({
                action: 'outreach.events.xphere_config_missing_with_pending_events',
                pendingEvents: pending,
            }, 'XPHERE_EVENTS_URL/XPHERE_EVENTS_API_KEY is not configured and outreach_event_outbox '
                + 'has undelivered event(s) — they will not be retried until the config is restored')
        } else {
            // Benign: nothing pending, so a missing config is costing nothing right now. Still
            // worth a low-level breadcrumb (not a day-one guess: see MISSING_CONFIG_LOG_INTERVAL_MS),
            // throttled so it doesn't repeat every minute.
            const now = Date.now()
            if (now - lastMissingConfigLogAt >= MISSING_CONFIG_LOG_INTERVAL_MS) {
                lastMissingConfigLogAt = now
                log.info({
                    action: 'outreach.events.xphere_config_missing',
                }, 'XPHERE_EVENTS_URL/XPHERE_EVENTS_API_KEY is not configured; outreach_event_outbox '
                    + 'has no pending events so this is currently benign')
            }
        }
        return
    }

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
