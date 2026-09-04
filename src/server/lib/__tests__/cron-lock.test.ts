/**
 * Pure unit tests for runWithLock's timeout budget, structured logging, pool snapshot and
 * recent-timeout counter — no DB. `queryClient` and the pino logger are mocked; see
 * amortizeSubscriptionCosts.test.ts for the sibling job-test mocking convention this follows.
 *
 * The defect these tests guard against (see cron-lock.ts's BUDGET doc): `fn()` used to run
 * unbounded inside the transaction. A hung IMAP/SMTP socket with no timeout of its own meant the
 * `finally` that COMMITs (and releases the advisory lock) never ran, and the lock stayed held
 * forever. `runWithLock` now races `fn()` against a timeout so the lock always clears.
 *
 * 2026-09-04 additions (post-incident instrumentation, see cron-lock.ts's INSTRUMENTATION note):
 * a structured `cron.lock.run` line on every outcome, the timeout/lock-failure/release-failure
 * paths routed through the pino logger instead of console.error, the best-effort pool snapshot,
 * and the in-memory `getRecentJobTimeouts` ring the parallel silence-detector work reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reserveMock = vi.hoisted(() => vi.fn())
const logMock = vi.hoisted(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
}))

vi.mock('../../../db', () => ({ db: {}, queryClient: { reserve: reserveMock } }))
vi.mock('../logger', () => ({ createLogger: () => logMock }))

import { getInFlightJobs, getPoolSnapshot, getRecentJobTimeouts, runWithLock } from '../cron-lock'

interface ReservedMock {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
    unsafe: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    calls: string[]
}

/** Fakes the single reserved connection runWithLock BEGINs/locks/COMMITs on. */
function makeReserved(options: { acquired?: boolean } = {}): ReservedMock {
    const acquired = options.acquired ?? true
    const calls: string[] = []
    const template = vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('?')
        calls.push(text)
        if (text.includes('pg_try_advisory_xact_lock')) {
            return [{ got: acquired }]
        }
        return []
    }) as unknown as ReservedMock
    template.unsafe = vi.fn(async (verb: string) => {
        calls.push(verb)
    })
    template.release = vi.fn()
    template.calls = calls
    return template
}

/** A promise plus externally-callable resolve/reject — lets a test control settlement timing. */
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

beforeEach(() => {
    reserveMock.mockReset()
    logMock.info.mockClear()
    logMock.error.mockClear()
    logMock.warn.mockClear()
    logMock.debug.mockClear()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('runWithLock — job timeout budget', () => {
    it('times out a job that never settles, and the lock-releasing COMMIT still runs', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)

        const hang = deferred<void>() // never resolved or rejected — simulates a hung socket
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('never-settles', fn, { timeoutMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        await run

        // Distinct, greppable timeout log — not the routine "already running … skipping" line.
        // Routed through the structured logger (Task 3), not console.error.
        expect(logMock.error.mock.calls.some(([payload, message]) => (
            (payload as { action?: unknown })?.action === 'cron.lock.job_timeout'
            && typeof message === 'string' && message.includes('cron.lock.job_timeout')
        ))).toBe(true)

        // The lock-releasing path still ran: COMMIT happened and the connection went back to the pool.
        expect(reserved.calls).toContain('COMMIT')
        expect(reserved.release).toHaveBeenCalledTimes(1)

        // fn() itself is still pending — it was never cancelled, only abandoned.
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('does not log a timeout, and still commits, for a normal fast job', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)

        const fn = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0))
        })

        await runWithLock('fast-job', fn, { timeoutMs: 60_000 })

        expect(fn).toHaveBeenCalledTimes(1)
        expect(reserved.calls).toContain('COMMIT')
        expect(reserved.release).toHaveBeenCalledTimes(1)
        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown })?.action === 'cron.lock.job_timeout'
        ))).toBe(false)
    })

    it('propagates a real error from fn() unchanged, and still commits (unaffected by the timeout race)', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)

        const boom = new Error('boom')
        const fn = vi.fn(async () => {
            throw boom
        })

        await expect(runWithLock('failing-job', fn, { timeoutMs: 60_000 })).rejects.toBe(boom)
        expect(reserved.calls).toContain('COMMIT')
        expect(reserved.release).toHaveBeenCalledTimes(1)
    })

    it('is configurable per call — a short timeout fires even though the default budget is 10 minutes', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)

        const hang = deferred<void>()
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('short-budget-job', fn, { timeoutMs: 5 })
        await vi.advanceTimersByTimeAsync(5)
        await run

        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown })?.action === 'cron.lock.job_timeout'
        ))).toBe(true)
    })

    it('uses the 10-minute default when no timeoutMs override is given', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)

        const hang = deferred<void>()
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('default-budget-job', fn)

        // Just under 10 minutes: still hung, no timeout yet.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1)
        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown })?.action === 'cron.lock.job_timeout'
        ))).toBe(false)

        // Crossing 10 minutes: timeout fires.
        await vi.advanceTimersByTimeAsync(1)
        await run
        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown })?.action === 'cron.lock.job_timeout'
        ))).toBe(true)
    })

    it('skips fn() and rolls back when the lock is already held — unrelated to the timeout mechanism', async () => {
        const reserved = makeReserved({ acquired: false }) // another tick/process already holds it
        reserveMock.mockResolvedValue(reserved)
        const fn = vi.fn(async () => {})

        await runWithLock('contended-job', fn)

        expect(fn).not.toHaveBeenCalled()
        expect(reserved.calls).toContain('ROLLBACK')
        expect(reserved.release).toHaveBeenCalledTimes(1)
    })
})

