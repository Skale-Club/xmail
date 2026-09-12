import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Job-level orchestration tests -- no real DB, no real network. `queryClient` and
 * `buildBaselineHypothesis` are mocked (same placement/mocking convention as
 * src/server/jobs/measureProspectingOutcomes.test.ts), and `fetch` is stubbed globally so the
 * Xcraper POST never leaves the process. The pure sizing/config decisions themselves are
 * covered without any of this in daily-territory-budget.test.ts.
 */

const queryClientMock = vi.hoisted(() => vi.fn())
const buildBaselineHypothesisMock = vi.hoisted(() => vi.fn())

vi.mock('../../db', () => ({ db: {}, queryClient: queryClientMock }))
vi.mock('../lib/prospecting/baseline-hypothesis-query', () => ({ buildBaselineHypothesis: buildBaselineHypothesisMock }))

import { runDailyProspecting, type DailyProspectingOrgSummary } from './runDailyProspecting'

const NOW = new Date('2026-09-09T10:00:00.000Z')
const ORG_ID = 'org-1'

/** Narrows a summary to its decision-bearing variant, failing loudly on the org-level error variant. */
function expectDecided(summary: DailyProspectingOrgSummary): Extract<DailyProspectingOrgSummary, { decision: unknown }> {
    if (!('decision' in summary)) throw new Error(`expected a decision, got organization error: ${summary.error}`)
    return summary
}

function territoryRow(overrides: Partial<{ id: string; query: string; location: string; template: string; maxResults: number }> = {}) {
    return {
        id: 'territory-1',
        query: 'barbershops',
        location: 'Hudson, MA, USA',
        template: 'enriched',
        maxResults: 40,
        ...overrides,
    }
}

beforeEach(() => {
    queryClientMock.mockReset()
    buildBaselineHypothesisMock.mockReset()
    buildBaselineHypothesisMock.mockResolvedValue({ premise: 'p', expected: {}, basis: 'first run' })
    process.env.XCRAPER_SERVICE_URL = 'https://xcraper.skale.club/api/service'
    process.env.XCRAPER_SERVICE_KEY = 'xsk_test'
    delete process.env.PROSPECTING_DAILY_BUDGET_USD
    vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
    delete process.env.XCRAPER_SERVICE_URL
    delete process.env.XCRAPER_SERVICE_KEY
    delete process.env.PROSPECTING_DAILY_BUDGET_USD
    vi.unstubAllGlobals()
})

describe('runDailyProspecting: missing configuration', () => {
    it('never touches the database or the network when XCRAPER_SERVICE_URL is unset', async () => {
        delete process.env.XCRAPER_SERVICE_URL
        const summaries = await runDailyProspecting(NOW)
        expect(summaries).toEqual([])
        expect(queryClientMock).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
    })

    it('never touches the database or the network when XCRAPER_SERVICE_KEY is unset', async () => {
        delete process.env.XCRAPER_SERVICE_KEY
        const summaries = await runDailyProspecting(NOW)
        expect(summaries).toEqual([])
        expect(queryClientMock).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
    })
})

