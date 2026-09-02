/**
 * `/health/ready` must ANSWER when the database probe hangs. On 2026-09-01 it did not: the
 * external probe saw `000` for ten hours because `select 1` queued behind a wedged pool forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbHealth = vi.hoisted(() => vi.fn())
const authHealth = vi.hoisted(() => vi.fn())

vi.mock('../../../db', () => ({ checkDatabaseHealth: dbHealth }))
vi.mock('../supabase', () => ({ checkSupabaseAuthHealth: authHealth }))

import { READINESS_DB_TIMEOUT_MS, runReadinessChecks } from '../health'

beforeEach(() => {
    vi.useFakeTimers()
    authHealth.mockResolvedValue({ ok: true })
})
afterEach(() => {
    vi.useRealTimers()
})

describe('runReadinessChecks', () => {
    it('reports the database as down, with a reason, when the probe never returns', async () => {
        dbHealth.mockReturnValue(new Promise(() => { /* hung pool */ }))
        const pending = runReadinessChecks()
        await vi.advanceTimersByTimeAsync(READINESS_DB_TIMEOUT_MS)
        const readiness = await pending
        expect(readiness.ok).toBe(false)
        expect(readiness.services.database).toEqual({
            ok: false,
            error: expect.stringContaining('timed out'),
        })
        expect(readiness.services.auth).toEqual({ ok: true })
    })

    it('is green when both probes answer', async () => {
        dbHealth.mockResolvedValue({ ok: true, latencyMs: 3 })
        const readiness = await runReadinessChecks()
        expect(readiness.ok).toBe(true)
        expect(readiness.services.database).toEqual({ ok: true, latencyMs: 3 })
    })
})