describe('runWithLock — structured cron.lock.run completion logging (Task 1 / Task 3)', () => {
    it('logs outcome=completed with job name and a numeric latencyMs', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const fn = vi.fn(async () => {})

        await runWithLock('fast-job', fn, { timeoutMs: 60_000 })

        expect(logMock.info).toHaveBeenCalledTimes(1)
        const [payload] = logMock.info.mock.calls[0] as [Record<string, unknown>, string]
        expect(payload).toMatchObject({ action: 'cron.lock.run', jobName: 'fast-job', outcome: 'completed' })
        expect(typeof payload.latencyMs).toBe('number')
        expect(payload.latencyMs as number).toBeGreaterThanOrEqual(0)
        // Every non-contention outcome carries a (possibly null) pool snapshot.
        expect('pool' in payload).toBe(true)
        // Fase 1 TASK 1: every cron.lock.run line carries inFlight/orphaned, unconditionally.
        expect(typeof payload.inFlight).toBe('number')
        expect(typeof payload.orphaned).toBe('number')
    })

    it('carries inFlight/orphaned even on outcome=skipped_contention — cheap, unlike the pool probe', async () => {
        const reserved = makeReserved({ acquired: false })
        reserveMock.mockResolvedValue(reserved)

        await runWithLock('contention-with-in-flight-fields-job', vi.fn(async () => {}))

        const [payload] = logMock.info.mock.calls[0] as [Record<string, unknown>, string]
        expect(payload.outcome).toBe('skipped_contention')
        expect(typeof payload.inFlight).toBe('number')
        expect(typeof payload.orphaned).toBe('number')
    })

    it('logs a timeout run with itself already reflected in inFlight/orphaned — the confirmed orphan', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const hang = deferred<void>()
        const before = getInFlightJobs()

        const run = runWithLock('logged-timeout-orphan-job', () => hang.promise, { timeoutMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        await run

        const timeoutCall = logMock.error.mock.calls.find(([payload]) => (
            (payload as { action?: unknown }).action === 'cron.lock.job_timeout'
        )) as [Record<string, unknown>, string]
        const [payload] = timeoutCall
        // The timed-out body has not settled yet, so it is still counted right here, in the same
        // line that reports the timeout — this is the whole point of the instrumentation.
        expect(payload.inFlight as number).toBeGreaterThanOrEqual(before.inFlight + 1)
        expect(payload.orphaned as number).toBeGreaterThanOrEqual(before.orphaned + 1)
        // hang.promise is deliberately left unsettled — matches every other timeout test in this
        // file (e.g. 'never-settles' above), which never resolve/reject their hung fn either.
    })

    it('logs outcome=skipped_contention cheaply — no pool probe — when another tick holds the lock', async () => {
        const reserved = makeReserved({ acquired: false })
        reserveMock.mockResolvedValue(reserved)
        const fn = vi.fn(async () => {})

        await runWithLock('contended-job', fn)

        expect(fn).not.toHaveBeenCalled()
        expect(logMock.info).toHaveBeenCalledTimes(1)
        const [payload] = logMock.info.mock.calls[0] as [Record<string, unknown>, string]
        expect(payload).toMatchObject({ action: 'cron.lock.run', jobName: 'contended-job', outcome: 'skipped_contention' })
        expect(payload.pool).toBeUndefined()
    })

    it('logs outcome=timeout at error level with latencyMs, timeoutMs and the pool snapshot', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const hang = deferred<void>()
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('slow-job', fn, { timeoutMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        await run

        const timeoutCall = logMock.error.mock.calls.find(([payload]) => (
            (payload as { action?: unknown }).action === 'cron.lock.job_timeout'
        )) as [Record<string, unknown>, string] | undefined
        expect(timeoutCall).toBeDefined()
        const [payload, message] = timeoutCall!
        expect(payload).toMatchObject({ jobName: 'slow-job', outcome: 'timeout', timeoutMs: 1000 })
        expect('pool' in payload).toBe(true)
        expect(message).toContain('cron.lock.job_timeout')
    })

    it('logs outcome=error at error level and still rethrows the original error unchanged', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const boom = new Error('boom')
        const fn = vi.fn(async () => { throw boom })

        await expect(runWithLock('failing-job', fn, { timeoutMs: 60_000 })).rejects.toBe(boom)

        const errorCall = logMock.error.mock.calls.find(([payload]) => (
            (payload as { outcome?: unknown }).outcome === 'error'
        )) as [Record<string, unknown>] | undefined
        expect(errorCall).toBeDefined()
        expect(errorCall![0]).toMatchObject({ jobName: 'failing-job', outcome: 'error' })
        expect((errorCall![0].error as { message?: string }).message).toBe('boom')
    })

    it('routes "failed to reserve connection" through the structured logger, not console.error', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        reserveMock.mockRejectedValue(new Error('pool exhausted'))

        await runWithLock('unreserved-job', vi.fn())

        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown }).action === 'cron.lock.reserve_failed'
        ))).toBe(true)
        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { outcome?: unknown }).outcome === 'lock_failed'
        ))).toBe(true)
        expect(consoleSpy).not.toHaveBeenCalled()
    })

    it('routes "failed to acquire lock" through the structured logger, not console.error', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const reserved = makeReserved()
        ;(reserved as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
            throw new Error('BEGIN failed')
        })
        reserveMock.mockResolvedValue(reserved)

        await runWithLock('bad-lock-job', vi.fn())

        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown }).action === 'cron.lock.acquire_failed'
        ))).toBe(true)
        expect(consoleSpy).not.toHaveBeenCalled()
    })

    it('routes "connection release failed" through the structured logger, not console.error', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const reserved = makeReserved()
        reserved.release.mockImplementationOnce(() => { throw new Error('release exploded') })
        reserveMock.mockResolvedValue(reserved)

        await runWithLock('release-fails-job', vi.fn(async () => {}))

        expect(logMock.error.mock.calls.some(([payload]) => (
            (payload as { action?: unknown }).action === 'cron.lock.release_failed'
        ))).toBe(true)
        expect(consoleSpy).not.toHaveBeenCalled()
    })

    it('never lets a failing logger break the job (metric collection must never break a job)', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        logMock.info.mockImplementationOnce(() => { throw new Error('logger exploded') })
        const fn = vi.fn(async () => 'ok')

        await expect(runWithLock('resilient-job', fn)).resolves.toBeUndefined()
        expect(fn).toHaveBeenCalledTimes(1)
        expect(reserved.calls).toContain('COMMIT')
        expect(reserved.release).toHaveBeenCalledTimes(1)
    })
})

