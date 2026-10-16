import { describe, expect, it } from 'vitest'
import {
    buildCampaignDashboardModel,
    fillDailyCampaignSeries,
    type CampaignDashboardStats,
} from './campaign-dashboard'

function stats(overrides: Partial<CampaignDashboardStats> = {}): CampaignDashboardStats {
    return {
        totalLeads: 100,
        eligibleLeads: 90,
        contactedLeads: 30,
        sentEmails: 36,
        preSendExcludedLeads: 10,
        uniqueOpeners: 15,
        uniqueClickers: 3,
        repliedLeads: 4,
        interestedLeads: 2,
        bouncedLeads: 1,
        totalOpens: 20,
        totalClicks: 4,
        totalReplies: 4,
        openRate: 50,
        clickRate: 10,
        replyRate: 13.333,
        positiveReplyRate: 6.667,
        bounceRate: 3.333,
        ...overrides,
    }
}

describe('buildCampaignDashboardModel', () => {
    it('makes interested leads the north-star outcome and keeps the funnel lead-grain', () => {
        const model = buildCampaignDashboardModel(stats())

        expect(model.health.label).toBe('Positive momentum')
        expect(model.contactedProgress).toBeCloseTo(33.333, 2)
        expect(model.remainingEligible).toBe(60)
        expect(model.unclassifiedReplies).toBe(2)
        expect(model.funnel.map((stage) => [stage.label, stage.value])).toEqual([
            ['Eligible', 90],
            ['Contacted', 30],
            ['Opened', 15],
            ['Replied', 4],
            ['Interested', 2],
        ])
        expect(model.insights.some((insight) => insight.title === 'Positive replies found')).toBe(true)
    })

    it('surfaces bounce risk before positive momentum', () => {
        const model = buildCampaignDashboardModel(stats({ bounceRate: 8 }))

        expect(model.health).toMatchObject({ label: 'Deliverability risk', tone: 'warning' })
        expect(model.insights[0].title).toBe('Protect sender reputation')
    })

    it('handles a campaign with no sends without NaN or inflated progress', () => {
        const model = buildCampaignDashboardModel(stats({
            contactedLeads: 0,
            sentEmails: 0,
            uniqueOpeners: 0,
            repliedLeads: 0,
            interestedLeads: 0,
            openRate: 0,
            replyRate: 0,
            positiveReplyRate: 0,
            bounceRate: 0,
        }))

        expect(model.health.label).toBe('Awaiting sends')
        expect(model.contactedProgress).toBe(0)
        expect(model.remainingEligible).toBe(90)
        expect(model.funnel.every((stage) => Number.isFinite(stage.rate))).toBe(true)
    })
})

describe('fillDailyCampaignSeries', () => {
    it('fills missing calendar days with zeroes while preserving returned activity', () => {
        const series = fillDailyCampaignSeries(
            [{ date: '2026-10-14', emailsSent: 12, opens: 4, clicks: 1, replies: 2 }],
            3,
            new Date('2026-10-15T18:00:00Z'),
        )

        expect(series.map((row) => row.date)).toEqual(['2026-10-13', '2026-10-14', '2026-10-15'])
        expect(series.map((row) => row.emailsSent)).toEqual([0, 12, 0])
    })
})
