/**
 * Single source of truth for LEAD-GRAIN outreach metrics (the campaign/dashboard surface).
 *
 * Not to be confused with outreach-metrics.ts, which is the Phase 17 health/digest module and
 * is EMAIL-grain: it aggregates outreach_emails, so a prospect emailed three times counts three
 * times. That is the right grain for deliverability monitoring ("what fraction of sends bounced")
 * and the wrong grain for the campaign UI ("how many prospects opened"). Both are correct; they
 * answer different questions. Keep them separate — do not "deduplicate" one into the other.
 *
 * Phase 20 (CONS-04) makes the denominators explicit and honest:
 *
 *   - `contactedLeads` = unique leads with AT LEAST ONE actually-sent outreach email
 *     (outreach_emails.sent_at IS NOT NULL). The previous definition ("status != 'new'") wrongly
 *     counted leads suppressed/unsubscribed BEFORE any send as contacted, inflating the
 *     denominator and understating every rate.
 *   - `sentEmails` = count of outreach emails actually sent (email grain, ≥ contactedLeads).
 *   - `eligibleLeads` = enrolled leads that were mailable = totalLeads − preSendExcludedLeads.
 *   - `preSendExcludedLeads` = leads unsubscribed/bounced with no send, i.e. excluded before any
 *     outbound mail. These never enter the rate denominator.
 *
 * All rates are per unique LEAD over `contactedLeads`, which is how the cold-email industry
 * (Instantly, Smartlead, Lemlist) defines them and is bounded 0–100 by construction (each
 * numerator is a subset of contacted). Event totals are still returned; they are not rates.
 *
 * Every campaign surface — list, dashboard /stats, campaign /:id/stats, /analytics — consumes
 * this one module (aggregate via computeCampaignMetrics, per-campaign via
 * computeCampaignMetricsByCampaign) so no two screens can silently choose different cohorts.
 */

import { db } from '../../db'
import { sql } from 'drizzle-orm'

export interface CampaignMetrics {
    // Cohort sizes / named denominators.
    totalLeads: number
    eligibleLeads: number
    contactedLeads: number
    sentEmails: number
    preSendExcludedLeads: number
    // Unique-lead numerators (each a subset of contactedLeads).
    uniqueOpeners: number
    uniqueClickers: number
    repliedLeads: number
    bouncedLeads: number
    // Raw event counts. NOT rate numerators — one lead can contribute many.
    totalOpens: number
    totalClicks: number
    totalReplies: number
    // Percentages 0-100 over contactedLeads.
    openRate: number
    clickRate: number
    replyRate: number
    bounceRate: number
}

export const EMPTY_CAMPAIGN_METRICS: CampaignMetrics = {
    totalLeads: 0,
    eligibleLeads: 0,
    contactedLeads: 0,
    sentEmails: 0,
    preSendExcludedLeads: 0,
    uniqueOpeners: 0,
    uniqueClickers: 0,
    repliedLeads: 0,
    bouncedLeads: 0,
    totalOpens: 0,
    totalClicks: 0,
    totalReplies: 0,
    openRate: 0,
    clickRate: 0,
    replyRate: 0,
    bounceRate: 0,
}

interface RawCohortCounts {
    totalLeads: number
    contactedLeads: number
    preSendExcludedLeads: number
    uniqueOpeners: number
    uniqueClickers: number
    repliedLeads: number
    bouncedLeads: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
    sentEmails: number
}

const EMPTY_RAW: RawCohortCounts = {
    totalLeads: 0,
    contactedLeads: 0,
    preSendExcludedLeads: 0,
    uniqueOpeners: 0,
    uniqueClickers: 0,
    repliedLeads: 0,
    bouncedLeads: 0,
    totalOpens: 0,
    totalClicks: 0,
    totalReplies: 0,
    sentEmails: 0,
}

const pct = (numerator: number, denominator: number): number =>
    denominator > 0 ? (numerator / denominator) * 100 : 0

function finalize(r: RawCohortCounts): CampaignMetrics {
    const contacted = r.contactedLeads
    return {
        totalLeads: r.totalLeads,
        eligibleLeads: r.totalLeads - r.preSendExcludedLeads,
        contactedLeads: contacted,
        sentEmails: r.sentEmails,
        preSendExcludedLeads: r.preSendExcludedLeads,
        uniqueOpeners: r.uniqueOpeners,
        uniqueClickers: r.uniqueClickers,
        repliedLeads: r.repliedLeads,
        bouncedLeads: r.bouncedLeads,
        totalOpens: r.totalOpens,
        totalClicks: r.totalClicks,
        totalReplies: r.totalReplies,
        openRate: pct(r.uniqueOpeners, contacted),
        clickRate: pct(r.uniqueClickers, contacted),
        replyRate: pct(r.repliedLeads, contacted),
        bounceRate: pct(r.bouncedLeads, contacted),
    }
}

/**
 * Per-campaign raw cohort counts. `contactedLeads`/`preSendExcludedLeads` are computed against a
 * per-lead "has ≥1 sent email" flag (LEFT JOIN to a DISTINCT campaign_lead_id subquery so the
 * lead-grain row count is never multiplied by the number of sent emails). `sentEmails` is a
 * separate email-grain aggregate.
 */
interface LeadCohortRow {
    campaignId: string
    totalLeads: number | string
    contactedLeads: number | string
    preSendExcludedLeads: number | string
    uniqueOpeners: number | string
    uniqueClickers: number | string
    repliedLeads: number | string
    bouncedLeads: number | string
    totalOpens: number | string
    totalClicks: number | string
    totalReplies: number | string
}

