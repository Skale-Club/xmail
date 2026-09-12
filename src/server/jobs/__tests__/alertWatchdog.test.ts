/**
 * `runAlertWatchdog` orchestration — no DB, no Telegram. `db`, `node:fs/promises` (statfs),
 * `reportOpsCondition` and the pino logger are mocked (same convention as
 * cron-lock.test.ts / amortizeSubscriptionCosts.test.ts); `computeSilenceMetrics` is mocked
 * per the task brief ("mock the silence query") while the real `buildSilenceAlerts` runs
 * against the fixture metrics, so these tests also pin the real rule wiring, not just a stub.
 *
 * What these guard against: `buildSilenceAlerts` (outreach-silence.ts) had exactly one caller
 * in the whole codebase — the on-demand admin route `routes/admin/outreach-health.ts` — which
 * nothing polls. The detector never spoke in production. These tests exist so a future change
 * cannot silently detach `runAlertWatchdog` from the silence rules again without a test noticing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { reportOpsCondition } from '../../lib/ops-alert'
import type { computeSilenceMetrics } from '../../lib/outreach-silence-query'

const logMock = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}))
const reportOpsConditionMock = vi.hoisted(() => vi.fn<typeof reportOpsCondition>(async () => {}))
const computeSilenceMetricsMock = vi.hoisted(() => vi.fn<typeof computeSilenceMetrics>())
const dbQueueRows = vi.hoisted(() => ({ current: [{ stuck: 0 }] as Array<{ stuck: number }> }))
const statfsMock = vi.hoisted(() => vi.fn())

vi.mock('../../lib/logger', () => ({ createLogger: () => logMock }))
vi.mock('../../lib/ops-alert', () => ({ reportOpsCondition: reportOpsConditionMock }))
vi.mock('../../lib/outreach-silence-query', () => ({ computeSilenceMetrics: computeSilenceMetricsMock }))
vi.mock('../../../db', () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => Promise.resolve(dbQueueRows.current),
            }),
        }),
    },
}))
vi.mock('node:fs/promises', () => ({ statfs: statfsMock }))

import { __resetAlertWatchdogSilenceState, runAlertWatchdog } from '../alertWatchdog'
import type { SilenceMetrics } from '../../lib/outreach-silence'

const NOW = new Date('2026-09-08T15:00:00Z') // past ENGINE_IDLE_CHECK_AFTER_UTC_HOUR

/** A fully "healthy" fixture — mirrors outreach-silence.test.ts's own baseline — so tests that
 * only care about one rule don't have to know every other rule's healthy shape. */
function healthySilenceMetrics(overrides: Partial<SilenceMetrics> = {}): SilenceMetrics {
    return {
        warmupEligibleInboxes: 7,
        warmupSends24h: 12,
        credentialKeyMismatches24h: 0,
        enrichedRunsWithoutLeads: 0,
        enrichedRunsWithoutEnrichmentCount: 0,
        doubleEncodedJsonbColumns: [],
        staleAdvisoryLocks: [],
        recentJobTimeouts: { windowMs: 60 * 60 * 1000, total: 0, byJob: {} },
        inFlightJobs: { inFlight: 0, orphaned: 0, oldestAgeMs: null, orphansByJob: {} },
        staleProspectingRunsWithoutLeads: 0,
        oldestStaleProspectingRunAgeDays: 0,
        rampedWarmupInboxes: 0,
        outreachSends7d: 0,
        costEntries35d: 0,
        unpricedCostEntries35d: 0,
        unpricedCostCategories: [],
        verificationMissingRuns: 0,
        leadSourceCostEntriesToday: 1,
        spentTodayUsd: 0.5,
        dailyBudgetUsd: 2,
        queuedTerritories: 2,
        enrichedZeroEmailRuns: 0,
        totalTerritories: 5,
        activeTerritories: 2,
        analyzerStalledEvents24h: 0,
        // Fase 5 -- healthy baseline, mirrors outreach-silence.test.ts's own fixture.
        externalWarmupMessagesWithFolder24h: 100,
        externalWarmupSpamMessages24h: 0,
        totalDmarcReportsEver: 5,
        lastDmarcReportProcessedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        outboundDkimUnverified24h: 0,
        // healthy baseline -- outbox drained, mirrors outreach-silence.test.ts's own fixture.
        pendingXphereEvents: 0,
        oldestPendingXphereEventAgeMinutes: null,
        ...overrides,
    }
}

/** Every reportOpsCondition call whose key starts with "silence.". */
function silenceCalls() {
    return reportOpsConditionMock.mock.calls.filter(([key]) => String(key).startsWith('silence.'))
}

