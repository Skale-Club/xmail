/**
 * The watchdog that ends a "database hung, process alive" outage by restarting the process.
 * Pure: the probe, the clock, the alerting and the exit are all injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db', () => ({ db: {}, queryClient: vi.fn() }))
vi.mock('../ops-alert', () => ({ alertOps: vi.fn(async () => true), reportOpsCondition: vi.fn(async () => undefined) }))

import { startDbLivenessWatchdog } from '../db-liveness'
import { TimeoutError, withTimeout } from '../with-timeout'

let clock = 0
const now = () => clock

beforeEach(() => {
    clock = 1_000_000
    vi.useFakeTimers()
})
afterEach(() => {
    vi.useRealTimers()
})

function watchdog(probe: () => Promise<unknown>, overrides: Partial<Parameters<typeof startDbLivenessWatchdog>[0]> = {}) {
    const exit = vi.fn()
    const report = vi.fn(async () => undefined)
    const alert = vi.fn(async () => true)
    const wd = startDbLivenessWatchdog({
        intervalMs: 60_000,
        probeTimeoutMs: 1_000,
        exitAfterMs: 5 * 60_000,
        probe,
        exit,
        now,
        report: report as never,
        alert: alert as never,
        ...overrides,
    })
    return { wd, exit, report, alert }
}

describe('startDbLivenessWatchdog', () => {
    it('does nothing while the probe answers', async () => {
        const { wd, exit, report } = watchdog(async () => [{ '?column?': 1 }])
        await wd.tick()
        await wd.tick()
        expect(exit).not.toHaveBeenCalled()
        expect(report).not.toHaveBeenCalled()
        expect(wd.state()).toEqual({ failingSince: null, consecutiveFailures: 0 })
        wd.stop()
    })

    it('alerts after two consecutive failures and exits once the failure has lasted exitAfterMs', async () => {
        const { wd, exit, report, alert } = watchdog(async () => { throw new Error('CONNECT_TIMEOUT') })

        await wd.tick()                       // t=0: first failure, quiet
        expect(report).not.toHaveBeenCalled()
        clock += 60_000
        await wd.tick()                       // t=1min: second failure, alert
        expect(report).toHaveBeenCalledWith('db.unreachable', true, expect.objectContaining({ failTitle: expect.stringContaining('cannot reach') }))
        expect(exit).not.toHaveBeenCalled()

        clock += 3 * 60_000
        await wd.tick()                       // t=4min: still under the exit threshold
        expect(exit).not.toHaveBeenCalled()

        clock += 60_000
        await wd.tick()                       // t=5min: sustained — restart
        expect(alert).toHaveBeenCalledWith('db.unreachable_restart', expect.any(String), expect.stringContaining('5min'))
        expect(exit).toHaveBeenCalledWith(1)
    })

    it('treats a probe that never settles as a failure (the wedged-pool case)', async () => {
        const { wd, exit } = watchdog(() => new Promise(() => { /* hangs forever */ }), { exitAfterMs: 1 })
        const ticking = wd.tick()
        await vi.advanceTimersByTimeAsync(1_000)
        await ticking
        expect(wd.state().consecutiveFailures).toBe(1)
        // A second failed probe at the same clock is already past the (1 ms) threshold.
        clock += 10
        const second = wd.tick()
        await vi.advanceTimersByTimeAsync(1_000)
        await second
        expect(exit).toHaveBeenCalledWith(1)
    })

    it('recovers, resolves the condition, and resets the clock', async () => {
        let healthy = false
        const { wd, exit, report } = watchdog(async () => {
            if (!healthy) throw new Error('down')
            return []
        })
        await wd.tick()
        clock += 60_000
        await wd.tick()                       // alerted
        healthy = true
        clock += 60_000
        await wd.tick()                       // recovered
        expect(report).toHaveBeenLastCalledWith('db.unreachable', false, expect.objectContaining({ okTitle: expect.stringContaining('again') }))
        expect(wd.state()).toEqual({ failingSince: null, consecutiveFailures: 0 })

        // A later failure starts a fresh window rather than inheriting the old one.
        healthy = false
        clock += 10 * 60_000
        await wd.tick()
        expect(exit).not.toHaveBeenCalled()
        wd.stop()
    })

    it('never exits when exitAfterMs is 0 (alert-only mode)', async () => {
        const { wd, exit } = watchdog(async () => { throw new Error('down') }, { exitAfterMs: 0 })
        for (let i = 0; i < 20; i++) {
            await wd.tick()
            clock += 60_000
        }
        expect(exit).not.toHaveBeenCalled()
        wd.stop()
    })
})

describe('withTimeout', () => {
    it('rejects with a TimeoutError naming the label once the bound elapses', async () => {
        const pending = withTimeout(new Promise(() => { /* never */ }), 50, 'thing')
        const assertion = expect(pending).rejects.toMatchObject({
            name: 'TimeoutError',
            code: 'ETIMEDOUT',
            message: 'thing timed out after 50ms',
        })
        await vi.advanceTimersByTimeAsync(50)
        await assertion
    })

    it('awaits a thenable exactly once (a Drizzle query re-executes on every then/catch)', async () => {
        let executions = 0
        const thenable: PromiseLike<number> = {
            then(onFulfilled, onRejected) {
                executions += 1
                return Promise.resolve(7).then(onFulfilled, onRejected)
            },
        }
        await expect(withTimeout(thenable, 50, 'query')).resolves.toBe(7)
        expect(executions).toBe(1)
    })

    it('passes a settled value or rejection through untouched', async () => {
        await expect(withTimeout(Promise.resolve(42), 50, 'x')).resolves.toBe(42)
        await expect(withTimeout(Promise.reject(new Error('own')), 50, 'x')).rejects.toThrow('own')
        expect(new TimeoutError('x', 1)).toBeInstanceOf(Error)
    })
})
