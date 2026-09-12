import { describe, expect, it } from 'vitest'
import {
    decideTerritoryReconciliation,
    STALLED_RUNNING_THRESHOLD_MS,
} from './territory-reconciliation'

describe('decideTerritoryReconciliation', () => {
    it('leaves the territory running (does not flip to done itself) when the scrape completed', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'completed',
            elapsedSinceAttemptMs: 60_000,
        })
        expect(decision).toEqual({ action: 'completed' })
    })

    it('reports completed regardless of how long the territory has been running', () => {
        // A completed scrape from an old, previously-unpolled territory (the exact shape of the
        // two production territories stuck since 2026-09-11/12) must still resolve as completed,
        // not stalled -- completed/failed take priority over the elapsed-time check.
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'completed',
            elapsedSinceAttemptMs: STALLED_RUNNING_THRESHOLD_MS * 10,
        })
        expect(decision).toEqual({ action: 'completed' })
    })

    it('marks the territory failed with a reason when Xcraper reports the scrape failed', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'failed',
            elapsedSinceAttemptMs: 60_000,
        })
        expect(decision.action).toBe('failed')
        expect((decision as { action: 'failed'; reason: string }).reason).toMatch(/failed/i)
    })

    it('reports failed regardless of elapsed time, same priority as completed', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'failed',
            elapsedSinceAttemptMs: 0,
        })
        expect(decision.action).toBe('failed')
    })

    it('reports still_running for an in-progress status well under the stall threshold', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'processing',
            elapsedSinceAttemptMs: 5 * 60 * 1000, // 5 minutes -- ordinary scrape duration
        })
        expect(decision).toEqual({ action: 'still_running' })
    })

    it('treats any non-completed, non-failed status the same way (unknown Xcraper vocabulary is not special-cased)', () => {
        for (const scrapeStatus of ['pending', 'queued', 'running', 'some-new-status-xcraper-added-later']) {
            expect(decideTerritoryReconciliation({ scrapeStatus, elapsedSinceAttemptMs: 1_000 })).toEqual({
                action: 'still_running',
            })
        }
    })

    it('reports stalled once elapsed time reaches the default 48h threshold with no terminal status', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'processing',
            elapsedSinceAttemptMs: STALLED_RUNNING_THRESHOLD_MS,
        })
        expect(decision).toEqual({ action: 'stalled' })
    })

    it('is not yet stalled one millisecond before the threshold', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'processing',
            elapsedSinceAttemptMs: STALLED_RUNNING_THRESHOLD_MS - 1,
        })
        expect(decision).toEqual({ action: 'still_running' })
    })

    it('honors a custom stalledThresholdMs override for tests without waiting on the real 48h constant', () => {
        const decision = decideTerritoryReconciliation({
            scrapeStatus: 'processing',
            elapsedSinceAttemptMs: 1_000,
            stalledThresholdMs: 500,
        })
        expect(decision).toEqual({ action: 'stalled' })
    })

    it('never returns an action that would cause a caller to re-fire a scrape -- only completed/failed/still_running/stalled exist', () => {
        // Documents the invariant by construction: the decision type has exactly four shapes,
        // none of which are "run" or "retry". A paid scrape can only ever be started by
        // runDailyProspecting's own fetchNextQueuedTerritory + callXcraperScrape path, never by
        // this reconciliation step.
        const allActions = new Set(
            [
                decideTerritoryReconciliation({ scrapeStatus: 'completed', elapsedSinceAttemptMs: 0 }),
                decideTerritoryReconciliation({ scrapeStatus: 'failed', elapsedSinceAttemptMs: 0 }),
                decideTerritoryReconciliation({ scrapeStatus: 'processing', elapsedSinceAttemptMs: 0 }),
                decideTerritoryReconciliation({
                    scrapeStatus: 'processing',
                    elapsedSinceAttemptMs: STALLED_RUNNING_THRESHOLD_MS,
                }),
            ].map((d) => d.action),
        )
        expect(allActions).toEqual(new Set(['completed', 'failed', 'still_running', 'stalled']))
    })
})