describe('getPoolSnapshot — best-effort postgres-js pool introspection (Task 2)', () => {
    it('reports the documented, stable `max` even when nothing else is observable', () => {
        expect(getPoolSnapshot({ options: { max: 20 } })).toEqual({ max: 20, reserved: null, idle: null })
    })

    it('reads reserved/idle when a queues-shaped field happens to be present', () => {
        const snapshot = getPoolSnapshot({
            options: { max: 20 },
            queues: { reserved: { length: 3 }, open: { length: 5 } },
        })
        expect(snapshot).toEqual({ max: 20, reserved: 3, idle: 5 })
    })

    it('degrades to null when max is missing or not a finite number', () => {
        expect(getPoolSnapshot({})).toBeNull()
        expect(getPoolSnapshot({ options: {} })).toBeNull()
        expect(getPoolSnapshot({ options: { max: 'nope' } })).toBeNull()
        expect(getPoolSnapshot({ options: { max: Number.NaN } })).toBeNull()
    })

    it('degrades to null instead of throwing on a completely malformed client', () => {
        expect(getPoolSnapshot(null)).toBeNull()
        expect(getPoolSnapshot(undefined)).toBeNull()
        expect(getPoolSnapshot('not-an-object')).toBeNull()
        expect(getPoolSnapshot(42)).toBeNull()

        const poisoned = {
            get options(): unknown {
                throw new Error('accessing options exploded')
            },
        }
        expect(getPoolSnapshot(poisoned)).toBeNull()
    })

    it('ignores a malformed queues field rather than throwing', () => {
        const snapshot = getPoolSnapshot({ options: { max: 20 }, queues: 'not-an-object' })
        expect(snapshot).toEqual({ max: 20, reserved: null, idle: null })
    })
})