function rows<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[]
    if (result && typeof result === 'object' && 'rows' in result) {
        const inner = (result as { rows?: unknown }).rows
        return Array.isArray(inner) ? (inner as T[]) : []
    }
    return []
}

async function queryRawCohorts(campaignIds: string[]): Promise<Map<string, RawCohortCounts>> {
    const result = new Map<string, RawCohortCounts>()
    if (campaignIds.length === 0) return result

    // Bound, explicitly-cast IN list. Building it with sql.join keeps every id a parameter
    // ($1::uuid, $2::uuid, …) rather than an array literal that postgres would reject.
    const idList = sql.join(campaignIds.map((id) => sql`${id}::uuid`), sql`, `)

    // LEFT JOIN to a DISTINCT campaign_lead_id subquery keeps the row grain at one per lead, so
    // `count(*)` is a lead count and never multiplies by the number of sent emails.
    const leadResult = await db.execute(sql`
        SELECT
            cl.campaign_id AS "campaignId",
            count(*)::int AS "totalLeads",
            count(*) FILTER (WHERE sent.campaign_lead_id IS NOT NULL)::int AS "contactedLeads",
            count(*) FILTER (WHERE cl.status IN ('unsubscribed', 'bounced') AND sent.campaign_lead_id IS NULL)::int AS "preSendExcludedLeads",
            count(*) FILTER (WHERE cl.total_opens > 0)::int AS "uniqueOpeners",
            count(*) FILTER (WHERE cl.total_clicks > 0)::int AS "uniqueClickers",
            count(*) FILTER (WHERE cl.status IN ('replied', 'interested') OR cl.total_replies > 0)::int AS "repliedLeads",
            count(*) FILTER (WHERE cl.status = 'bounced')::int AS "bouncedLeads",
            coalesce(sum(cl.total_opens), 0)::int AS "totalOpens",
            coalesce(sum(cl.total_clicks), 0)::int AS "totalClicks",
            coalesce(sum(cl.total_replies), 0)::int AS "totalReplies"
        FROM campaign_leads cl
        LEFT JOIN (
            SELECT DISTINCT campaign_lead_id
            FROM outreach_emails
            WHERE campaign_id IN (${idList}) AND sent_at IS NOT NULL
        ) sent ON sent.campaign_lead_id = cl.id
        WHERE cl.campaign_id IN (${idList})
        GROUP BY cl.campaign_id
    `)

    const sentResult = await db.execute(sql`
        SELECT campaign_id AS "campaignId", count(*)::int AS "sentEmails"
        FROM outreach_emails
        WHERE campaign_id IN (${idList}) AND sent_at IS NOT NULL
        GROUP BY campaign_id
    `)

    const sentByCampaign = new Map<string, number>()
    for (const row of rows<{ campaignId: string; sentEmails: number | string }>(sentResult)) {
        if (row.campaignId) sentByCampaign.set(row.campaignId, Number(row.sentEmails) || 0)
    }

    for (const row of rows<LeadCohortRow>(leadResult)) {
        if (!row.campaignId) continue
        result.set(row.campaignId, {
            totalLeads: Number(row.totalLeads) || 0,
            contactedLeads: Number(row.contactedLeads) || 0,
            preSendExcludedLeads: Number(row.preSendExcludedLeads) || 0,
            uniqueOpeners: Number(row.uniqueOpeners) || 0,
            uniqueClickers: Number(row.uniqueClickers) || 0,
            repliedLeads: Number(row.repliedLeads) || 0,
            bouncedLeads: Number(row.bouncedLeads) || 0,
            totalOpens: Number(row.totalOpens) || 0,
            totalClicks: Number(row.totalClicks) || 0,
            totalReplies: Number(row.totalReplies) || 0,
            sentEmails: sentByCampaign.get(row.campaignId) ?? 0,
        })
    }

    return result
}

/**
 * Aggregate across the given campaigns. One id for a single campaign, or every id in an org for
 * the rollup — identical math either way, which is the entire point of this function existing.
 */
export async function computeCampaignMetrics(campaignIds: string[]): Promise<CampaignMetrics> {
    if (campaignIds.length === 0) return { ...EMPTY_CAMPAIGN_METRICS }

    const byCampaign = await queryRawCohorts(campaignIds)
    const total = { ...EMPTY_RAW }
    for (const counts of byCampaign.values()) {
        total.totalLeads += counts.totalLeads
        total.contactedLeads += counts.contactedLeads
        total.preSendExcludedLeads += counts.preSendExcludedLeads
        total.uniqueOpeners += counts.uniqueOpeners
        total.uniqueClickers += counts.uniqueClickers
        total.repliedLeads += counts.repliedLeads
        total.bouncedLeads += counts.bouncedLeads
        total.totalOpens += counts.totalOpens
        total.totalClicks += counts.totalClicks
        total.totalReplies += counts.totalReplies
        total.sentEmails += counts.sentEmails
    }
    return finalize(total)
}

/**
 * Per-campaign metrics DTO, keyed by campaign id. The campaign list attaches these so each row
 * reports the exact same named cohorts and rates the detail/stats/analytics surfaces do.
 */
export async function computeCampaignMetricsByCampaign(
    campaignIds: string[],
): Promise<Map<string, CampaignMetrics>> {
    const raw = await queryRawCohorts(campaignIds)
    const out = new Map<string, CampaignMetrics>()
    for (const [campaignId, counts] of raw) {
        out.set(campaignId, finalize(counts))
    }
    return out
}
