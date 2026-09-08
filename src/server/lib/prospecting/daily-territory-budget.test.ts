import { describe, expect, it } from 'vitest'
import {
    decideDailyProspectingRun,
    resolveDailyBudgetUsd,
    resolveXcraperConfig,
    DEFAULT_DAILY_BUDGET_USD,
    DEFAULT_MIN_RESULTS_FLOOR,
} from './daily-territory-budget'

describe('decideDailyProspectingRun', () => {
    it('stops before looking at the queue once today\'s spend meets the budget', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 2.0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 100 },
            recentUnitCostsUsd: [0.0061, 0.0062, 0.0066],
        })
        expect(decision).toEqual({
            action: 'skip',
            reason: 'budget_exhausted',
            spentTodayUsd: 2.0,
            dailyBudgetUsd: 2.0,
        })
    })

    it('reports budget_exhausted even when spend has overshot the budget', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 2.5,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 100 },
            recentUnitCostsUsd: [],
        })
        expect(decision).toMatchObject({ action: 'skip', reason: 'budget_exhausted' })
    })

    it('reports queue_empty as a DISTINCT reason from budget_exhausted when there is budget but no territory', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: null,
            recentUnitCostsUsd: [0.006],
        })
        expect(decision).toEqual({ action: 'skip', reason: 'queue_empty' })
    })

    it('falls back to the territory\'s own max_results with no completed-run cost history', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 40 },
            recentUnitCostsUsd: [],
        })
        expect(decision).toEqual({
            action: 'run',
            maxResults: 40,
            remainingBudgetUsd: 2.0,
            medianUnitCostUsd: null,
            usedFallback: true,
        })
    })

    it('treats non-finite and non-positive recorded unit costs as absent history, not as zero-cost', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 40 },
            recentUnitCostsUsd: [0, -1, NaN, Infinity],
        })
        expect(decision).toMatchObject({ action: 'run', usedFallback: true, medianUnitCostUsd: null })
    })

    // Fixture: the three real 2026-09-08 runs' measured unit costs (docs/prospecting-engine-plan.md
    // "Fase 36" evidence table) -- median of 0.0066 (Framingham), 0.0061 (Worcester), 0.0062
    // (Boston) against a US$ 2.00 daily budget.
    it('sizes maxResults from the median of the three real 2026-09-08 unit costs against a $2.00 budget', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 500 }, // cap high enough that the budget, not the cap, binds
            recentUnitCostsUsd: [0.0066, 0.0061, 0.0062],
        })
        // median([0.0061, 0.0062, 0.0066]) = 0.0062; floor(2.00 / 0.0062) = 322
        expect(decision).toEqual({
            action: 'run',
            maxResults: 322,
            remainingBudgetUsd: 2.0,
            medianUnitCostUsd: 0.0062,
            usedFallback: false,
        })
    })

    it('caps maxResults at the territory\'s own limit even when the budget could afford more', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 40 }, // e.g. Hudson's seeded cap
            recentUnitCostsUsd: [0.0066, 0.0061, 0.0062],
        })
        expect(decision).toMatchObject({ action: 'run', maxResults: 40, usedFallback: false })
    })

    it('skips a run whose computed size falls below the floor rather than firing a pointless scrape', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 1.94,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 500 },
            recentUnitCostsUsd: [0.0066, 0.0061, 0.0062],
        })
        // remaining ~= 0.06; median = 0.0062; floor(0.06 / 0.0062) = 9, below the default floor of 10
        expect(decision).toMatchObject({
            action: 'skip',
            reason: 'below_floor',
            computedMaxResults: 9,
            floorResults: DEFAULT_MIN_RESULTS_FLOOR,
            medianUnitCostUsd: 0.0062,
            usedFallback: false,
        })
        if (decision.action === 'skip' && decision.reason === 'below_floor') {
            expect(decision.remainingBudgetUsd).toBeCloseTo(0.06, 10)
        }
    })

    it('honors a custom floor override', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 15 },
            recentUnitCostsUsd: [],
            floorResults: 20,
        })
        expect(decision).toMatchObject({ action: 'skip', reason: 'below_floor', computedMaxResults: 15, floorResults: 20 })
    })

    it('runs exactly at the floor (inclusive, not exclusive)', () => {
        const decision = decideDailyProspectingRun({
            spentTodayUsd: 0,
            dailyBudgetUsd: 2.0,
            territory: { maxResults: 10 },
            recentUnitCostsUsd: [],
        })
        expect(decision).toMatchObject({ action: 'run', maxResults: 10 })
    })
})

describe('resolveXcraperConfig', () => {
    it('is null when both variables are missing', () => {
        expect(resolveXcraperConfig({})).toBeNull()
    })

    it('is null when only the URL is set', () => {
        expect(resolveXcraperConfig({ XCRAPER_SERVICE_URL: 'https://xcraper.skale.club/api/service' })).toBeNull()
    })

    it('is null when only the key is set', () => {
        expect(resolveXcraperConfig({ XCRAPER_SERVICE_KEY: 'xsk_test' })).toBeNull()
    })

    it('is null when either value is only whitespace', () => {
        expect(resolveXcraperConfig({
            XCRAPER_SERVICE_URL: '   ',
            XCRAPER_SERVICE_KEY: 'xsk_test',
        })).toBeNull()
    })

    it('resolves both values, trimmed, when both are present', () => {
        expect(resolveXcraperConfig({
            XCRAPER_SERVICE_URL: ' https://xcraper.skale.club/api/service ',
            XCRAPER_SERVICE_KEY: ' xsk_test ',
        })).toEqual({
            url: 'https://xcraper.skale.club/api/service',
            key: 'xsk_test',
        })
    })
})

describe('resolveDailyBudgetUsd', () => {
    it('defaults to $2.00 when unset', () => {
        expect(resolveDailyBudgetUsd({})).toBe(DEFAULT_DAILY_BUDGET_USD)
    })

    it('parses a configured value', () => {
        expect(resolveDailyBudgetUsd({ PROSPECTING_DAILY_BUDGET_USD: '5.50' })).toBe(5.5)
    })

    it('falls back to the default on an unparseable value rather than disabling the engine', () => {
        expect(resolveDailyBudgetUsd({ PROSPECTING_DAILY_BUDGET_USD: 'not-a-number' })).toBe(DEFAULT_DAILY_BUDGET_USD)
    })

    it('falls back to the default on a non-positive value', () => {
        expect(resolveDailyBudgetUsd({ PROSPECTING_DAILY_BUDGET_USD: '0' })).toBe(DEFAULT_DAILY_BUDGET_USD)
        expect(resolveDailyBudgetUsd({ PROSPECTING_DAILY_BUDGET_USD: '-1' })).toBe(DEFAULT_DAILY_BUDGET_USD)
    })
})
