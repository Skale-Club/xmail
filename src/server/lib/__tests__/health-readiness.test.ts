/**
 * `/health/ready` must ANSWER when the database probe hangs. On 2026-09-01 it did not: the
 * external probe saw `000` for ten hours because `select 1` queued behind a wedged pool forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbHealth = vi.hoisted(() => vi.fn())
const authHealth = vi.hoisted(() => vi.fn())
const ownedReady = vi.hoisted(() => vi.fn())
const storageHealth = vi.hoisted(() => vi.fn())

vi.mock('../../../db', () => ({ checkDatabaseHealth: dbHealth }))
vi.mock('../supabase', () => ({ checkSupabaseAuthHealth: authHealth }))
vi.mock('../identity/runtime', () => ({ getIdentityRuntime: async () => ({ assertReady: ownedReady }) }))
vi.mock('../object-storage', () => ({ checkSelectedStorageHealth: storageHealth }))

import { READINESS_AUTH_TIMEOUT_MS, READINESS_DB_TIMEOUT_MS, READINESS_STORAGE_TIMEOUT_MS, runReadinessChecks } from '../health'

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks(); vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy')
    authHealth.mockResolvedValue({ ok: true })
    storageHealth.mockResolvedValue({ ok: true })
})
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
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
    it('selects owned ADC/Google readiness without calling the legacy Auth probe', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned'); vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true')
        vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
        dbHealth.mockResolvedValue({ ok: true, latencyMs: 3 }); ownedReady.mockResolvedValue(undefined)
        expect((await runReadinessChecks()).ok).toBe(true)
        expect(ownedReady).toHaveBeenCalledWith(expect.any(AbortSignal)); expect(authHealth).not.toHaveBeenCalled()
    })
    it('does not fall back to legacy Auth after owned readiness failure and sanitizes diagnostics', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned'); vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true')
        vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
        dbHealth.mockResolvedValue({ ok: false, error: 'private-connection-detail' }); ownedReady.mockRejectedValue(new Error('Authorization: private-provider-proof'))
        const readiness = await runReadinessChecks()
        expect(readiness.ok).toBe(false); expect(readiness.services.database.ok).toBe(false)
        expect(JSON.stringify(readiness)).not.toContain('private-'); expect(authHealth).not.toHaveBeenCalled()
    })
    it('bounds a noncooperative owned readiness request and aborts its signal', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned'); vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true')
        vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
        dbHealth.mockResolvedValue({ ok: true, latencyMs: 3 }); ownedReady.mockReturnValue(new Promise(() => {}))
        const pending = runReadinessChecks()
        await vi.advanceTimersByTimeAsync(READINESS_AUTH_TIMEOUT_MS + 1)
        expect((await pending).ok).toBe(false)
        expect(ownedReady.mock.calls[0][0].aborted).toBe(true); expect(authHealth).not.toHaveBeenCalled()
    })
    it('refuses incomplete owned configuration while still checking SQL and never probing legacy', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned'); vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'false')
        dbHealth.mockResolvedValue({ ok: true, latencyMs: 3 })
        expect((await runReadinessChecks()).ok).toBe(false)
        expect(dbHealth).toHaveBeenCalledOnce(); expect(ownedReady).not.toHaveBeenCalled(); expect(authHealth).not.toHaveBeenCalled()
    })
    it('fails readiness on storage errors with a static diagnostic and still checks SQL/Auth', async () => {
        dbHealth.mockResolvedValue({ ok: true, latencyMs: 1 })
        storageHealth.mockRejectedValue(new Error('Authorization: private-storage-proof object-key'))
        const result = await runReadinessChecks()
        expect(result.ok).toBe(false)
        expect(result.services.storage).toEqual({ ok: false, error: 'Selected object storage readiness check failed.' })
        expect(JSON.stringify(result)).not.toMatch(/private-storage-proof|object-key/)
        expect(dbHealth).toHaveBeenCalledOnce(); expect(authHealth).toHaveBeenCalledOnce()
    })
    it('bounds a noncooperative storage probe and aborts the underlying request signal', async () => {
        dbHealth.mockResolvedValue({ ok: true, latencyMs: 1 })
        storageHealth.mockReturnValue(new Promise(() => {}))
        const pending = runReadinessChecks()
        await vi.advanceTimersByTimeAsync(READINESS_STORAGE_TIMEOUT_MS + 1)
        expect((await pending).services.storage.ok).toBe(false)
        expect(storageHealth.mock.calls[0][0].aborted).toBe(true)
    })
})
