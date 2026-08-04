import { queryClient } from '../../db'
import type postgres from 'postgres'

export interface PublishOutreachEventInput {
    organizationId: string
    eventType: string
    aggregateType: string
    aggregateId: string
    deduplicationKey: string
    payload: Record<string, unknown>
    deliverToXphere?: boolean
}

/** Persist a canonical event. Consumers have independent delivery state. */
export async function publishOutreachEvent(input: PublishOutreachEventInput): Promise<void> {
    const eventType = input.eventType.startsWith('outreach.') ? input.eventType : `outreach.${input.eventType}`
    let payload: postgres.JSONValue
    try {
        payload = JSON.parse(JSON.stringify(input.payload)) as postgres.JSONValue
    } catch {
        throw new Error('Outreach event payload must be JSON serializable')
    }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
        throw new Error('Outreach event payload must be a JSON object')
    }
    // postgres-js owns JSON serialization here. Passing a JSON.stringify() result through
    // Drizzle's jsonb mapper and then postgres-js can encode the value twice as a JSON string
    // scalar, which the outbox's object-only constraint correctly rejects.
    await queryClient`
        INSERT INTO outreach_event_outbox (
            organization_id, deduplication_key, event_type, schema_version,
            aggregate_type, aggregate_id, payload, xphere_delivery_enabled, occurred_at
        ) VALUES (
            ${input.organizationId}::uuid,
            ${input.deduplicationKey},
            ${eventType},
            1,
            ${input.aggregateType},
            ${input.aggregateId},
            ${queryClient.json(payload)},
            ${input.deliverToXphere ?? false},
            NOW()
        )
        ON CONFLICT (organization_id, deduplication_key) DO NOTHING
    `
}

/** Compatibility adapter for existing Xphere notifications, now backed by the durable outbox. */
export async function sendXphereOutreachEvent(
    event: string,
    data: Record<string, unknown>,
    organizationId: string,
): Promise<void> {
    const aggregateId = typeof data.lead_id === 'string'
        ? data.lead_id
        : typeof data.campaign_id === 'string'
            ? data.campaign_id
            : 'unknown'
    const stableEntity = typeof data.outreach_email_id === 'string'
        ? data.outreach_email_id
        : typeof data.campaign_lead_id === 'string'
            ? data.campaign_lead_id
            : `${String(data.campaign_id ?? 'unknown')}:${String(data.lead_id ?? aggregateId)}`
    await publishOutreachEvent({
        organizationId,
        eventType: event,
        aggregateType: typeof data.lead_id === 'string' ? 'lead' : 'campaign',
        aggregateId,
        deduplicationKey: `${event}:${stableEntity}`,
        payload: data,
        deliverToXphere: true,
    })
}
