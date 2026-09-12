/**
 * A metade com I/O da detecção de silêncio. Separada de `outreach-silence.ts` de propósito: aquele
 * módulo não importa `db`, então `buildSilenceAlerts` é testável direto, sem banco nem stub — o
 * mesmo padrão que `prospecting/external-run.ts` já documenta e usa.
 */

import { sql } from 'drizzle-orm'
import { db } from '../../db'
import { computeLockKey, getInFlightJobs, getRecentJobTimeouts, KNOWN_LOCK_NAMES } from './cron-lock'
import { resolveDailyBudgetUsd } from './prospecting/daily-territory-budget'
import {
    ANALYZER_STALLED_EVENT_WINDOW_HOURS,
    ENRICHED_ZERO_EMAILS_LOOKBACK_DAYS,
    OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER,
    VERIFICATION_MISSING_RUN_AGE_HOURS,
    type SilenceMetrics,
} from './outreach-silence'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS
/** Janela do check "funil parado" — ver FUNNEL_STALLED_RUN_AGE_DAYS em outreach-silence.ts. */
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS
/** Janela do check de custo sem preço — o suficiente para cobrir uma amortização mensal inteira. */
const THIRTY_FIVE_DAYS_MS = 35 * ONE_DAY_MS

/**
 * `runWithLock` (cron-lock.ts) now bounds every job body to at most 10 minutes by default (some
 * jobs override tighter). A session still `idle in transaction` holding an advisory lock past
 * this threshold means that safety net itself did not fire — the process died between acquiring
 * the lock and starting the timer, `fn()` outlived a timeout whose own `finally` never got to
 * run (e.g. the process was killed), or something outside `runWithLock` altogether is holding a
 * SESSION-scoped `pg_advisory_lock` on the same key. 15 minutes gives every current per-job
 * override (2/8/10 minutes) comfortable room before this fires, so it only trips on a genuine
 * stall, never on a slow-but-normal run.
 */
const STALE_LOCK_THRESHOLD_MS = 15 * 60 * 1000

/** Same UTC-midnight boundary runDailyProspecting.ts's `startOfTodayUtc` uses for "today's
 *  spend" -- the two must agree, or the digest/silence check would disagree with the engine
 *  that actually enforces the budget about what "today" means. */
function startOfTodayUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export async function computeSilenceMetrics(now: Date = new Date()): Promise<SilenceMetrics> {
    const cutoff24h = new Date(now.getTime() - ONE_DAY_MS).toISOString()
    const cutoff7d = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString()
    const cutoff35d = new Date(now.getTime() - THIRTY_FIVE_DAYS_MS).toISOString()
    const staleLockCutoff = new Date(now.getTime() - STALE_LOCK_THRESHOLD_MS).toISOString()
    // Fase 34 (verification_missing) -- see VERIFICATION_MISSING_RUN_AGE_HOURS in outreach-silence.ts.
    const verificationMissingCutoff = new Date(now.getTime() - VERIFICATION_MISSING_RUN_AGE_HOURS * ONE_HOUR_MS).toISOString()
    // Fase 40 -- see the threshold constants' own doc comments in outreach-silence.ts.
    const startOfTodayIso = startOfTodayUtc(now).toISOString()
    const enrichedZeroEmailsCutoff = new Date(now.getTime() - ENRICHED_ZERO_EMAILS_LOOKBACK_DAYS * ONE_DAY_MS).toISOString()
    const analyzerStalledCutoff = new Date(now.getTime() - ANALYZER_STALLED_EVENT_WINDOW_HOURS * ONE_HOUR_MS).toISOString()
    const dailyBudgetUsd = resolveDailyBudgetUsd()

    const raw = await db.execute(sql`
        SELECT
            (SELECT count(*) FROM email_accounts
                WHERE warmup_source = 'internal' AND status = 'verified') AS warmup_eligible_inboxes,
            -- Reconstructs the original 64-bit computeLockKey value from the two 32-bit halves
            -- Postgres splits a single-argument advisory lock into (see cron-lock.ts). Grouped
            -- into one jsonb array here (rather than a scalar count) because the message needs to
            -- name each stuck job, not just say how many. jsonb_agg over zero rows is NULL, not
            -- an empty array -- normalized to [] in JS below.
            (SELECT jsonb_agg(jsonb_build_object(
                        'lockKey', (l.classid::bigint << 32) | l.objid::bigint,
                        'heldForSeconds', extract(epoch from (${now.toISOString()}::timestamptz - a.state_change))::bigint
                    ))
                FROM pg_locks l
                JOIN pg_stat_activity a ON a.pid = l.pid
                WHERE l.locktype = 'advisory'
                  AND l.granted = true
                  AND a.state = 'idle in transaction'
                  AND a.state_change <= ${staleLockCutoff}) AS stale_advisory_locks,
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
            -- Fase 34 (kind: verification_missing) -- see VERIFICATION_MISSING_RUN_AGE_HOURS in
            -- outreach-silence.ts. One step further than enriched_runs_without_enrichment_count:
            -- enrichment happened here (enriched_count > 0), but verification never landed.
            (SELECT count(*) FROM prospecting_runs
                WHERE status = 'imported'
                  AND search_filters ->> 'template' = 'enriched'
                  AND coalesce(enriched_count, 0) > 0
                  AND verified_at IS NULL
                  AND created_at < ${verificationMissingCutoff}) AS verification_missing_runs,
            (SELECT count(*) FROM leads
                WHERE jsonb_typeof(custom_fields) = 'string') AS bad_leads_custom_fields,
            (SELECT count(*) FROM mail_messages
                WHERE jsonb_typeof(to_addresses) = 'string') AS bad_mail_to_addresses,
            (SELECT count(*) FROM mail_messages
                WHERE jsonb_typeof(headers) = 'string') AS bad_mail_headers,
            (SELECT count(*) FROM outreach_provider_events
                WHERE jsonb_typeof(to_addresses) = 'string') AS bad_event_to_addresses,
            -- Funnel stalled (kind: funnel_stalled) -- see FUNNEL_STALLED_RUN_AGE_DAYS in
            -- outreach-silence.ts. Same source_run_id join as measureProspectingOutcomes.ts,
            -- just over a 7-day window instead of 24h.
            (SELECT count(*) FROM prospecting_runs r
                WHERE r.created_at < ${cutoff7d}
                  AND NOT EXISTS (
                      SELECT 1 FROM leads l
                      WHERE l.custom_fields ->> 'source_run_id' = r.idempotency_key
                  )) AS stale_prospecting_runs_without_leads,
            (SELECT coalesce(max(extract(epoch from (${now.toISOString()}::timestamptz - r.created_at)) / 86400), 0)::int
                FROM prospecting_runs r
                WHERE r.created_at < ${cutoff7d}
                  AND NOT EXISTS (
                      SELECT 1 FROM leads l
                      WHERE l.custom_fields ->> 'source_run_id' = r.idempotency_key
                  )) AS oldest_stale_prospecting_run_days,
            (SELECT count(*) FROM email_accounts
                WHERE warmup_source = 'internal' AND status = 'verified'
                  AND warmup_current_day >= warmup_days) AS ramped_warmup_inboxes,
            (SELECT count(*) FROM outreach_emails
                WHERE sent_at IS NOT NULL AND sent_at >= ${cutoff7d}) AS outreach_sends_7d,
            -- Unpriced cost (kind: unpriced_cost_share) -- see UNPRICED_COST_SHARE_THRESHOLD in
            -- outreach-silence.ts. 35-day window to span one full monthly amortization.
            (SELECT count(*) FROM outreach_cost_entries
                WHERE occurred_at >= ${cutoff35d}) AS cost_entries_35d,
            (SELECT count(*) FROM outreach_cost_entries
                WHERE occurred_at >= ${cutoff35d}
                  AND detail ->> 'rate_missing' = 'true') AS unpriced_cost_entries_35d,
            (SELECT coalesce(jsonb_agg(DISTINCT category), '[]'::jsonb) FROM outreach_cost_entries
                WHERE occurred_at >= ${cutoff35d}
                  AND detail ->> 'rate_missing' = 'true') AS unpriced_cost_categories_35d,
            -- Fase 40 (kind: engine_idle_with_budget) -- see ENGINE_IDLE_CHECK_AFTER_UTC_HOUR in
            -- outreach-silence.ts. Same boundary/category runDailyProspecting.ts's
            -- fetchSpentTodayUsd uses, but org-wide rather than per-organization.
            (SELECT count(*) FROM outreach_cost_entries
                WHERE category = 'lead_source' AND occurred_at >= ${startOfTodayIso}) AS lead_source_cost_entries_today,
            (SELECT coalesce(sum(amount_micros), 0)::bigint FROM outreach_cost_entries
                WHERE category = 'lead_source' AND occurred_at >= ${startOfTodayIso}) AS spent_today_micros,
            (SELECT count(*) FROM prospecting_territories WHERE status = 'queued') AS queued_territories,
            -- Fase 40 (kind: enriched_zero_emails) -- see ENRICHED_ZERO_EMAILS_LOOKBACK_DAYS in
            -- outreach-silence.ts. Unlike enriched_runs_without_enrichment_count above (no
            -- status/age filter at all), this is scoped to COMPLETED runs only, so an
            -- in-flight scrape that has not reached the enrichment step yet is never counted.
            (SELECT count(*) FROM prospecting_runs
                WHERE status = 'imported'
                  AND search_filters ->> 'template' = 'enriched'
                  AND coalesce(enriched_count, 0) = 0
                  AND created_at >= ${enrichedZeroEmailsCutoff}) AS enriched_zero_email_runs,
            -- Fase 40 (kind: territory_queue_empty).
            (SELECT count(*) FROM prospecting_territories) AS total_territories,
            (SELECT count(*) FROM prospecting_territories WHERE status IN ('queued', 'running')) AS active_territories,
            -- Fase 40 (kind: analyzer_stalled) -- DORMANT, see analyzerStalledEvents24h's own
            -- doc comment in outreach-silence.ts. 'analyze.stalled' is not a code anything in
            -- Xmail ever writes today; this always reads 0 until Xphere starts sending it.
            (SELECT count(*) FROM prospecting_run_events
                WHERE code = 'analyze.stalled' AND occurred_at >= ${analyzerStalledCutoff}) AS analyzer_stalled_events_24h,
            -- Fase 5 (kind: warmup_spam_rate_rising) -- see WARMUP_SPAM_RATE_THRESHOLD in
            -- outreach-silence.ts. EXTERNAL destination only (email_accounts.provider != 'native'
            -- means a real mailbox monitored over IMAP, not our own mx-server): a native-to-native
            -- or Gmail-to-native send always reads 0% and always will, because our own server
            -- judges its own inbound mail.
            (SELECT count(*) FROM warmup_messages wm
                JOIN email_accounts ea ON ea.id = wm.to_account_id
                WHERE wm.sent_at >= ${cutoff24h}
                  AND wm.detected_folder IS NOT NULL
                  AND ea.provider != 'native') AS external_warmup_messages_with_folder_24h,
            (SELECT count(*) FROM warmup_messages wm
                JOIN email_accounts ea ON ea.id = wm.to_account_id
                WHERE wm.sent_at >= ${cutoff24h}
                  AND wm.detected_folder = 'spam'
                  AND ea.provider != 'native') AS external_warmup_spam_messages_24h,
            -- Fase 5 (kind: dmarc_report_gap) -- see DMARC_REPORT_GAP_HOURS in outreach-silence.ts.
            (SELECT count(*) FROM dmarc_reports) AS total_dmarc_reports_ever,
            (SELECT max(created_at) FROM dmarc_reports) AS last_dmarc_report_processed_at,
            -- Fase 5 (kind: outbound_dkim_unverified) -- DORMANT, see
            -- OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER in outreach-silence.ts. Checked against both
            -- tables an outbound self-verify step in native-send.ts could plausibly report
            -- through (it is shared by warm-up AND outreach sends, per CLAUDE.md) -- always 0
            -- until that marker exists anywhere.
            (SELECT count(*) FROM warmup_messages
                WHERE updated_at >= ${cutoff24h}
                  AND last_error ILIKE ${'%' + OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER + '%'}) AS outbound_dkim_unverified_warmup_24h,
            (SELECT count(*) FROM outreach_emails
                WHERE updated_at >= ${cutoff24h}
                  AND last_error_code ILIKE ${'%' + OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER + '%'}) AS outbound_dkim_unverified_outreach_24h,
            -- kind: xphere_events_undelivered -- see XPHERE_EVENT_STUCK_AGE_MINUTES in
            -- outreach-silence.ts. oldest_pending_xphere_event_minutes is only meaningful when
            -- pending_xphere_events > 0 (coalesced to 0 otherwise); the JS layer below turns that
            -- into null so an empty, healthy outbox never evaluates the threshold at all.
            (SELECT count(*) FROM outreach_event_outbox
                WHERE xphere_delivery_enabled = true AND xphere_delivered_at IS NULL) AS pending_xphere_events,
            (SELECT coalesce(max(extract(epoch from (${now.toISOString()}::timestamptz - occurred_at)) / 60), 0)::int
                FROM outreach_event_outbox
                WHERE xphere_delivery_enabled = true AND xphere_delivered_at IS NULL) AS oldest_pending_xphere_event_minutes
    `)

    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>
    const row = rows[0] ?? {}
    const n = (key: string) => Number(row[key] ?? 0)

    const doubleEncoded: string[] = []
    if (n('bad_leads_custom_fields') > 0) doubleEncoded.push('leads.custom_fields')
    if (n('bad_mail_to_addresses') > 0) doubleEncoded.push('mail_messages.to_addresses')
    if (n('bad_mail_headers') > 0) doubleEncoded.push('mail_messages.headers')
    if (n('bad_event_to_addresses') > 0) doubleEncoded.push('outreach_provider_events.to_addresses')

    // computeLockKey is one-way (SHA-256), so the only way to name a stuck lock is to hash every
    // known job name ourselves and match on the resulting key.
    const lockKeyToJobName = new Map(KNOWN_LOCK_NAMES.map((name) => [computeLockKey(name).toString(), name]))
    const staleLocksRaw = (row['stale_advisory_locks'] ?? []) as Array<{ lockKey: string | number; heldForSeconds: string | number }>
    const staleAdvisoryLocks = staleLocksRaw.map((lock) => {
        const lockKey = String(lock.lockKey)
        return {
            jobName: lockKeyToJobName.get(lockKey) ?? `unknown lock (key ${lockKey})`,
            heldForSeconds: Number(lock.heldForSeconds),
        }
    })

    const unpricedCostCategories = (row['unpriced_cost_categories_35d'] ?? []) as string[]

    return {
        warmupEligibleInboxes: n('warmup_eligible_inboxes'),
        warmupSends24h: n('warmup_sends_24h'),
        credentialKeyMismatches24h: n('credential_key_mismatches_24h'),
        enrichedRunsWithoutLeads: n('enriched_runs_without_leads'),
        enrichedRunsWithoutEnrichmentCount: n('enriched_runs_without_enrichment_count'),
        verificationMissingRuns: n('verification_missing_runs'),
        doubleEncodedJsonbColumns: doubleEncoded,
        // In-memory, not SQL -- see JOB_TIMEOUT_RATE_THRESHOLD_PER_HOUR in outreach-silence.ts.
        recentJobTimeouts: getRecentJobTimeouts(now),
        // In-memory, not SQL -- see ORPHANED_JOBS_THRESHOLD in outreach-silence.ts.
        inFlightJobs: getInFlightJobs(now),
        staleProspectingRunsWithoutLeads: n('stale_prospecting_runs_without_leads'),
        oldestStaleProspectingRunAgeDays: n('oldest_stale_prospecting_run_days'),
        rampedWarmupInboxes: n('ramped_warmup_inboxes'),
        outreachSends7d: n('outreach_sends_7d'),
        costEntries35d: n('cost_entries_35d'),
        unpricedCostEntries35d: n('unpriced_cost_entries_35d'),
        unpricedCostCategories,
        staleAdvisoryLocks,
        // Fase 40.
        leadSourceCostEntriesToday: n('lead_source_cost_entries_today'),
        spentTodayUsd: n('spent_today_micros') / 1_000_000,
        dailyBudgetUsd,
        queuedTerritories: n('queued_territories'),
        enrichedZeroEmailRuns: n('enriched_zero_email_runs'),
        totalTerritories: n('total_territories'),
        activeTerritories: n('active_territories'),
        analyzerStalledEvents24h: n('analyzer_stalled_events_24h'),
        // Fase 5.
        externalWarmupMessagesWithFolder24h: n('external_warmup_messages_with_folder_24h'),
        externalWarmupSpamMessages24h: n('external_warmup_spam_messages_24h'),
        totalDmarcReportsEver: n('total_dmarc_reports_ever'),
        lastDmarcReportProcessedAt: row['last_dmarc_report_processed_at']
            ? new Date(row['last_dmarc_report_processed_at'] as string)
            : null,
        // DORMANT until Fase 2 lands -- see OUTBOUND_DKIM_UNVERIFIED_ERROR_MARKER.
        outboundDkimUnverified24h: n('outbound_dkim_unverified_warmup_24h') + n('outbound_dkim_unverified_outreach_24h'),
        // kind: xphere_events_undelivered -- see XPHERE_EVENT_STUCK_AGE_MINUTES.
        pendingXphereEvents: n('pending_xphere_events'),
        oldestPendingXphereEventAgeMinutes: n('pending_xphere_events') > 0
            ? n('oldest_pending_xphere_event_minutes')
            : null,
    }
}