describe('runDailyProspecting: per-organization decisions', () => {
    it('stops at budget_exhausted without ever querying the territory queue', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile (no rows flipped)
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll (no running territories)
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // spend = $2.00

        const summaries = await runDailyProspecting(NOW)

        expect(summaries).toEqual([{
            organizationId: ORG_ID,
            reconciled: 0,
            decision: { action: 'skip', reason: 'budget_exhausted', spentTodayUsd: 2, dailyBudgetUsd: 2 },
        }])
        expect(queryClientMock).toHaveBeenCalledTimes(4)
        expect(fetch).not.toHaveBeenCalled()
    })

    it('reports queue_empty distinctly from budget_exhausted when there is budget but no queued territory', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '0' }]) // spend = $0
            .mockResolvedValueOnce([]) // no queued territory

        const summaries = await runDailyProspecting(NOW)

        expect(summaries).toEqual([{
            organizationId: ORG_ID,
            reconciled: 0,
            decision: { action: 'skip', reason: 'queue_empty' },
        }])
        expect(fetch).not.toHaveBeenCalled()
    })

    it('falls back to the territory cap and still runs when there is no completed-run cost history', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '0' }]) // spend = $0
            .mockResolvedValueOnce([territoryRow({ maxResults: 40 })]) // territory
            .mockResolvedValueOnce([]) // no completed-run history
            .mockResolvedValueOnce([{ id: 'territory-1' }]) // markTerritoryRunning UPDATE

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ searchId: 'search-123' }),
        } as unknown as Response)

        const summaries = await runDailyProspecting(NOW)

        expect(summaries).toEqual([{
            organizationId: ORG_ID,
            reconciled: 0,
            decision: {
                action: 'run',
                maxResults: 40,
                remainingBudgetUsd: 2,
                medianUnitCostUsd: null,
                usedFallback: true,
            },
            searchId: 'search-123',
        }])
        expect(fetch).toHaveBeenCalledWith(
            'https://xcraper.skale.club/api/service/scrape',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'X-Service-Key': 'xsk_test' }),
            }),
        )
        const [, options] = vi.mocked(fetch).mock.calls[0]
        expect(JSON.parse((options as RequestInit).body as string)).toEqual({
            query: 'barbershops',
            location: 'Hudson, MA, USA',
            maxResults: 40,
            scrapeType: 'enriched',
            hypothesis: { premise: 'p', expected: {}, basis: 'first run' },
        })
    })

    it('skips firing a run whose computed size is below the floor', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '1940000' }]) // spend = $1.94, remaining ~ $0.06
            .mockResolvedValueOnce([territoryRow({ maxResults: 500 })]) // territory (cap not the binding factor)
            .mockResolvedValueOnce([ // 5 completed runs, unit costs matching the 2026-09-08 evidence
                { discoveredCount: 25, amountMicros: '165100' },
                { discoveredCount: 100, amountMicros: '607600' },
                { discoveredCount: 330, amountMicros: '2060100' },
            ])

        const summaries = await runDailyProspecting(NOW)

        expect(summaries).toHaveLength(1)
        expect(expectDecided(summaries[0]).decision).toMatchObject({ action: 'skip', reason: 'below_floor', computedMaxResults: 9 })
        expect(fetch).not.toHaveBeenCalled()
        // No UPDATE fired for a territory that was never attempted.
        expect(queryClientMock).toHaveBeenCalledTimes(6)
    })

    it('sizes the run from the median of real unit-cost history and marks the territory running on a 2xx response', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '0' }]) // spend = $0, full $2.00 remaining
            .mockResolvedValueOnce([territoryRow({ maxResults: 500 })])
            .mockResolvedValueOnce([
                { discoveredCount: 25, amountMicros: '165100' }, // 0.1651/25 = 0.006604
                { discoveredCount: 100, amountMicros: '607600' }, // 0.6076/100 = 0.006076
                { discoveredCount: 330, amountMicros: '2060100' }, // 2.0601/330 = 0.006243...
            ])
            .mockResolvedValueOnce([{ id: 'territory-1' }]) // markTerritoryRunning

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ searchId: 'search-456' }),
        } as unknown as Response)

        const summaries = await runDailyProspecting(NOW)

        // median(0.006604, 0.006076, 0.0062424...) = 0.0062424..., floor(2 / that) = 320
        expect(expectDecided(summaries[0]).decision).toMatchObject({ action: 'run', usedFallback: false, maxResults: 320 })
        expect(summaries[0]).toMatchObject({ searchId: 'search-456' })
    })

    it('leaves the territory queued and records the failure when the Xcraper POST does not return 2xx', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '0' }]) // spend
            .mockResolvedValueOnce([territoryRow()]) // territory
            .mockResolvedValueOnce([]) // no cost history
            .mockResolvedValueOnce([{ id: 'territory-1' }]) // markTerritoryAttemptFailed UPDATE

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: false,
            status: 503,
            text: async () => 'service unavailable',
        } as unknown as Response)

        const summaries = await runDailyProspecting(NOW)

        expect(summaries[0]).toMatchObject({ scrapeError: expect.stringContaining('503') })
        expect(queryClientMock).toHaveBeenCalledTimes(7)
    })

    it('reconciles a running territory into done before evaluating the budget', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([{ id: 'territory-9', query: 'barbershops', location: 'Worcester, MA, USA' }]) // reconciled 1 row
            .mockResolvedValueOnce([]) // fetchRunningTerritoriesToPoll (nothing left running after the flip above)
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // spend already at budget -- stop here

        const summaries = await runDailyProspecting(NOW)

        expect(summaries[0]).toMatchObject({ reconciled: 1 })
    })

    it('continues to the next organization when one organization\'s queries throw', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: 'org-a' }, { organizationId: 'org-b' }]) // org list
            .mockRejectedValueOnce(new Error('db unreachable')) // org-a reconcile fails
            .mockResolvedValueOnce([]) // org-b reconcile
            .mockResolvedValueOnce([]) // org-b fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // org-b spend already at budget

        const summaries = await runDailyProspecting(NOW)

        expect(summaries).toHaveLength(2)
        expect(summaries[0]).toMatchObject({ organizationId: 'org-a', error: expect.stringContaining('db unreachable') })
        expect(summaries[1]).toMatchObject({ organizationId: 'org-b', decision: { action: 'skip', reason: 'budget_exhausted' } })
    })
})

