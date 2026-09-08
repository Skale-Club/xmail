import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure-mock unit tests -- no DB. `queryClient` is mocked exactly like
 * measureProspectingOutcomes.test.ts mocks it, so each number in the digest section can be
 * traced back to a specific mocked row rather than a hardcoded default.
 */

const queryClientMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../db', () => ({ db: {}, queryClient: queryClientMock }))

import {
    AGENT_OPS_PAGE_PATH,
    CREDIT_BALANCE_UNREACHABLE_NOTE,
    computeEngineDigestSection,
} from '../engine-digest'

beforeEach(() => {
    queryClientMock.mockReset()
    delete process.env.PROSPECTING_DAILY_BUDGET_USD
})

function aggregateRow(overrides: Partial<{
    discovered: number
    verified: number
    sendable: number
    imported: number
    emailed: number
    enrolled: number
    spentTodayMicros: number
    pendingApprovals: number
}> = {}) {
    return [{
        discovered: 0,
        verified: 0,
        sendable: 0,
        imported: 0,
        emailed: 0,
        enrolled: 0,
        spentTodayMicros: 0,
        pendingApprovals: 0,
        ...overrides,
    }]
}

describe('computeEngineDigestSection', () => {
    it('maps the per-run verdict list straight from the mocked query, including a run with no verdict yet', async () => {
        queryClientMock
            .mockResolvedValueOnce([
                { runId: 'run-1', provider: 'xcraper', externalRunId: 'ext-1', overall: 'confirmed' },
                { runId: 'run-2', provider: 'xcraper', externalRunId: 'ext-2', overall: null },
            ])
            .mockResolvedValueOnce(aggregateRow())

        const section = await computeEngineDigestSection(new Date('2026-09-08T09:00:00.000Z'))

        expect(section.runsToday).toEqual([
            { runId: 'run-1', provider: 'xcraper', externalRunId: 'ext-1', overall: 'confirmed' },
            { runId: 'run-2', provider: 'xcraper', externalRunId: 'ext-2', overall: null },
        ])
    })

    it('reads every funnel number from the mocked aggregate row, not a default', async () => {
        queryClientMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(aggregateRow({
                discovered: 138, verified: 98, sendable: 45, imported: 112, enrolled: 30, emailed: 27,
            }))

        const section = await computeEngineDigestSection(new Date('2026-09-08T09:00:00.000Z'))

        expect(section.funnel).toEqual({
            discovered: 138, verified: 98, sendable: 45, imported: 112, enrolled: 30, emailed: 27,
        })
    })

    it('converts spend from micros to USD and reads the budget from the environment', async () => {
        process.env.PROSPECTING_DAILY_BUDGET_USD = '5'
        queryClientMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(aggregateRow({ spentTodayMicros: 1_730_000 }))

        const section = await computeEngineDigestSection(new Date('2026-09-08T09:00:00.000Z'))

        expect(section.spend).toEqual({ spentTodayUsd: 1.73, dailyBudgetUsd: 5 })
    })

    it('reads pending approvals from the mocked query and names the Agent Ops page', async () => {
        queryClientMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(aggregateRow({ pendingApprovals: 4 }))

        const section = await computeEngineDigestSection(new Date('2026-09-08T09:00:00.000Z'))

        expect(section.approvals).toEqual({ pendingCount: 4, agentOpsUrl: AGENT_OPS_PAGE_PATH })
    })

    it('renders an unreachable credit balance as unknown, never as a fabricated zero', async () => {
        queryClientMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(aggregateRow())

        const section = await computeEngineDigestSection(new Date('2026-09-08T09:00:00.000Z'))

        expect(section.creditBalances.millionVerifier).toBe('unknown_not_reachable_from_xmail')
        expect(section.creditBalances.neverBounce).toBe('unknown_not_reachable_from_xmail')
        expect(section.creditBalances.millionVerifier).not.toBe(0)
        expect(section.creditBalances.note).toBe(CREDIT_BALANCE_UNREACHABLE_NOTE)
    })

    it('defaults every funnel/spend/approval number to zero (never throws) when the aggregate query returns no row', async () => {
        queryClientMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        const section = await computeEngineDigestSection(new Date('2026-09-08T09:00:00.000Z'))

        expect(section.funnel).toEqual({ discovered: 0, verified: 0, sendable: 0, imported: 0, enrolled: 0, emailed: 0 })
        expect(section.spend.spentTodayUsd).toBe(0)
        expect(section.approvals.pendingCount).toBe(0)
    })
})
