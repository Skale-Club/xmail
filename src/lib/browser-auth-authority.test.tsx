import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ create: vi.fn(), session: vi.fn(), refresh: vi.fn(), logout: vi.fn(), stop: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: sdk.create }))
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    window.localStorage.clear(); window.sessionStorage.clear()
    window.__APP_CONFIG__ = { VITE_SUPABASE_URL: 'https://fixture.supabase.co', VITE_SUPABASE_ANON_KEY: 'offline-public-key' }
    sdk.stop.mockResolvedValue(undefined)
    sdk.create.mockReturnValue({ auth: { getSession: sdk.session, refreshSession: sdk.refresh, signOut: sdk.logout, stopAutoRefresh: sdk.stop } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete window.__APP_CONFIG__ })
describe('server selected browser authentication authority', () => {
    it('does not construct or restore the legacy SDK on import, before status, or under owned authority', async () => {
        const { supabase } = await import('./supabase')
        expect(sdk.create).not.toHaveBeenCalled()
        expect(() => supabase.auth).toThrow('unavailable')
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authority: 'owned', available: true })))
        await (await import('./browser-auth-authority')).resolveBrowserAuthAuthority()
        expect(() => supabase.auth).toThrow('unavailable')
        expect(sdk.create).not.toHaveBeenCalled()
    })
    it('constructs the lazy client only after the server explicitly confirms legacy mode', async () => {
        const { supabase } = await import('./supabase')
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authority: 'legacy', available: true })))
        await (await import('./browser-auth-authority')).requireLegacyBrowserAuth()
        expect(supabase.auth).toBeDefined(); expect(sdk.create).toHaveBeenCalledOnce()
        expect(sdk.create).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ auth: { autoRefreshToken: false } }))
    })
    it('revalidates legacy, stops local refresh on owned takeover and never accepts a later legacy response', async () => {
        let selected = 'legacy'
        const fetcher = vi.fn(async () => Response.json({ authority: selected, available: true }))
        vi.stubGlobal('fetch', fetcher)
        const authority = await import('./browser-auth-authority')
        await authority.requireLegacyBrowserAuth()
        const { supabase } = await import('./supabase')
        expect(supabase.auth).toBeDefined()
        selected = 'owned'
        await expect(authority.requireLegacyBrowserAuth()).rejects.toThrow('unavailable')
        expect(sdk.stop).toHaveBeenCalledOnce(); expect(() => supabase.auth).toThrow('unavailable')
        const count = fetcher.mock.calls.length; selected = 'legacy'
        expect(await authority.resolveBrowserAuthAuthority({ force: true })).toBe('owned')
        expect(fetcher).toHaveBeenCalledTimes(count)
        expect(sdk.session).not.toHaveBeenCalled(); expect(sdk.refresh).not.toHaveBeenCalled(); expect(sdk.logout).not.toHaveBeenCalled()
    })
    it('expires legacy confirmation and locks an existing client when an owned pilot session activates', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authority: 'legacy', available: true })))
        const authority = await import('./browser-auth-authority')
        await authority.requireLegacyBrowserAuth()
        const { supabase } = await import('./supabase'); expect(supabase.auth).toBeDefined()
        await vi.advanceTimersByTimeAsync(10001)
        expect(() => supabase.auth).toThrow('unavailable')
        await authority.requireLegacyBrowserAuth()
        const identity = await import('./owned-identity')
        identity.preferOwnedIdentity()
        expect(sdk.stop).toHaveBeenCalledOnce()
        await expect(authority.requireLegacyBrowserAuth()).rejects.toThrow('unavailable')
        expect(sdk.refresh).not.toHaveBeenCalled(); expect(sdk.session).not.toHaveBeenCalled()
    })
    it('revalidates on window focus after a server cutover without restoring the old SDK user', async () => {
        let selected = 'legacy'
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ authority: selected, available: true })))
        const events = vi.spyOn(window, 'addEventListener')
        const authority = await import('./browser-auth-authority')
        await authority.requireLegacyBrowserAuth()
        const { supabase } = await import('./supabase'); expect(supabase.auth).toBeDefined()
        const focus = events.mock.calls.find(([name]) => name === 'focus')?.[1]
        expect(typeof focus).toBe('function')
        selected = 'owned'
        const invokeFocus = focus as EventListener
        invokeFocus(new Event('focus'))
        await vi.waitFor(() => expect(authority.currentBrowserAuthAuthority()).toBe('owned'))
        expect(sdk.stop).toHaveBeenCalledOnce(); expect(sdk.session).not.toHaveBeenCalled(); expect(sdk.refresh).not.toHaveBeenCalled()
    })
    it.each(['network', 'status', 'malformed'])('fails closed without legacy initialization on %s failure', async kind => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            if (kind === 'network') throw new Error('Offline')
            return kind === 'status' ? Response.json({}, { status: 503 }) : Response.json({ authority: 'legacy' })
        }))
        const authority = await import('./browser-auth-authority')
        await expect(authority.resolveBrowserAuthAuthority()).rejects.toThrow('unavailable')
        const identity = await import('./owned-identity')
        expect(await identity.probeOwnedIdentitySession()).toEqual({ kind: 'unavailable' })
        const { supabase } = await import('./supabase')
        expect(() => supabase.auth).toThrow('unavailable')
        expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.refresh).not.toHaveBeenCalled()
    })
    it('ignores late legacy status after the absolute bootstrap deadline', async () => {
        vi.useFakeTimers()
        let finish!: (response: Response) => void
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
        const authority = await import('./browser-auth-authority')
        const denied = expect(authority.resolveBrowserAuthAuthority()).rejects.toThrow('unavailable')
        await vi.advanceTimersByTimeAsync(8001); await denied
        finish(Response.json({ authority: 'legacy', available: true }))
        await vi.advanceTimersByTimeAsync(1)
        expect(authority.currentBrowserAuthAuthority()).toBe('unavailable')
        expect(sdk.create).not.toHaveBeenCalled()
    })
    it('does not restore legacy tokens for absent/expired owned sessions or a protected 401', async () => {
        const fetcher = vi.fn<typeof fetch>(async input => {
            if (input === '/api/auth/authority') return Response.json({ authority: 'owned', available: true })
            if (input === '/api/auth/identity/session') return Response.json({ user: null, authMode: 'owned' })
            return Response.json({ error: 'Expired owned cookie.' }, { status: 401 })
        })
        vi.stubGlobal('fetch', fetcher)
        const identity = await import('./owned-identity')
        expect((await identity.probeOwnedIdentitySession()).kind).toBe('expired')
        const { apiFetch } = await import('./api-client')
        await expect(apiFetch('/api/users/profile', { retry: false, headers: { Authorization: 'Bearer stale-fixture' } })).rejects.toMatchObject({ status: 401 })
        const protectedCall = fetcher.mock.calls.find(([url]) => url === '/api/users/profile')!
        expect(new Headers(protectedCall[1]?.headers).has('Authorization')).toBe(false)
        expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.session).not.toHaveBeenCalled(); expect(sdk.refresh).not.toHaveBeenCalled()
    })
    it('preserves machine headers and signs out of owned cookies without loading the legacy SDK', async () => {
        const fetcher = vi.fn<typeof fetch>(async input => input === '/api/auth/authority'
            ? Response.json({ authority: 'owned', available: true })
            : String(input).includes('challenge?') ? Response.json({ challenge: 'offline-challenge' }) : Response.json({ ok: true }))
        vi.stubGlobal('fetch', fetcher)
        const { apiFetch } = await import('./api-client')
        await apiFetch('/api/outreach/campaigns', { headers: { 'x-service-key': 'offline-machine-key' } })
        const call = fetcher.mock.calls.find(([url]) => url === '/api/outreach/campaigns')!
        expect(new Headers(call[1]?.headers).get('x-service-key')).toBe('offline-machine-key')
        expect(await (await import('./owned-identity')).signOutOfXmail()).toBe(true)
        expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.logout).not.toHaveBeenCalled()
    })
    it('passes stored legacy possession only to the explicit first-link endpoint, without refreshing it', async () => {
        const token = 'header.payload.signature'
        localStorage.setItem('skaleclub-active-session', 'exact-existing-uuid')
        localStorage.setItem('skaleclub-sessions', JSON.stringify([{ userId: 'exact-existing-uuid', accessToken: token }]))
        const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('challenge?') ? Response.json({ challenge: 'offline-challenge' }) : Response.json({ ok: true }))
        vi.stubGlobal('fetch', fetcher)
        const identity = await import('./owned-identity')
        expect(identity.storedLegacyFirstLinkToken()).toBe(token)
        await identity.ownedIdentityAction('link', 'fresh-provider-proof', identity.storedLegacyFirstLinkToken())
        const link = fetcher.mock.calls.find(([url]) => url === '/api/auth/identity/link')!
        expect(new Headers(link[1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
        expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/api/auth/identity/'))).toBe(true)
        expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.refresh).not.toHaveBeenCalled()
    })
})
