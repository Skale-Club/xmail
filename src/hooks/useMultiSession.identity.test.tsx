import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MultiSessionProvider, useMultiSession } from './useMultiSession'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), active: vi.fn(), restore: vi.fn(), subscribe: vi.fn(), stored: vi.fn(), persist: vi.fn(), generation: 0, boundary: undefined as (() => void) | undefined }))
vi.mock('../lib/owned-identity', () => ({ probeOwnedIdentitySession: mocks.probe, ownedIdentityActive: mocks.active }))
vi.mock('../lib/supabase', () => ({ supabase: { auth: { setSession: mocks.restore, onAuthStateChange: mocks.subscribe, signOut: vi.fn() } } }))
vi.mock('../lib/api-client', () => ({ clearTokenCache: vi.fn() }))
vi.mock('../lib/browser-auth-authority', () => ({ legacyBrowserAuthConfirmed: () => !mocks.active(), requireLegacyBrowserAuth: async () => {},
    browserAuthGeneration: () => mocks.generation, legacyBrowserAuthSnapshotCurrent: (generation: number) => generation === mocks.generation && !mocks.active(),
    subscribeBrowserAuthBoundary: (listener: () => void) => { mocks.boundary = listener; return () => {} } }))
vi.mock('../lib/session-store', () => ({
    getStoredSessions: mocks.stored, getActiveSessionId: () => 'existing-user', toSessionInfo: (value: unknown) => value,
    addStoredSession: vi.fn(), updateStoredSessionTokens: vi.fn(), removeStoredSession: vi.fn(), setActiveSessionId: mocks.persist,
    clearAllSessions: vi.fn(), supabaseSessionToStored: vi.fn(),
}))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.generation = 0; mocks.boundary = undefined
    mocks.active.mockReturnValue(false)
    mocks.stored.mockReturnValue([{ userId: 'existing-user', accessToken: 'offline-access', refreshToken: 'offline-refresh' }])
    mocks.restore.mockResolvedValue({ error: null })
    mocks.subscribe.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})
afterEach(cleanup)
function mount() {
    return render(<QueryClientProvider client={new QueryClient()}><MultiSessionProvider><State /></MultiSessionProvider></QueryClientProvider>)
}
function State() { const state = useMultiSession(); return <output>{state.activeSessionId ?? 'no-active-session'}:{state.sessions.map(session => session.userId).join(',')}</output> }
describe('owned-cookie and legacy multi-session isolation', () => {
    it('waits for cookie admission, then preserves saved legacy account restoration when the pilot is disabled', async () => {
        let complete!: (value: { kind: string }) => void
        mocks.probe.mockReturnValue(new Promise(resolve => { complete = resolve }))
        mount()
        expect(mocks.restore).not.toHaveBeenCalled()
        complete({ kind: 'disabled' })
        await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith({ access_token: 'offline-access', refresh_token: 'offline-refresh' }))
        await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())
    })
    it.each(['active', 'expired', 'unavailable'])('never restores saved legacy credentials for %s owned mode', async kind => {
        mocks.active.mockReturnValue(true)
        mocks.probe.mockResolvedValue({ kind })
        mount()
        await act(async () => {})
        expect(mocks.stored).not.toHaveBeenCalled()
        expect(mocks.restore).not.toHaveBeenCalled()
        expect(mocks.subscribe).not.toHaveBeenCalled()
    })
    it('discards delayed SDK restoration instead of marking an old user active after owned takeover', async () => {
        let finish!: (value: unknown) => void
        mocks.probe.mockResolvedValue({ kind: 'disabled' })
        mocks.restore.mockReturnValue(new Promise(resolve => { finish = resolve }))
        mount(); await waitFor(() => expect(mocks.restore).toHaveBeenCalledOnce())
        await act(async () => { mocks.active.mockReturnValue(true); mocks.generation++; mocks.boundary?.(); finish({ error: null }) })
        expect(screen.getByRole('status')).toHaveTextContent('no-active-session')
        expect(screen.getByRole('status')).not.toHaveTextContent('existing-user')
        expect(mocks.persist).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled()
    })
})
