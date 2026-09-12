/**
 * Fase 1 Part A.3 (docs/outbound-authentication-audit.md) — PURE rate arithmetic, split out of
 * dmarc-query.ts for the same reason `outreach-silence.ts` carries no `db` import: a module
 * that never touches the database can be imported by a test (or by anything else) without
 * requiring `DATABASE_URL` to be set at all. `dmarc-query.ts` is the I/O half that fetches
 * `DmarcRateCounts` from `dmarc_report_records` and imports THIS module, never the other way
 * around.
 *
 * Three separate numbers on purpose, matching the distinction dmarc-parser.ts's module doc
 * makes between raw and aligned results:
 *   - dkimPassRate / spfPassRate: the RAW validation result (auth_results/dkim,spf) — "did the
 *     signature verify at all", regardless of which domain it verified against.
 *   - dmarcPassRate: the ALIGNED verdict (policy_evaluated/dkim,spf) — "did DMARC itself pass",
 *     which requires the passing mechanism's domain to align with header_from. A message can
 *     have dkimPassRate=100% and dmarcPassRate=0% (a forwarder's own valid signature, wrong
 *     domain) — collapsing these into one number would hide exactly that case.
 */

export interface DmarcRateCounts {
    totalMessages: number
    dkimPassMessages: number
    spfPassMessages: number
    /** message_count where EITHER policy_evaluated/dkim OR policy_evaluated/spf is 'pass' — per
     *  RFC 7489, DMARC passes if either aligned mechanism passes. */
    dmarcAlignedMessages: number
}

export interface DmarcAuthenticationRates {
    totalMessages: number
    /** null (not 0) when totalMessages is 0 — no reports yet is a different answer from "0% of
     *  reported mail passed", and the audit's whole point is that the two must never be
     *  confused. See outreach-silence.ts's founding comment: zero is a valid value. */
    dkimPassRate: number | null
    spfPassRate: number | null
    dmarcPassRate: number | null
}

/** Turns raw counts into rates without ever dividing by zero or silently reporting "0%" for
 *  "no data". */
export function computeDmarcAuthenticationRates(counts: DmarcRateCounts): DmarcAuthenticationRates {
    if (counts.totalMessages <= 0) {
        return { totalMessages: 0, dkimPassRate: null, spfPassRate: null, dmarcPassRate: null }
    }
    return {
        totalMessages: counts.totalMessages,
        dkimPassRate: counts.dkimPassMessages / counts.totalMessages,
        spfPassRate: counts.spfPassMessages / counts.totalMessages,
        dmarcPassRate: counts.dmarcAlignedMessages / counts.totalMessages,
    }
}