describe('getRecentJobTimeouts — in-memory ring for the silence detector (Task 4)', () => {
    beforeEach(() => {
        // recentTimeouts is module-level state shared across every test in this file. Passing a
        // "now" far in the future prunes every leftover event (getRecentJobTimeouts prunes on
        // read) so each test in this block starts from a known-empty baseline regardless of
        // what earlier tests recorded.
        getRecentJobTimeouts(new Date(8640000000000000))
    })

    async function triggerTimeout(jobName: string, at: string, timeoutMs = 10): Promise<void> {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(at))
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const hang = deferred<void>()
        const fn = vi.fn(() => hang.promise)
        const run = runWithLock(jobName, fn, { timeoutMs })
        await vi.advanceTimersByTimeAsync(timeoutMs)
        await run
        vi.useRealTimers()
    }

    it('returns zeros when nothing has timed out', () => {
        expect(getRecentJobTimeouts(new Date('2026-09-04T00:00:00.000Z'))).toEqual({
            windowMs: 60 * 60 * 1000,
            total: 0,
            byJob: {},
        })
    })

    it('counts a timeout that falls within the default 1h window', async () => {
        await triggerTimeout('timeout-job', '2026-09-04T00:00:00.000Z')

        const stats = getRecentJobTimeouts(new Date('2026-09-04T00:30:00.000Z'))
        expect(stats.total).toBe(1)
        expect(stats.byJob).toEqual({ 'timeout-job': 1 })
    })

    it('prunes a timeout once it falls outside the window', async () => {
        await triggerTimeout('timeout-job', '2026-09-04T00:00:00.000Z')

        const stats = getRecentJobTimeouts(new Date('2026-09-04T01:00:01.000Z')) // well over 1h later
        expect(stats.total).toBe(0)
        expect(stats.byJob).toEqual({})
    })

    it('groups counts by job name', async () => {
        await triggerTimeout('job-a', '2026-09-04T00:00:00.000Z')
        await triggerTimeout('job-a', '2026-09-04T00:00:01.000Z')
        await triggerTimeout('job-b', '2026-09-04T00:00:02.000Z')

        const stats = getRecentJobTimeouts(new Date('2026-09-04T00:00:03.000Z'))
        expect(stats.total).toBe(3)
        expect(stats.byJob).toEqual({ 'job-a': 2, 'job-b': 1 })
    })

    it('does not count non-timeout outcomes', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        await runWithLock('healthy-job', vi.fn(async () => {}))

        const stats = getRecentJobTimeouts(new Date())
        expect(stats.total).toBe(0)
    })
})

