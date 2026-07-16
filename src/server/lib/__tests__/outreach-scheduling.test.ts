import { describe, expect, it } from 'vitest'
import {
    CAMPAIGN_LEAD_PROGRESS,
    TERMINAL_CAMPAIGN_LEAD_STATUSES,
    isCampaignProgressComplete,
    isTerminalCampaignLeadStatus,
    selectFairDueCandidates,
} from '../outreach-sequence-state'

const ALL_LEAD_STATUSES = [
    'new',
    'contacted',
    'replied',
    'interested',
    'not_interested',
    'bounced',
    'unsubscribed',
] as const

describe('campaign lead progress contract', () => {
    it.each([
        ['new', false],
        ['contacted', false],
        ['replied', true],
        ['interested', true],
        ['not_interested', true],
        ['bounced', true],
        ['unsubscribed', true],
    ] as const)('classifies %s terminal=%s', (status, terminal) => {
        expect(isTerminalCampaignLeadStatus(status)).toBe(terminal)
        expect(CAMPAIGN_LEAD_PROGRESS[status].terminal).toBe(terminal)
    })

    it('derives the terminal list from the exhaustive status map', () => {
        expect(Object.keys(CAMPAIGN_LEAD_PROGRESS)).toEqual(ALL_LEAD_STATUSES)
        expect(TERMINAL_CAMPAIGN_LEAD_STATUSES).toEqual([
            'replied',
            'interested',
            'not_interested',
            'bounced',
            'unsubscribed',
        ])
    })

    it.each(ALL_LEAD_STATUSES)('uses completedAt as terminal progress for %s', (status) => {
        expect(isCampaignProgressComplete([{ status, completedAt: new Date() }])).toBe(true)
    })

    it('requires at least one lead and rejects any incomplete nonterminal lead', () => {
        expect(isCampaignProgressComplete([])).toBe(false)
        expect(isCampaignProgressComplete([
            { status: 'replied', completedAt: null },
            { status: 'contacted', completedAt: null },
        ])).toBe(false)
        expect(isCampaignProgressComplete([
            { status: 'replied', completedAt: null },
            { status: 'bounced', completedAt: null },
            { status: 'contacted', completedAt: new Date() },
        ])).toBe(true)
    })
})

describe('fair due-work ordering', () => {
    it('keeps sendable accounts inside a 200-row batch despite a 250-row inbox backlog', () => {
        const dueAt = new Date('2026-07-16T12:00:00.000Z')
        const blockedBacklog = Array.from({ length: 250 }, (_, index) => ({
            id: `blocked-${String(index).padStart(3, '0')}`,
            emailAccountId: 'account-blocked',
            nextScheduledAt: new Date(dueAt.getTime() + index),
        }))
        const sendableBacklog = Array.from({ length: 250 }, (_, index) => ({
            id: `sendable-${String(index).padStart(3, '0')}`,
            emailAccountId: 'account-sendable',
            nextScheduledAt: new Date(dueAt.getTime() + index),
        }))

        const selected = selectFairDueCandidates([...blockedBacklog, ...sendableBacklog], 200)

        expect(selected).toHaveLength(200)
        expect(selected.filter((row) => row.emailAccountId === 'account-blocked')).toHaveLength(100)
        expect(selected.filter((row) => row.emailAccountId === 'account-sendable')).toHaveLength(100)
        expect(selected.slice(0, 4).map((row) => row.id)).toEqual([
            'blocked-000',
            'sendable-000',
            'blocked-001',
            'sendable-001',
        ])
    })

    it('is stable for equal timestamps and excludes candidates beyond the hard cap', () => {
        const dueAt = new Date('2026-07-16T12:00:00.000Z')
        const candidates = [
            { id: 'b-2', emailAccountId: 'b', nextScheduledAt: dueAt },
            { id: 'a-2', emailAccountId: 'a', nextScheduledAt: dueAt },
            { id: 'b-1', emailAccountId: 'b', nextScheduledAt: dueAt },
            { id: 'a-1', emailAccountId: 'a', nextScheduledAt: dueAt },
        ]

        expect(selectFairDueCandidates(candidates, 3).map((row) => row.id)).toEqual([
            'a-1',
            'b-1',
            'a-2',
        ])
        expect(selectFairDueCandidates(candidates, 3)).toEqual(selectFairDueCandidates([...candidates].reverse(), 3))
    })
})
