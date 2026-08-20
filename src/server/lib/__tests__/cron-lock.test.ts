/**
 * Pure unit tests for runWithLock's timeout budget — no DB. `queryClient` is mocked; see
 * amortizeSubscriptionCosts.test.ts for the sibling job-test mocking convention this follows.
 *
 * The defect these tests guard against (see cron-lock.ts's BUDGET doc): `fn()` used to run
 * unbounded inside the transaction. A hung IMAP/SMTP socket with no timeout of its own meant the
 * `finally` that COMMITs (and releases the advisory lock) never ran, and the lock stayed held
 * forever. `runWithLock` now races `fn()` against a timeout so the lock always clears.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reserveMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', () => ({ db: {}, queryClient: { reserve: reserveMock } }))

import { runWithLock } from '../cron-lock'

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
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const hang = deferred<void>() // never resolved or rejected — simulates a hung socket
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('never-settles', fn, { timeoutMs: 1000 })
        await vi.advanceTimersByTimeAsync(1000)
        await run

        // Distinct, greppable timeout log — not the routine "already running … skipping" line.
        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('cron.lock.job_timeout'))).toBe(true)

        // The lock-releasing path still ran: COMMIT happened and the connection went back to the pool.
        expect(reserved.calls).toContain('COMMIT')
        expect(reserved.release).toHaveBeenCalledTimes(1)

        // fn() itself is still pending — it was never cancelled, only abandoned.
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('does not log a timeout, and still commits, for a normal fast job', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const fn = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0))
        })

        await runWithLock('fast-job', fn, { timeoutMs: 60_000 })

        expect(fn).toHaveBeenCalledTimes(1)
        expect(reserved.calls).toContain('COMMIT')
        expect(reserved.release).toHaveBeenCalledTimes(1)
        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('cron.lock.job_timeout'))).toBe(false)
    })

    it('propagates a real error from fn() unchanged, and still commits (unaffected by the timeout race)', async () => {
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        vi.spyOn(console, 'error').mockImplementation(() => {})

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
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const hang = deferred<void>()
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('short-budget-job', fn, { timeoutMs: 5 })
        await vi.advanceTimersByTimeAsync(5)
        await run

        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('cron.lock.job_timeout'))).toBe(true)
    })

    it('uses the 10-minute default when no timeoutMs override is given', async () => {
        vi.useFakeTimers()
        const reserved = makeReserved()
        reserveMock.mockResolvedValue(reserved)
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const hang = deferred<void>()
        const fn = vi.fn(() => hang.promise)

        const run = runWithLock('default-budget-job', fn)

        // Just under 10 minutes: still hung, no timeout yet.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1)
        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('cron.lock.job_timeout'))).toBe(false)

        // Crossing 10 minutes: timeout fires.
        await vi.advanceTimersByTimeAsync(1)
        await run
        expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('cron.lock.job_timeout'))).toBe(true)
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
