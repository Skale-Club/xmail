import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Separate from deliverOutreachEvents.test.ts on purpose: that file needs the REAL drizzle `db`
 * to build and inspect actual SQL (`buildDeliverableOutreachEventsQuery(...).toSQL()`), so it
 * can't mock `../../db`. This file exercises `deliverOutreachEventsToXphere`'s two
 * missing-config branches, which need the opposite: a mocked `db.select` (no real connection)
 * and a mocked logger whose calls we can inspect directly instead of parsing pino stdout.
 *
 * `../../lib/cron-lock` (imported transitively for `JOB_TIMEOUT_BUDGETS_MS`/`runWithLock`) also
 * pulls `jobQueryClient` off '../../../db' at its own top level, so the mock must provide it even
 * though nothing here calls a locked job.
 *
 * Mock paths are relative to THIS file (src/server/jobs/__tests__/), not to the module under
 * test — same convention as alertWatchdog.test.ts's own `../../../db` / `../../lib/logger` mocks
 * in this same directory.
 */
const selectMock = vi.hoisted(() => vi.fn())
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('../../../db', () => ({
    db: { select: selectMock, update: vi.fn() },
    jobQueryClient: {},
    queryClient: vi.fn(),
}))
vi.mock('../../lib/logger', () => ({ createLogger: () => logMock }))

import { __resetDeliverOutreachEventsLogState, deliverOutreachEventsToXphere } from '../deliverOutreachEvents'

/** Configures the mocked `db.select({...}).from(...).where(...)` chain used by
 *  `countPendingXphereEvents` to resolve to a single `{ value }` row, matching drizzle's
 *  `count()` aggregate shape. */
function mockPendingCount(value: number): void {
    selectMock.mockReturnValue({
        from: () => ({
            where: () => Promise.resolve([{ value }]),
        }),
    })
}

describe('deliverOutreachEventsToXphere — XPHERE_EVENTS_URL/XPHERE_EVENTS_API_KEY missing', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        __resetDeliverOutreachEventsLogState()
        delete process.env.XPHERE_EVENTS_URL
        delete process.env.XPHERE_EVENTS_API_KEY
    })

    afterEach(() => {
        delete process.env.XPHERE_EVENTS_URL
        delete process.env.XPHERE_EVENTS_API_KEY
    })

    it('benign case: logs once at info level when the outbox has nothing pending', async () => {
        mockPendingCount(0)

        await deliverOutreachEventsToXphere()

        expect(logMock.error).not.toHaveBeenCalled()
        expect(logMock.info).toHaveBeenCalledTimes(1)
        expect(logMock.info.mock.calls[0][0]).toMatchObject({ action: 'outreach.events.xphere_config_missing' })
    })

    it('benign case: does not repeat the log on the very next tick (throttled)', async () => {
        mockPendingCount(0)

        await deliverOutreachEventsToXphere()
        await deliverOutreachEventsToXphere()
        await deliverOutreachEventsToXphere()

        expect(logMock.info).toHaveBeenCalledTimes(1)
    })

    it('silent-loss case: logs at error level, every tick, while events sit undelivered', async () => {
        mockPendingCount(7)

        await deliverOutreachEventsToXphere()
        await deliverOutreachEventsToXphere()

        expect(logMock.info).not.toHaveBeenCalled()
        expect(logMock.error).toHaveBeenCalledTimes(2)
        expect(logMock.error.mock.calls[0][0]).toMatchObject({
            action: 'outreach.events.xphere_config_missing_with_pending_events',
            pendingEvents: 7,
        })
        expect(logMock.error.mock.calls[1][0]).toMatchObject({ pendingEvents: 7 })
    })

    it('silent-loss case is never suppressed by the benign-case throttle', async () => {
        // A benign tick (empty outbox) followed immediately by events landing in the outbox must
        // still alert on the very next tick — the throttle only ever governs the benign log line.
        mockPendingCount(0)
        await deliverOutreachEventsToXphere()
        expect(logMock.info).toHaveBeenCalledTimes(1)

        mockPendingCount(3)
        await deliverOutreachEventsToXphere()
        expect(logMock.error).toHaveBeenCalledTimes(1)
    })

    it('never writes the configured secret value into a log call, only the variable\'s state', async () => {
        process.env.XPHERE_EVENTS_API_KEY = 'super-secret-value-should-never-be-logged'
        mockPendingCount(0)

        await deliverOutreachEventsToXphere()

        const serializedCalls = JSON.stringify([...logMock.info.mock.calls, ...logMock.error.mock.calls])
        expect(serializedCalls).not.toContain('super-secret-value-should-never-be-logged')
    })
})
