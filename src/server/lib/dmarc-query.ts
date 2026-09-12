/**
 * Fase 1 Part A.3 (docs/outbound-authentication-audit.md) — I/O half of the DMARC rate query.
 * The arithmetic itself (`computeDmarcAuthenticationRates`) is pure and lives in
 * `dmarc-rates.ts`, re-exported here for convenience — this module is the one that actually
 * touches `db`, same split `outreach-silence.ts`/`outreach-silence-query.ts` use and for the
 * same reason (a module with no `db` import needs no `DATABASE_URL` to test or even load).
 */

import { sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    computeDmarcAuthenticationRates,
    type DmarcAuthenticationRates,
    type DmarcRateCounts,
} from './dmarc-rates'

export {
    computeDmarcAuthenticationRates,
    type DmarcAuthenticationRates,
    type DmarcRateCounts,
} from './dmarc-rates'

/**
 * Sums `message_count` (a report row already represents N real messages from one source IP,
 * per RFC 7489 — not one row per message) across every record whose `header_from` matches
 * `domain` and whose parent report's date range OVERLAPS [since, until) at all, not only
 * reports fully contained within it — a report spanning midnight UTC should still count toward
 * a same-day query.
 */
export async function fetchDmarcRateCounts(domain: string, since: Date, until: Date): Promise<DmarcRateCounts> {
    const normalizedDomain = domain.trim().toLowerCase()

    const raw = await db.execute(sql`
        SELECT
            coalesce(sum(r.message_count), 0)::bigint AS total_messages,
            coalesce(sum(r.message_count) FILTER (WHERE r.dkim_result = 'pass'), 0)::bigint AS dkim_pass_messages,
            coalesce(sum(r.message_count) FILTER (WHERE r.spf_result = 'pass'), 0)::bigint AS spf_pass_messages,
            coalesce(sum(r.message_count) FILTER (
                WHERE r.policy_dkim_aligned = 'pass' OR r.policy_spf_aligned = 'pass'
            ), 0)::bigint AS dmarc_aligned_messages
        FROM dmarc_report_records r
        JOIN dmarc_reports rep ON rep.id = r.report_id
        WHERE r.header_from = ${normalizedDomain}
          AND rep.date_range_begin < ${until.toISOString()}
          AND rep.date_range_end >= ${since.toISOString()}
    `)

    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>
    const row = rows[0] ?? {}
    const n = (key: string) => Number(row[key] ?? 0)

    return {
        totalMessages: n('total_messages'),
        dkimPassMessages: n('dkim_pass_messages'),
        spfPassMessages: n('spf_pass_messages'),
        dmarcAlignedMessages: n('dmarc_aligned_messages'),
    }
}

export async function computeDmarcAuthenticationRatesForDomain(
    domain: string,
    since: Date,
    until: Date,
): Promise<DmarcAuthenticationRates> {
    const counts = await fetchDmarcRateCounts(domain, since, until)
    return computeDmarcAuthenticationRates(counts)
}
