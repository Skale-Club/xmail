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
    // JSON vai como TEXTO com cast explicito ::jsonb, direto no postgres-js (sem o mapper jsonb do
    // Drizzle, que era o que codificava duas vezes). NAO usar queryClient.json(): com a configuracao
    // deste cliente (prepare: false) ele chega ao bind como objeto cru e quebra com 'The "string"
    // argument must be of type string ... Received an instance of Object'. Foi isso que impediu o
    // registro do primeiro envio real de campanha em 2026-10-07; conferido no Postgres de producao
    // que ${JSON.stringify(x)}::jsonb grava um objeto (jsonb_typeof = 'object').
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
            ${JSON.stringify(payload)}::jsonb,
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
