import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Pure unit tests — no DB. `queryClient` is mocked (both the run-listing SELECT and the
 * batched UPDATE...RETURNING), and `recordRunEvents` is mocked so journey-event assertions
 * don't touch drizzle's `db`. Follows the sibling job-test placement convention from
 * src/server/jobs/enforceDeliverabilityGuardrails.test.ts and
 * src/server/jobs/amortizeSubscriptionCosts.test.ts.
 */

const queryClientMock = vi.hoisted(() => vi.fn())
const recordRunEventsMock = vi.hoisted(() => vi.fn())

vi.mock('../../db', () => ({ db: {}, queryClient: queryClientMock }))
vi.mock('../lib/prospecting/journey', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/prospecting/journey')>()
    return { ...actual, recordRunEvents: recordRunEventsMock }
})

import { aggregateRunOutcomes, measureProspectingOutcomes } from './measureProspectingOutcomes'
import { RUN_EVENT_CODES } from '../lib/prospecting/journey'

function sourceRow(overrides: Partial<Parameters<typeof aggregateRunOutcomes>[0][number]> = {}) {
    return {
        runId: 'run-1',
        organizationId: 'org-1',
        attributionPath: 'candidate' as const,
        importedAs: 'created' as const,
        leadId: 'lead-1',
        leadStatus: 'contacted',
        emailVerificationStatus: null,
        sentAt: null,
        repliedAt: null,
        bouncedAt: null,
        unsubscribedAt: null,
        ...overrides,
    }
}

/** A path-(b) row: xcraper/Xphere lead attributed via custom_fields.source_run_id, never
 * routed through prospect_candidates. `importedAs` is always null on this path — the SQL
 * that produces it already scoped the match to the run's idempotency_key. */
function customFieldRow(overrides: Partial<Parameters<typeof aggregateRunOutcomes>[0][number]> = {}) {
    return sourceRow({ attributionPath: 'custom_field', importedAs: null, ...overrides })
}

function runSnapshot(overrides: Partial<{
    id: string
    organizationId: string
    outcomeEmailed: number
    outcomeReplied: number
    outcomePositiveReplied: number
    outcomeBounced: number
    outcomeUnsubscribed: number
    discoveredCount: number
    hypothesis: Record<string, unknown> | null
}> = {}) {
    return {
        id: 'run-1',
        organizationId: 'org-1',
        outcomeEmailed: 0,
        outcomeReplied: 0,
        outcomePositiveReplied: 0,
        outcomeBounced: 0,
        outcomeUnsubscribed: 0,
        discoveredCount: 0,
        hypothesis: null,
        ...overrides,
    }
}

beforeEach(() => {
    queryClientMock.mockReset()
    recordRunEventsMock.mockReset()
})

