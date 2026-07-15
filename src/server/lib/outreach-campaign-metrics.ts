/**
 * Single source of truth for LEAD-GRAIN outreach metrics (the campaign/dashboard surface).
 *
 * Not to be confused with outreach-metrics.ts, which is the Phase 17 health/digest module and
 * is EMAIL-grain: it aggregates outreach_emails, so a prospect emailed three times counts three
 * times. That is the right grain for deliverability monitoring ("what fraction of sends bounced")
 * and the wrong grain for the campaign UI ("how many prospects opened"). Both are correct; they
 * answer different questions. Keep them separate — do not "deduplicate" one into the other.
 *
 * This module exists because the campaign surface computed the same numbers four different ways:
 * /stats aggregated live campaign_leads, /analytics summed the denormalized counters on campaigns,
 * /:id/stats returned raw totals, and StatsTab.tsx divided them again in the browser. They
 * disagreed for two independent reasons, both fixed here:
 *
 *   1. Source drift. The campaigns.* counters are a cache maintained by incrementCampaignStats;
 *      campaign_leads rows are the record. One missed increment forked the two numbers forever.
 *      Everything now derives from campaign_leads.
 *
 *   2. Rate semantics. Rates were total EVENTS / contacted, so a lead opening one email five times
 *      counted five times and "open rate" could exceed 100%. Worse, replyRate meant leads-that-
 *      replied in one endpoint and reply-events in another. Rates here are per unique LEAD, which
 *      is how the cold-email industry (Instantly, Smartlead, Lemlist) defines them — so our numbers
 *      are comparable to the vendor dashboards a user will inevitably hold them against.
 *
 * Event totals are still returned; they are useful, they just are not rates. Keep the ideas apart.
 *
 * Denominator is `contacted` (leads actually emailed, status != 'new'), never total leads —
 * dividing by never-contacted leads would understate every rate.
 */

import { db } from '../../db'
import { campaignLeads } from '../../db/schema'
import { inArray, sql } from 'drizzle-orm'

export interface CampaignMetrics {
    totalLeads: number
    contacted: number
    // Unique leads with >= 1 event. These are the rate numerators.
    uniqueOpeners: number
    uniqueClickers: number
    repliedLeads: number
    bouncedLeads: number
    // Raw event counts. NOT rate numerators — one lead can contribute many.
    totalOpens: number
    totalClicks: number
    totalReplies: number
    // Percentages 0-100, bounded by construction since each numerator is a subset of `contacted`.
    openRate: number
    clickRate: number
    replyRate: number
    bounceRate: number
}

export const EMPTY_CAMPAIGN_METRICS: CampaignMetrics = {
    totalLeads: 0,
    contacted: 0,
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

const pct = (numerator: number, denominator: number): number =>
    denominator > 0 ? (numerator / denominator) * 100 : 0

/**
 * Aggregate across the given campaigns. One id for a single campaign, or every id in an org for
 * the rollup — identical math either way, which is the entire point of this function existing.
 */
export async function computeCampaignMetrics(campaignIds: string[]): Promise<CampaignMetrics> {
    if (campaignIds.length === 0) return { ...EMPTY_CAMPAIGN_METRICS }

    const rows = await db
        .select({
            totalLeads: sql<number>`count(*)`,
            contacted: sql<number>`count(*) filter (where ${campaignLeads.status} != 'new')`,
            // 'interested' is a manual triage state a human sets after reading a reply, so a lead
            // can sit in 'interested' with its reply already counted. Accept either signal, or the
            // reply rate would fall as the team triages its own inbox.
            repliedLeads: sql<number>`count(*) filter (where ${campaignLeads.status} in ('replied', 'interested') or ${campaignLeads.totalReplies} > 0)`,
            bouncedLeads: sql<number>`count(*) filter (where ${campaignLeads.status} = 'bounced')`,
            uniqueOpeners: sql<number>`count(*) filter (where ${campaignLeads.totalOpens} > 0)`,
            uniqueClickers: sql<number>`count(*) filter (where ${campaignLeads.totalClicks} > 0)`,
            totalOpens: sql<number>`coalesce(sum(${campaignLeads.totalOpens}), 0)`,
            totalClicks: sql<number>`coalesce(sum(${campaignLeads.totalClicks}), 0)`,
            totalReplies: sql<number>`coalesce(sum(${campaignLeads.totalReplies}), 0)`,
        })
        .from(campaignLeads)
        .where(inArray(campaignLeads.campaignId, campaignIds))

    const r = rows[0]
    if (!r) return { ...EMPTY_CAMPAIGN_METRICS }

    // count()/sum() arrive as strings; Number() them before any arithmetic or the rates
    // silently become string concatenation.
    const totalLeads = Number(r.totalLeads) || 0
    const contacted = Number(r.contacted) || 0
    const uniqueOpeners = Number(r.uniqueOpeners) || 0
    const uniqueClickers = Number(r.uniqueClickers) || 0
    const repliedLeads = Number(r.repliedLeads) || 0
    const bouncedLeads = Number(r.bouncedLeads) || 0

    return {
        totalLeads,
        contacted,
        uniqueOpeners,
        uniqueClickers,
        repliedLeads,
        bouncedLeads,
        totalOpens: Number(r.totalOpens) || 0,
        totalClicks: Number(r.totalClicks) || 0,
        totalReplies: Number(r.totalReplies) || 0,
        openRate: pct(uniqueOpeners, contacted),
        clickRate: pct(uniqueClickers, contacted),
        replyRate: pct(repliedLeads, contacted),
        bounceRate: pct(bouncedLeads, contacted),
    }
}
