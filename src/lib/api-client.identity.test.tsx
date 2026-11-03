import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, clearTokenCache, getAccessToken } from './api-client'

const mocks = vi.hoisted(() => ({ active: vi.fn(), csrf: vi.fn(), getSession: vi.fn(), refresh: vi.fn() }))
vi.mock('./owned-identity', () => ({ ownedIdentityActive: mocks.active, ownedMutationHeaders: mocks.csrf }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: mocks.getSession, refreshSession: mocks.refresh } } }))
beforeEach(() => {
    vi.clearAllMocks(); clearTokenCache()
    mocks.active.mockReturnValue(true)
    mocks.csrf.mockResolvedValue({ 'X-Xmail-CSRF': 'offline-single-use-challenge' })
})
afterEach(() => vi.unstubAllGlobals())
describe('owned cookie API client admission', () => {
    it('uses cookie admission plus a path challenge and strips stale legacy Authorization', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
        vi.stubGlobal('fetch', fetcher)
        await expect(getAccessToken()).resolves.toBeUndefined()
        await expect(apiFetch('/api/users/profile', { method: 'PATCH', body: '{}', headers: { Authorization: 'Bearer stale-legacy' } })).resolves.toEqual({ ok: true })
        const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
        expect(headers.has('Authorization')).toBe(false)
        expect(headers.get('X-Xmail-CSRF')).toBe('offline-single-use-challenge')
        expect(mocks.csrf).toHaveBeenCalledWith('PATCH', '/api/users/profile', undefined)
        expect(mocks.getSession).not.toHaveBeenCalled()
    })
    it('does not refresh or restore Supabase after an owned-session denial', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Identity session is unavailable.' }, { status: 401 })))
        await expect(apiFetch('/api/users/profile', { retry: false })).rejects.toMatchObject({ status: 401 })
        expect(mocks.getSession).not.toHaveBeenCalled()
        expect(mocks.refresh).not.toHaveBeenCalled()
    })
    it('preserves default legacy bearer retrieval while the pilot mode is absent', async () => {
        mocks.active.mockReturnValue(false)
        mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'offline-legacy-access', expires_at: Date.now() / 1000 + 3600 } }, error: null })
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))
        vi.stubGlobal('fetch', fetcher)
        await apiFetch('/api/users/profile')
        expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer offline-legacy-access')
        expect(mocks.csrf).not.toHaveBeenCalled()
    })
})