describe('aggregateRunOutcomes', () => {
    it('excludes candidates with imported_as = existing', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ importedAs: 'existing', sentAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toBeUndefined()
    })

    it('excludes candidates with imported_as = null (pre-migration rows)', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ importedAs: null, sentAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toBeUndefined()
    })

    it('counts a lead once even when it has several sent emails', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ sentAt: '2026-08-01T00:00:00.000Z' }),
            sourceRow({ sentAt: '2026-08-05T00:00:00.000Z' }),
            sourceRow({ sentAt: '2026-08-10T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeEmailed: 1 })
    })

    it('does not count a lead that was imported but never emailed', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ sentAt: null }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeEmailed: 0 })
    })

    it('only counts outcomePositiveReplied for leads whose status is interested', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ leadId: 'lead-interested', leadStatus: 'interested', repliedAt: '2026-08-01T00:00:00.000Z' }),
            sourceRow({ leadId: 'lead-replied-only', leadStatus: 'replied', repliedAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeReplied: 2, outcomePositiveReplied: 1 })
    })

    it('attributes rows to distinct runs independently', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ runId: 'run-1', leadId: 'lead-a', sentAt: '2026-08-01T00:00:00.000Z' }),
            sourceRow({ runId: 'run-2', leadId: 'lead-b', bouncedAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeEmailed: 1, outcomeBounced: 0 })
        expect(result.get('run-2')).toMatchObject({ outcomeEmailed: 0, outcomeBounced: 1 })
    })

    // ------------------------------------------------------------
    // Phase 32 follow-up: custom_fields.source_run_id attribution path (real production
    // path — xcraper/Xphere leads never touch prospect_candidates at all).
    // ------------------------------------------------------------

    it('counts a lead attributed only via custom_fields.source_run_id (no prospect_candidates row)', () => {
        const result = aggregateRunOutcomes([
            customFieldRow({ leadId: 'lead-cf', sentAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeEmailed: 1 })
    })

    it('counts a lead reachable via BOTH the candidate path and the custom_fields path exactly once', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ leadId: 'lead-both', importedAs: 'created', sentAt: '2026-08-01T00:00:00.000Z' }),
            customFieldRow({ leadId: 'lead-both', repliedAt: '2026-08-02T00:00:00.000Z' }),
        ])
        // One lead, one count each for emailed and replied — not two.
        expect(result.get('run-1')).toMatchObject({ outcomeEmailed: 1, outcomeReplied: 1 })
    })

    it('does not credit a run with a lead whose source_run_id names a different run', () => {
        // The SQL join already scopes each custom_field row to the run whose
        // idempotency_key matched — a lead sourced by run-2 never produces a row under
        // run-1 in the first place. Simulate that: the lead only ever appears attributed
        // to run-2, and run-1's aggregate must have no trace of it.
        const result = aggregateRunOutcomes([
            customFieldRow({ runId: 'run-2', leadId: 'lead-elsewhere', sentAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toBeUndefined()
        expect(result.get('run-2')).toMatchObject({ outcomeEmailed: 1 })
    })

    it('excludes a custom_field row with no leadId', () => {
        const result = aggregateRunOutcomes([
            customFieldRow({ leadId: null, sentAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toBeUndefined()
    })

    it('does not count a custom_field-attributed lead that was imported but never emailed', () => {
        const result = aggregateRunOutcomes([
            customFieldRow({ leadId: 'lead-cf-no-email', sentAt: null }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeEmailed: 0 })
    })

    it('only counts outcomePositiveReplied for a custom_field-attributed lead whose status is interested', () => {
        const result = aggregateRunOutcomes([
            customFieldRow({ leadId: 'lead-cf-interested', leadStatus: 'interested', repliedAt: '2026-08-01T00:00:00.000Z' }),
            customFieldRow({ leadId: 'lead-cf-replied-only', leadStatus: 'replied', repliedAt: '2026-08-01T00:00:00.000Z' }),
        ])
        expect(result.get('run-1')).toMatchObject({ outcomeReplied: 2, outcomePositiveReplied: 1 })
    })

    // ------------------------------------------------------------
    // Hypothesis-scoring follow-up: attributedLeadCount / verifiedOrLikelyLeadCount
    // ------------------------------------------------------------

    it('counts every attributed lead, verified/likely or not, toward attributedLeadCount', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ leadId: 'lead-a', emailVerificationStatus: 'verified' }),
            sourceRow({ leadId: 'lead-b', emailVerificationStatus: 'invalid' }),
            sourceRow({ leadId: 'lead-c', emailVerificationStatus: null }),
        ])
        expect(result.get('run-1')).toMatchObject({ attributedLeadCount: 3, verifiedOrLikelyLeadCount: 1 })
    })

    it('counts both verified and likely as verifiedOrLikelyLeadCount', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ leadId: 'lead-a', emailVerificationStatus: 'verified' }),
            sourceRow({ leadId: 'lead-b', emailVerificationStatus: 'likely' }),
        ])
        expect(result.get('run-1')).toMatchObject({ attributedLeadCount: 2, verifiedOrLikelyLeadCount: 2 })
    })

    it('counts a lead toward attribution even when it was never emailed', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ leadId: 'lead-a', emailVerificationStatus: 'verified', sentAt: null }),
        ])
        expect(result.get('run-1')).toMatchObject({ attributedLeadCount: 1, verifiedOrLikelyLeadCount: 1, outcomeEmailed: 0 })
    })

    it('does not double count a lead attributed via both paths toward attributedLeadCount', () => {
        const result = aggregateRunOutcomes([
            sourceRow({ leadId: 'lead-both', importedAs: 'created', emailVerificationStatus: 'verified' }),
            customFieldRow({ leadId: 'lead-both', emailVerificationStatus: 'verified' }),
        ])
        expect(result.get('run-1')).toMatchObject({ attributedLeadCount: 1, verifiedOrLikelyLeadCount: 1 })
    })
})

