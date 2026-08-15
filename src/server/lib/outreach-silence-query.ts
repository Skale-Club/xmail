/**
 * A metade com I/O da detecção de silêncio. Separada de `outreach-silence.ts` de propósito: aquele
 * módulo não importa `db`, então `buildSilenceAlerts` é testável direto, sem banco nem stub — o
 * mesmo padrão que `prospecting/external-run.ts` já documenta e usa.
 */

import { sql } from 'drizzle-orm'
import { db } from '../../db'
import type { SilenceMetrics } from './outreach-silence'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export async function computeSilenceMetrics(now: Date = new Date()): Promise<SilenceMetrics> {
    const cutoff24h = new Date(now.getTime() - ONE_DAY_MS).toISOString()

    const raw = await db.execute(sql`
        SELECT
            (SELECT count(*) FROM email_accounts
                WHERE warmup_source = 'internal' AND status = 'verified') AS warmup_eligible_inboxes,
            (SELECT count(*) FROM warmup_messages
                WHERE sent_at IS NOT NULL AND sent_at >= ${cutoff24h}) AS warmup_sends_24h,
            (SELECT count(*) FROM warmup_messages
                WHERE status = 'failed' AND updated_at >= ${cutoff24h}
                  AND last_error ILIKE '%encrypted with a different key%') AS credential_key_mismatches_24h,
            (SELECT count(*) FROM prospecting_runs r
                WHERE r.search_filters ->> 'template' = 'enriched'
                  AND r.created_at < ${cutoff24h}
                  AND NOT EXISTS (
                      SELECT 1 FROM leads l
                      WHERE l.custom_fields ->> 'source_run_id' = r.idempotency_key
                  )) AS enriched_runs_without_leads,
            (SELECT count(*) FROM prospecting_runs
                WHERE search_filters ->> 'template' = 'enriched'
                  AND coalesce(enriched_count, 0) = 0) AS enriched_runs_without_enrichment_count,
            (SELECT count(*) FROM leads
                WHERE jsonb_typeof(custom_fields) = 'string') AS bad_leads_custom_fields,
            (SELECT count(*) FROM mail_messages
                WHERE jsonb_typeof(to_addresses) = 'string') AS bad_mail_to_addresses,
            (SELECT count(*) FROM mail_messages
                WHERE jsonb_typeof(headers) = 'string') AS bad_mail_headers,
            (SELECT count(*) FROM outreach_provider_events
                WHERE jsonb_typeof(to_addresses) = 'string') AS bad_event_to_addresses
    `)

    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>
    const row = rows[0] ?? {}
    const n = (key: string) => Number(row[key] ?? 0)

    const doubleEncoded: string[] = []
    if (n('bad_leads_custom_fields') > 0) doubleEncoded.push('leads.custom_fields')
    if (n('bad_mail_to_addresses') > 0) doubleEncoded.push('mail_messages.to_addresses')
    if (n('bad_mail_headers') > 0) doubleEncoded.push('mail_messages.headers')
    if (n('bad_event_to_addresses') > 0) doubleEncoded.push('outreach_provider_events.to_addresses')

    return {
        warmupEligibleInboxes: n('warmup_eligible_inboxes'),
        warmupSends24h: n('warmup_sends_24h'),
        credentialKeyMismatches24h: n('credential_key_mismatches_24h'),
        enrichedRunsWithoutLeads: n('enriched_runs_without_leads'),
        enrichedRunsWithoutEnrichmentCount: n('enriched_runs_without_enrichment_count'),
        doubleEncodedJsonbColumns: doubleEncoded,
    }
}