beforeEach(() => {
    __resetAlertWatchdogSilenceState()
    reportOpsConditionMock.mockClear()
    logMock.info.mockClear()
    logMock.warn.mockClear()
    computeSilenceMetricsMock.mockReset()
    computeSilenceMetricsMock.mockResolvedValue(healthySilenceMetrics())
    dbQueueRows.current = [{ stuck: 0 }]
    statfsMock.mockReset()
    // A disk usage comfortably under DISK_WARN_PERCENT so checkDisk never alerts by accident.
    statfsMock.mockResolvedValue({ blocks: 100, bsize: 1, bfree: 80 })
})

describe('runAlertWatchdog: silence findings', () => {
    it('reports a silence finding through reportOpsCondition, keyed by the finding kind', async () => {
        computeSilenceMetricsMock.mockResolvedValue(
            healthySilenceMetrics({ credentialKeyMismatches24h: 3 }),
        )

        await runAlertWatchdog(NOW)

        const calls = silenceCalls()
        expect(calls).toHaveLength(1)
        const [key, isFailing, messages] = calls[0]
        expect(key).toBe('silence.credential_key_mismatch')
        expect(isFailing).toBe(true)
        expect(messages.failBody).toContain('3 send(s) failed')
    })

    it('keys each finding independently, so two findings become two conditions', async () => {
        computeSilenceMetricsMock.mockResolvedValue(
            healthySilenceMetrics({
                credentialKeyMismatches24h: 1,
                totalTerritories: 5,
                activeTerritories: 0,
            }),
        )

        await runAlertWatchdog(NOW)

        const keys = silenceCalls().map(([key]) => key).sort()
        expect(keys).toEqual(['silence.credential_key_mismatch', 'silence.territory_queue_empty'])
    })

    it('resolves a condition the tick after it stops appearing', async () => {
        computeSilenceMetricsMock.mockResolvedValue(
            healthySilenceMetrics({ credentialKeyMismatches24h: 2 }),
        )
        await runAlertWatchdog(NOW)
        reportOpsConditionMock.mockClear()

        computeSilenceMetricsMock.mockResolvedValue(healthySilenceMetrics())
        await runAlertWatchdog(NOW)

        const calls = silenceCalls()
        expect(calls).toHaveLength(1)
        const [key, isFailing] = calls[0]
        expect(key).toBe('silence.credential_key_mismatch')
        expect(isFailing).toBe(false)
    })

    it('does not resolve a condition that is still active', async () => {
        computeSilenceMetricsMock.mockResolvedValue(
            healthySilenceMetrics({ credentialKeyMismatches24h: 2 }),
        )
        await runAlertWatchdog(NOW)
        reportOpsConditionMock.mockClear()

        await runAlertWatchdog(NOW)

        const calls = silenceCalls()
        expect(calls).toHaveLength(1)
        expect(calls[0][1]).toBe(true) // still failing, not resolved
    })

    it('produces no silence alerts and still logs the tick when nothing is wrong', async () => {
        await runAlertWatchdog(NOW)

        expect(silenceCalls()).toHaveLength(0)
        expect(logMock.info).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'ops.watchdog.silence_checked', findingCount: 0 }),
            expect.any(String),
        )
    })

    it('logs the finding count on every tick, including when findings are present', async () => {
        computeSilenceMetricsMock.mockResolvedValue(
            healthySilenceMetrics({ credentialKeyMismatches24h: 1 }),
        )

        await runAlertWatchdog(NOW)

        expect(logMock.info).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'ops.watchdog.silence_checked', findingCount: 1 }),
            expect.any(String),
        )
    })
})

describe('runAlertWatchdog: isolation from a failing silence query', () => {
    it('still evaluates queue, memory and disk when the silence query throws', async () => {
        computeSilenceMetricsMock.mockRejectedValue(new Error('db unreachable'))
        dbQueueRows.current = [{ stuck: 4 }]

        await runAlertWatchdog(NOW)

        const keys = reportOpsConditionMock.mock.calls.map(([key]) => key)
        expect(keys).toContain('queue.stalled')
        expect(keys).toContain('process.memory')
        expect(keys).toContain('host.disk')
        expect(silenceCalls()).toHaveLength(0)
    })

    it('logs the silence check as a failed watchdog check, not a thrown error', async () => {
        computeSilenceMetricsMock.mockRejectedValue(new Error('db unreachable'))

        await expect(runAlertWatchdog(NOW)).resolves.toBeUndefined()

        expect(logMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'ops.watchdog.check_failed', check: 'silence' }),
            expect.any(String),
        )
    })
})
