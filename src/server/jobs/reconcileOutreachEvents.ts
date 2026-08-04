import { queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'

const log = createLogger('outreach.events.reconcile')
const BATCH_SIZE = 500

/**
 * Repair the small crash window between a domain-state commit and its outbox insert. The live
 * publishers are the fast path; this bounded anti-join is the restart-safe guarantee. A short
 * lookback avoids replaying the entire historical database during first rollout.
 */
export async function reconcileOutreachEvents(): Promise<number> {
    const configured = Number(process.env.OUTREACH_EVENT_RECONCILE_LOOKBACK_HOURS || 6)
    const lookbackHours = Number.isFinite(configured) ? Math.min(720, Math.max(1, configured)) : 6
    const rows = await queryClient`
        WITH candidates AS (
            SELECT
                outreach_email.organization_id,
                'sent:' || outreach_email.id::text AS deduplication_key,
                'outreach.sent' AS event_type,
                'lead' AS aggregate_type,
                campaign_lead.lead_id::text AS aggregate_id,
                jsonb_strip_nulls(jsonb_build_object(
                    'email', lead.email,
                    'campaign_id', outreach_email.campaign_id,
                    'lead_id', campaign_lead.lead_id,
                    'outreach_email_id', outreach_email.id,
                    'customFields', lead.custom_fields
                )) AS payload,
                outreach_email.sent_at AS occurred_at,
                true AS xphere_delivery_enabled
            FROM outreach_emails AS outreach_email
            JOIN campaign_leads AS campaign_lead ON campaign_lead.id = outreach_email.campaign_lead_id
            JOIN leads AS lead ON lead.id = campaign_lead.lead_id
            WHERE outreach_email.sent_at IS NOT NULL
              AND outreach_email.sent_at >= now() - (${lookbackHours} * interval '1 hour')

            UNION ALL

            SELECT outreach_email.organization_id, 'opened:' || outreach_email.id::text,
                'outreach.opened', 'lead', campaign_lead.lead_id::text,
                jsonb_strip_nulls(jsonb_build_object('email', lead.email, 'campaign_id', outreach_email.campaign_id,
                    'lead_id', campaign_lead.lead_id, 'outreach_email_id', outreach_email.id, 'customFields', lead.custom_fields)),
                outreach_email.opened_at, true
            FROM outreach_emails AS outreach_email
            JOIN campaign_leads AS campaign_lead ON campaign_lead.id = outreach_email.campaign_lead_id
            JOIN leads AS lead ON lead.id = campaign_lead.lead_id
            WHERE outreach_email.opened_at IS NOT NULL
              AND outreach_email.opened_at >= now() - (${lookbackHours} * interval '1 hour')

            UNION ALL

            SELECT outreach_email.organization_id, 'clicked:' || outreach_email.id::text,
                'outreach.clicked', 'lead', campaign_lead.lead_id::text,
                jsonb_strip_nulls(jsonb_build_object('email', lead.email, 'campaign_id', outreach_email.campaign_id,
                    'lead_id', campaign_lead.lead_id, 'outreach_email_id', outreach_email.id, 'customFields', lead.custom_fields)),
                outreach_email.clicked_at, true
            FROM outreach_emails AS outreach_email
            JOIN campaign_leads AS campaign_lead ON campaign_lead.id = outreach_email.campaign_lead_id
            JOIN leads AS lead ON lead.id = campaign_lead.lead_id
            WHERE outreach_email.clicked_at IS NOT NULL
              AND outreach_email.clicked_at >= now() - (${lookbackHours} * interval '1 hour')

            UNION ALL

            SELECT outreach_email.organization_id, 'replied:' || outreach_email.id::text,
                'outreach.replied', 'lead', campaign_lead.lead_id::text,
                jsonb_strip_nulls(jsonb_build_object('email', lead.email, 'campaign_id', outreach_email.campaign_id,
                    'lead_id', campaign_lead.lead_id, 'outreach_email_id', outreach_email.id, 'customFields', lead.custom_fields)),
                outreach_email.replied_at, coalesce(setting.notify_on_reply, true)
            FROM outreach_emails AS outreach_email
            JOIN campaign_leads AS campaign_lead ON campaign_lead.id = outreach_email.campaign_lead_id
            JOIN leads AS lead ON lead.id = campaign_lead.lead_id
            LEFT JOIN outreach_settings AS setting ON setting.organization_id = outreach_email.organization_id
            WHERE outreach_email.replied_at IS NOT NULL
              AND outreach_email.replied_at >= now() - (${lookbackHours} * interval '1 hour')

            UNION ALL

            SELECT outreach_email.organization_id, 'bounced:' || outreach_email.id::text,
                'outreach.bounced', 'lead', campaign_lead.lead_id::text,
                jsonb_strip_nulls(jsonb_build_object('email', lead.email, 'campaign_id', outreach_email.campaign_id,
                    'lead_id', campaign_lead.lead_id, 'outreach_email_id', outreach_email.id, 'customFields', lead.custom_fields)),
                outreach_email.bounced_at, coalesce(setting.notify_on_bounce, true)
            FROM outreach_emails AS outreach_email
            JOIN campaign_leads AS campaign_lead ON campaign_lead.id = outreach_email.campaign_lead_id
            JOIN leads AS lead ON lead.id = campaign_lead.lead_id
            LEFT JOIN outreach_settings AS setting ON setting.organization_id = outreach_email.organization_id
            WHERE outreach_email.bounced_at IS NOT NULL
              AND outreach_email.bounced_at >= now() - (${lookbackHours} * interval '1 hour')

            UNION ALL

            SELECT outreach_email.organization_id, 'unsubscribed:' || campaign_lead.id::text,
                'outreach.unsubscribed', 'lead', campaign_lead.lead_id::text,
                jsonb_strip_nulls(jsonb_build_object('email', lead.email, 'campaign_id', outreach_email.campaign_id,
                    'lead_id', campaign_lead.lead_id, 'outreach_email_id', outreach_email.id, 'customFields', lead.custom_fields)),
                outreach_email.unsubscribed_at, coalesce(setting.notify_on_unsubscribe, true)
            FROM outreach_emails AS outreach_email
            JOIN campaign_leads AS campaign_lead ON campaign_lead.id = outreach_email.campaign_lead_id
            JOIN leads AS lead ON lead.id = campaign_lead.lead_id
            LEFT JOIN outreach_settings AS setting ON setting.organization_id = outreach_email.organization_id
            WHERE outreach_email.unsubscribed_at IS NOT NULL
              AND outreach_email.unsubscribed_at >= now() - (${lookbackHours} * interval '1 hour')
        )
        INSERT INTO outreach_event_outbox (
            organization_id, deduplication_key, event_type, schema_version,
            aggregate_type, aggregate_id, payload, occurred_at, xphere_delivery_enabled
        )
        SELECT organization_id, deduplication_key, event_type, 1,
            aggregate_type, aggregate_id, payload, occurred_at, xphere_delivery_enabled
        FROM candidates
        ORDER BY occurred_at, deduplication_key
        LIMIT ${BATCH_SIZE}
        ON CONFLICT (organization_id, deduplication_key) DO NOTHING
        RETURNING id
    `
    if (rows.length > 0) {
        log.info({ action: 'outreach.events.reconciled', count: rows.length, lookbackHours }, 'repaired missing outbox events')
    }
    return rows.length
}

export async function runOutreachEventReconciliationWithLock(): Promise<void> {
    await runWithLock('reconcileOutreachEvents', reconcileOutreachEvents)
}
