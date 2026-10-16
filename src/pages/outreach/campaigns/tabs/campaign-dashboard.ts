export interface CampaignDashboardStats {
    totalLeads: number
    eligibleLeads: number
    contactedLeads: number
    sentEmails: number
    preSendExcludedLeads: number
    uniqueOpeners: number
    uniqueClickers: number
    repliedLeads: number
    interestedLeads: number
    bouncedLeads: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
    openRate: number
    clickRate: number
    replyRate: number
    positiveReplyRate: number
    bounceRate: number
}
export interface CampaignDailyStat {
    date: string
    emailsSent: number
    opens: number
    clicks: number
    replies: number
}

export type CampaignHealthTone = 'neutral' | 'positive' | 'warning'

export interface CampaignDashboardModel {
    contactedProgress: number
    remainingEligible: number
    unclassifiedReplies: number
    health: {
        label: string
        description: string
        tone: CampaignHealthTone
    }
    funnel: Array<{
        label: string
        value: number
        rate: number
    }>
    insights: Array<{
        title: string
        body: string
        tone: CampaignHealthTone
    }>
}

function finite(value: number | undefined): number {
    return Number.isFinite(value) ? Number(value) : 0
}

export function boundedPercent(value: number): number {
    return Math.min(100, Math.max(0, finite(value)))
}

function percent(numerator: number, denominator: number): number {
    return denominator > 0 ? boundedPercent((numerator / denominator) * 100) : 0
}

export function buildCampaignDashboardModel(stats: CampaignDashboardStats): CampaignDashboardModel {
    const contacted = Math.max(0, finite(stats.contactedLeads))
    const eligible = Math.max(0, finite(stats.eligibleLeads))
    const interested = Math.max(0, finite(stats.interestedLeads))
    const replied = Math.max(0, finite(stats.repliedLeads))
    const bounceRate = boundedPercent(stats.bounceRate)
    const remainingEligible = Math.max(0, eligible - contacted)

    let health: CampaignDashboardModel['health']
    if (contacted === 0) {
        health = {
            label: 'Awaiting sends',
            description: 'The campaign needs its first deliveries before performance can be judged.',
            tone: 'neutral',
        }
    } else if (bounceRate > 5) {
        health = {
            label: 'Deliverability risk',
            description: 'Bounce rate is above the 5% safety threshold.',
            tone: 'warning',
        }
    } else if (interested > 0) {
        health = {
            label: 'Positive momentum',
            description: 'The campaign is generating replies marked as interested.',
            tone: 'positive',
        }
    } else if (boundedPercent(stats.replyRate) >= 3) {
        health = {
            label: 'Healthy signal',
            description: 'Reply rate is healthy; keep qualifying reply intent.',
            tone: 'positive',
        }
    } else if (contacted >= 20 && replied === 0) {
        health = {
            label: 'Needs attention',
            description: 'Enough leads were contacted to review the offer and targeting.',
            tone: 'warning',
        }
    } else {
        health = {
            label: 'Gathering signal',
            description: 'The sample is still small; keep monitoring replies and bounces.',
            tone: 'neutral',
        }
    }

    const insights: CampaignDashboardModel['insights'] = []
    if (contacted === 0) {
        insights.push({
            title: 'No delivery signal yet',
            body: `${eligible.toLocaleString()} eligible leads are ready for the campaign queue.`,
            tone: 'neutral',
        })
    } else if (bounceRate > 5) {
        insights.push({
            title: 'Protect sender reputation',
            body: `Bounce rate is ${bounceRate.toFixed(1)}%. Pause scaling and inspect list quality.`,
            tone: 'warning',
        })
    } else {
        insights.push({
            title: 'Deliverability is in range',
            body: `${bounceRate.toFixed(1)}% bounced, inside the 5% operating guardrail.`,
            tone: 'positive',
        })
    }

    if (interested > 0) {
        insights.push({
            title: 'Positive replies found',
            body: `${interested.toLocaleString()} lead${interested === 1 ? '' : 's'} marked interested — prioritize follow-up.`,
            tone: 'positive',
        })
    } else if (contacted > 0) {
        insights.push({
            title: 'No positive reply yet',
            body: 'Keep monitoring; adjust the offer only after a meaningful delivery sample.',
            tone: 'neutral',
        })
    }

    if (replied > interested) {
        const pending = replied - interested
        insights.push({
            title: 'Qualify reply intent',
            body: `${pending.toLocaleString()} repl${pending === 1 ? 'y is' : 'ies are'} not yet marked interested.`,
            tone: 'neutral',
        })
    } else if (remainingEligible > 0 && contacted > 0) {
        insights.push({
            title: 'Pipeline remaining',
            body: `${remainingEligible.toLocaleString()} eligible leads have not been contacted yet.`,
            tone: 'neutral',
        })
    }

    return {
        contactedProgress: percent(contacted, eligible),
        remainingEligible,
        unclassifiedReplies: Math.max(0, replied - interested),
        health,
        funnel: [
            { label: 'Eligible', value: eligible, rate: eligible > 0 ? 100 : 0 },
            { label: 'Contacted', value: contacted, rate: percent(contacted, eligible) },
            { label: 'Opened', value: Math.max(0, finite(stats.uniqueOpeners)), rate: boundedPercent(stats.openRate) },
            { label: 'Replied', value: replied, rate: boundedPercent(stats.replyRate) },
            { label: 'Interested', value: interested, rate: boundedPercent(stats.positiveReplyRate) },
        ],
        insights,
    }
}

export function fillDailyCampaignSeries(
    rows: CampaignDailyStat[],
    days = 30,
    endDate = new Date(),
): CampaignDailyStat[] {
    const safeDays = Math.max(1, Math.floor(days))
    const byDate = new Map(rows.map((row) => [row.date.slice(0, 10), row]))
    const endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())

    return Array.from({ length: safeDays }, (_, index) => {
        const day = new Date(endUtc - (safeDays - 1 - index) * 86_400_000)
        const date = day.toISOString().slice(0, 10)
        return byDate.get(date) ?? { date, emailsSent: 0, opens: 0, clicks: 0, replies: 0 }
    })
}