describe('getInFlightJobs — in-flight/orphan job-body tracking (Fase 1 TASK 1)', () => {
    // inFlightEntries is module-level state with no time-based pruning (unlike recentTimeouts —
    // an unsettled body has no "age out" point, it is either still running or it is not), and
    // several tests elsewhere in this file deliberately leave a hung fn() unsettled forever
    // (matching the file's existing convention — see 'never-settles' etc. above). That means
    // absolute counts (`inFlight === 0`) are not reliable once other tests have run. Every test
    // below is written to be correct regardless: delta assertions (before/after a known change)
    // and exact per-job-name lookups in `orphansByJob` (a Record only has keys for jobs that
    // actually orphaned, so an unrelated leaked job under a different unique name never collides).

    it('removes the entry when the body settles normally — no net change and no orphan recorded', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const before = getInFlightJobs().inFlight

        await runWithLock('settles-normally-job', vi.fn(async () => {}))

        const after = getInFlightJobs()
        expect(after.inFlight).toBe(before)
        expect(after.orphansByJob['settles-normally-job']).toBeUndefined()
    })

    it('removes the entry when the body rejects — no net change and no orphan recorded', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const before = getInFlightJobs().inFlight

        await expect(runWithLock('settles-with-rejection-job', vi.fn(async () => { throw new Error('boom') })))
            .rejects.toThrow('boom')

        const after = getInFlightJobs()
        expect(after.inFlight).toBe(before)
        expect(after.orphansByJob['settles-with-rejection-job']).toBeUndefined()
    })

    it('keeps an unsettled body in flight and marks it a confirmed orphan once its run times out', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const hang = deferred<void>()
        const before = getInFlightJobs().inFlight

        const run = runWithLock('single-orphan-job', () => hang.promise, { timeoutMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        await run

        const after = getInFlightJobs()
        expect(after.inFlight).toBe(before + 1) // still there — never cancelled, only abandoned
        expect(after.orphaned).toBeGreaterThanOrEqual(1)
        expect(after.orphansByJob['single-orphan-job']).toBe(1)
        // hang.promise is deliberately left unsettled, same convention as the rest of this file.
    })

    it('orphansByJob counts multiple orphans of the same job name — the incident\'s retry loop', async () => {
        vi.useFakeTimers()

        // Same job name timing out twice in a row: runWithLock releases the lock via COMMIT after
        // the first timeout, so a second tick can acquire it again and orphan a second body —
        // exactly the "timeout, release, retry, timeout again" pattern from 2026-09-01/02.
        const reserved1 = makeReserved()
        reserveMock.mockResolvedValue(reserved1)
        const hang1 = deferred<void>()
        const run1 = runWithLock('repeat-offender-job', () => hang1.promise, { timeoutMs: 5 })
        await vi.advanceTimersByTimeAsync(5)
        await run1

        const reserved2 = makeReserved()
        reserveMock.mockResolvedValue(reserved2)
        const hang2 = deferred<void>()
        const run2 = runWithLock('repeat-offender-job', () => hang2.promise, { timeoutMs: 5 })
        await vi.advanceTimersByTimeAsync(5)
        await run2

        const reserved3 = makeReserved()
        reserveMock.mockResolvedValue(reserved3)
        const hang3 = deferred<void>()
        const run3 = runWithLock('unrelated-single-orphan-job', () => hang3.promise, { timeoutMs: 5 })
        await vi.advanceTimersByTimeAsync(5)
        await run3

        const stats = getInFlightJobs()
        expect(stats.orphansByJob['repeat-offender-job']).toBe(2)
        expect(stats.orphansByJob['unrelated-single-orphan-job']).toBe(1)
    })

    it('oldestAgeMs grows by exactly the elapsed time between two reads of the same in-flight set', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-04T10:00:00.000Z'))
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const hang = deferred<void>()

        const run = runWithLock('age-delta-job', () => hang.promise, { timeoutMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        await run

        // oldestAgeMs = now - startedAt(oldest entry). Whichever entry is oldest across the whole
        // module (possibly one leaked by an earlier test, possibly this one), its startedAt does
        // not change between these two reads, so the reported age must grow by exactly the
        // interval between the two `now` values passed in — regardless of which entry is oldest.
        const early = getInFlightJobs(new Date('2026-09-04T10:00:05.000Z'))
        const later = getInFlightJobs(new Date('2026-09-04T10:05:05.000Z'))
        expect(early.oldestAgeMs).not.toBeNull()
        expect(later.oldestAgeMs! - early.oldestAgeMs!).toBe(5 * 60 * 1000)
    })

    it('oldestAgeMs is null only when inFlight is 0', () => {
        const stats = getInFlightJobs()
        if (stats.inFlight === 0) {
            expect(stats.oldestAgeMs).toBeNull()
        } else {
            expect(stats.oldestAgeMs).not.toBeNull()
        }
    })
})