describe('runDailyProspecting: territory reconciliation poll (defect fix 2026-09-12)', () => {
    /**
     * Reproduces the production defect this fix targets: Xcraper never pushes a finished scrape
     * to Xphere on its own -- only `GET /scrape/:id` triggers that push. Before this fix,
     * runDailyProspecting never called that endpoint, so a territory could stay 'running'
     * forever even after Xcraper finished. These tests drive the reconciliation poll this fix
     * added and pin its four outcomes (completed / failed / still_running / stalled), plus the
     * invariant that a paid scrape is never re-fired for a territory this step examines.
     */

    function runningTerritoryRow(overrides: Partial<{ id: string; lastExternalRunId: string; lastAttemptedAt: string }> = {}) {
        return {
            id: 'territory-running-1',
            lastExternalRunId: 'search-b301ddcc',
            lastAttemptedAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
            ...overrides,
        }
    }

    it('polls a running territory\'s status, logs the xphere push result, and leaves it running -- it does NOT flip status itself', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile (join) -- nothing flipped yet, prospecting_runs row not there yet
            .mockResolvedValueOnce([runningTerritoryRow()]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // spend already at budget -- stop here, keeps the test focused

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'completed', xphere: { pushed: true, alreadyPushed: false } }),
        } as unknown as Response)

        const summaries = await runDailyProspecting(NOW)

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(fetch).toHaveBeenCalledWith(
            'https://xcraper.skale.club/api/service/scrape/search-b301ddcc',
            expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ 'X-Service-Key': 'xsk_test' }) }),
        )
        // No status-changing UPDATE fired for the polled territory -- only org list, reconcile,
        // the poll's own SELECT, and the spend read.
        expect(queryClientMock).toHaveBeenCalledTimes(4)
        expect(summaries[0]).toMatchObject({ decision: { action: 'skip', reason: 'budget_exhausted' } })
    })

    it('marks the territory paused with a reason when Xcraper reports the scrape failed', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([runningTerritoryRow({ lastExternalRunId: 'search-failed-1' })]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([]) // markTerritoryFailed UPDATE
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // spend already at budget

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'failed' }),
        } as unknown as Response)

        await runDailyProspecting(NOW)

        expect(queryClientMock).toHaveBeenCalledTimes(5)
        // The 4th call is the markTerritoryFailed UPDATE -- confirm it actually writes 'paused'
        // (migration 065's status CHECK has no 'failed' value) with the territory id interpolated.
        const [strings, reason, territoryId] = queryClientMock.mock.calls[3] as [string[], string, string]
        expect(strings.join('')).toContain("status = 'paused'")
        expect(reason).toMatch(/failed/i)
        expect(territoryId).toBe('territory-running-1')
    })

    it('leaves an in-progress, not-yet-stalled scrape running without writing anything', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([runningTerritoryRow()]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // spend

        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ status: 'processing' }),
        } as unknown as Response)

        await runDailyProspecting(NOW)

        expect(queryClientMock).toHaveBeenCalledTimes(4) // no extra UPDATE
    })

    it('skips a territory stalled past the 48h threshold WITHOUT re-firing a scrape for it, while a different queued territory can still legitimately fire', async () => {
        queryClientMock
            .mockResolvedValueOnce([{ organizationId: ORG_ID }]) // org list
            .mockResolvedValueOnce([]) // reconcile
            .mockResolvedValueOnce([runningTerritoryRow({
                id: 'territory-stalled',
                lastExternalRunId: 'search-stalled',
                lastAttemptedAt: new Date(NOW.getTime() - 49 * 60 * 60 * 1000).toISOString(), // 49h ago > 48h threshold
            })]) // fetchRunningTerritoriesToPoll
            .mockResolvedValueOnce([{ amountMicros: '0' }]) // spend = $0, full budget available
            .mockResolvedValueOnce([territoryRow({ id: 'territory-new', maxResults: 40 })]) // a DIFFERENT queued territory
            .mockResolvedValueOnce([]) // no completed-run history
            .mockResolvedValueOnce([{ id: 'territory-new' }]) // markTerritoryRunning UPDATE for the NEW territory

        vi.mocked(fetch)
            .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'processing' }) } as unknown as Response) // GET poll
            .mockResolvedValueOnce({ ok: true, json: async () => ({ searchId: 'search-new' }) } as unknown as Response) // POST scrape

        const summaries = await runDailyProspecting(NOW)

        expect(fetch).toHaveBeenCalledTimes(2)
        // First call: the reconciliation GET for the stalled territory's EXISTING searchId --
        // never a POST, i.e. never a re-fire of that already-paid-for scrape.
        expect(fetch).toHaveBeenNthCalledWith(
            1,
            'https://xcraper.skale.club/api/service/scrape/search-stalled',
            expect.objectContaining({ method: 'GET' }),
        )
        // Second call: a legitimate NEW POST for the unrelated queued territory.
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            'https://xcraper.skale.club/api/service/scrape',
            expect.objectContaining({ method: 'POST' }),
        )
        // No UPDATE ever targeted 'territory-stalled' -- only the poll SELECT read it.
        for (const call of queryClientMock.mock.calls) {
            const sql = (call[0] as string[]).join('')
            if (sql.includes('UPDATE')) {
                expect(call).not.toContain('territory-stalled')
            }
        }
        expect(summaries[0]).toMatchObject({ searchId: 'search-new' })
    })

    it('never queries the database for a second organization\'s reconciliation once the shared per-tick budget is exhausted by the first', async () => {
        const org1RunningTerritories = Array.from({ length: 10 }, (_, i) => runningTerritoryRow({
            id: `territory-${i}`,
            lastExternalRunId: `search-${i}`,
        }))

        queryClientMock
            .mockResolvedValueOnce([{ organizationId: 'org-a' }, { organizationId: 'org-b' }]) // org list
            .mockResolvedValueOnce([]) // org-a reconcile
            .mockResolvedValueOnce(org1RunningTerritories) // org-a fetchRunningTerritoriesToPoll -- exactly MAX_TERRITORIES_TO_RECONCILE_PER_TICK
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // org-a spend -- stop here
            .mockResolvedValueOnce([]) // org-b reconcile
            // NOTE: no mock queued here for org-b's fetchRunningTerritoriesToPoll -- the shared
            // budget is 0 by now, so that query must never fire (see the guard at the top of
            // reconcilePollRunningTerritories). If the guard regresses, this test fails loudly
            // with "no mockResolvedValueOnce left" instead of silently passing.
            .mockResolvedValueOnce([{ amountMicros: '2000000' }]) // org-b spend

        vi.mocked(fetch).mockImplementation(async () => ({
            ok: true,
            json: async () => ({ status: 'still_running' }),
        } as unknown as Response))

        const summaries = await runDailyProspecting(NOW)

        expect(fetch).toHaveBeenCalledTimes(10) // exactly the shared cap, not 10 + more for org-b
        expect(queryClientMock).toHaveBeenCalledTimes(6)
        expect(summaries).toHaveLength(2)
    })
})