describe('measureProspectingOutcomes', () => {
    it('does not throw when the run-listing query fails', async () => {
        queryClientMock.mockRejectedValueOnce(new Error('db unreachable'))

        await expect(measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))).resolves.toEqual({
            examined: 0, updated: 0,
        })
        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    it('does not throw when the source-rows query fails', async () => {
        queryClientMock
            .mockResolvedValueOnce([runSnapshot()])
            .mockRejectedValueOnce(new Error('db unreachable'))

        await expect(measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))).resolves.toEqual({
            examined: 1, updated: 0,
        })
        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    it('does not throw when the batched update query fails', async () => {
        queryClientMock
            .mockResolvedValueOnce([runSnapshot()])
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('db unreachable'))

        await expect(measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))).resolves.toEqual({
            examined: 1, updated: 0,
        })
        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    it('does nothing (no update query, no events) when there are no imported runs', async () => {
        queryClientMock.mockResolvedValueOnce([])

        const summary = await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ examined: 0, updated: 0 })
        expect(queryClientMock).toHaveBeenCalledTimes(1)
        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    it('emits an outcome.emailed event when outcomeEmailed changes', async () => {
        queryClientMock
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 0 })])
            .mockResolvedValueOnce([sourceRow({ sentAt: '2026-08-01T00:00:00.000Z' })])
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 1 })])

        const summary = await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ examined: 1, updated: 1 })
        expect(recordRunEventsMock).toHaveBeenCalledTimes(1)
        const events = recordRunEventsMock.mock.calls[0][1]
        expect(events).toEqual([
            expect.objectContaining({ code: RUN_EVENT_CODES.outcome.EMAILED, runId: 'run-1', organizationId: 'org-1' }),
        ])
        expect(events[0].detail).toMatchObject({ outcomeEmailed: 1 })
    })

    it('does not emit any journey event when counters are identical to the previous measurement', async () => {
        const unchanged = runSnapshot({ outcomeEmailed: 3, outcomeReplied: 1, outcomePositiveReplied: 1, outcomeBounced: 0, outcomeUnsubscribed: 0 })
        queryClientMock
            .mockResolvedValueOnce([unchanged])
            .mockResolvedValueOnce([
                sourceRow({ leadId: 'lead-a', leadStatus: 'interested', sentAt: '2026-08-01T00:00:00.000Z', repliedAt: '2026-08-02T00:00:00.000Z' }),
                sourceRow({ leadId: 'lead-b', sentAt: '2026-08-01T00:00:00.000Z' }),
                sourceRow({ leadId: 'lead-c', sentAt: '2026-08-01T00:00:00.000Z' }),
            ])
            .mockResolvedValueOnce([unchanged])

        const summary = await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ examined: 1, updated: 1 })
        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    it('defaults a run with zero attributable candidates to zero counters (still updated, no events)', async () => {
        queryClientMock
            .mockResolvedValueOnce([runSnapshot()])
            .mockResolvedValueOnce([sourceRow({ importedAs: 'existing', sentAt: '2026-08-01T00:00:00.000Z' })])
            .mockResolvedValueOnce([runSnapshot()])

        const summary = await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ examined: 1, updated: 1 })
        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    // ------------------------------------------------------------
    // Hypothesis-scoring follow-up
    // ------------------------------------------------------------

    it('emits outcome.hypothesis_confirmed when the reply-rate expectation newly becomes met', async () => {
        const hypothesis = { expected: { reply_rate: '>=0.03' } }
        queryClientMock
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 0, outcomeReplied: 0, hypothesis })])
            .mockResolvedValueOnce([
                sourceRow({ leadId: 'lead-a', sentAt: '2026-08-01T00:00:00.000Z', repliedAt: '2026-08-02T00:00:00.000Z' }),
            ])
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 1, outcomeReplied: 1, hypothesis })])

        const summary = await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ examined: 1, updated: 1 })
        const events = recordRunEventsMock.mock.calls[0][1]
        const hypothesisEvent = events.find((e: { code: string }) => e.code === RUN_EVENT_CODES.outcome.HYPOTHESIS_CONFIRMED)
        expect(hypothesisEvent).toBeDefined()
        expect(hypothesisEvent.organizationId).toBe('org-1')
        expect(hypothesisEvent.runId).toBe('run-1')
        expect(hypothesisEvent.detail.overall).toBe('confirmed')
        expect(hypothesisEvent.detail.metrics).toEqual([
            expect.objectContaining({ metric: 'reply_rate', actual: 1, verdict: 'met' }),
        ])
        expect(hypothesisEvent.summary).toContain('reply_rate')
    })

    it('emits outcome.hypothesis_refuted when an expectation is not met, naming the failing metric with expected vs actual', async () => {
        const hypothesis = { expected: { discovered: '>=30', reply_rate: '>=0.50' } }
        queryClientMock
            .mockResolvedValueOnce([runSnapshot({ discoveredCount: 40, outcomeEmailed: 0, outcomeReplied: 0, hypothesis })])
            .mockResolvedValueOnce([
                sourceRow({ leadId: 'lead-a', sentAt: '2026-08-01T00:00:00.000Z', repliedAt: '2026-08-02T00:00:00.000Z' }),
                sourceRow({ leadId: 'lead-b', sentAt: '2026-08-01T00:00:00.000Z' }),
                sourceRow({ leadId: 'lead-c', sentAt: '2026-08-01T00:00:00.000Z' }),
            ])
            .mockResolvedValueOnce([runSnapshot({ discoveredCount: 40, outcomeEmailed: 3, outcomeReplied: 1, hypothesis })])

        const summary = await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(summary).toEqual({ examined: 1, updated: 1 })
        const events = recordRunEventsMock.mock.calls[0][1]
        const hypothesisEvent = events.find((e: { code: string }) => e.code === RUN_EVENT_CODES.outcome.HYPOTHESIS_REFUTED)
        expect(hypothesisEvent).toBeDefined()
        expect(hypothesisEvent.detail.overall).toBe('refuted')
        // discovered (>=30, actual 40) is met; reply_rate (>=0.50, actual 1/3 ≈ 0.333) is
        // the one that fails — the payload must name it with expected vs actual, not
        // merely assert a refutation happened.
        const replyRateMetric = hypothesisEvent.detail.metrics.find((m: { metric: string }) => m.metric === 'reply_rate')
        expect(replyRateMetric).toMatchObject({ metric: 'reply_rate', expected: '>=0.50', verdict: 'not_met' })
        expect(replyRateMetric.actual).toBeCloseTo(1 / 3, 5)
        const discoveredMetric = hypothesisEvent.detail.metrics.find((m: { metric: string }) => m.metric === 'discovered')
        expect(discoveredMetric).toMatchObject({ verdict: 'met', actual: 40 })
        expect(hypothesisEvent.summary).toContain('reply_rate')
        expect(hypothesisEvent.summary).toContain('>=0.50')
    })

    it('does not emit a hypothesis event when the run has no stated hypothesis', async () => {
        queryClientMock
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 0, hypothesis: null })])
            .mockResolvedValueOnce([sourceRow({ sentAt: '2026-08-01T00:00:00.000Z' })])
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 1, hypothesis: null })])

        await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        const events = recordRunEventsMock.mock.calls[0][1]
        expect(events.some((e: { code: string }) => e.code.startsWith('outcome.hypothesis'))).toBe(false)
    })

    it('does not emit a hypothesis event when the run has a hypothesis but no expected metrics', async () => {
        const hypothesis = { premise: 'some premise', basis: 'some basis' }
        queryClientMock
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 0, hypothesis })])
            .mockResolvedValueOnce([sourceRow({ sentAt: '2026-08-01T00:00:00.000Z' })])
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 1, hypothesis })])

        await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        const events = recordRunEventsMock.mock.calls[0][1]
        expect(events.some((e: { code: string }) => e.code.startsWith('outcome.hypothesis'))).toBe(false)
    })

    it('does not re-emit a hypothesis event when the verdict is unchanged across a pass (still zero-denominator)', async () => {
        // reply_rate expectation stays unknown before and after because emailedCount is 0
        // both times (the run's leads were only ever bounced, never emailed) — overall
        // stays 'inconclusive' throughout, which never emits.
        const hypothesis = { expected: { reply_rate: '>=0.03' } }
        const unchanged = runSnapshot({ outcomeEmailed: 0, outcomeReplied: 0, outcomeBounced: 1, hypothesis })
        queryClientMock
            .mockResolvedValueOnce([unchanged])
            .mockResolvedValueOnce([sourceRow({ leadId: 'lead-a', bouncedAt: '2026-08-01T00:00:00.000Z' })])
            .mockResolvedValueOnce([unchanged])

        await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(recordRunEventsMock).not.toHaveBeenCalled()
    })

    it('does not re-emit a hypothesis event once a verdict has stabilized (only counts grew, verdict unchanged)', async () => {
        // Both before and after, reply_rate (>=0.03) is comfortably met — 1/10 before,
        // 2/20 after are both 'met', so overall stays 'confirmed' both times despite the
        // raw actual/reason values differing. A naive diff on the raw numbers would
        // re-emit here; the categorical-signature comparison must not. outcomeEmailed and
        // outcomeReplied DO change, so outcome.emailed/outcome.replied still fire — this
        // test only asserts no hypothesis event rides along with them.
        const hypothesis = { expected: { reply_rate: '>=0.03' } }
        queryClientMock
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 10, outcomeReplied: 1, hypothesis })])
            .mockResolvedValueOnce([
                sourceRow({ leadId: 'lead-a', sentAt: '2026-08-01T00:00:00.000Z', repliedAt: '2026-08-02T00:00:00.000Z' }),
            ])
            .mockResolvedValueOnce([runSnapshot({ outcomeEmailed: 20, outcomeReplied: 2, hypothesis })])

        await measureProspectingOutcomes(new Date('2026-08-13T00:00:00.000Z'))

        expect(recordRunEventsMock).toHaveBeenCalledTimes(1)
        const events = recordRunEventsMock.mock.calls[0][1]
        expect(events.some((e: { code: string }) => e.code.startsWith('outcome.hypothesis'))).toBe(false)
    })
})
