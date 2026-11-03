import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MultiSessionProvider } from './useMultiSession'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), active: vi.fn(), restore: vi.fn(), subscribe: vi.fn(), stored: vi.fn() }))
vi.mock('../lib/owned-identity', () => ({ probeOwnedIdentitySession: mocks.probe, ownedIdentityActive: mocks.active }))
vi.mock('../lib/supabase', () => ({ supabase: { auth: { setSession: mocks.restore, onAuthStateChange: mocks.subscribe, signOut: vi.fn() } } }))
vi.mock('../lib/api-client', () => ({ clearTokenCache: vi.fn() }))
vi.mock('../lib/session-store', () => ({
    getStoredSessions: mocks.stored, getActiveSessionId: () => 'existing-user', toSessionInfo: (value: unknown) => value,
    addStoredSession: vi.fn(), updateStoredSessionTokens: vi.fn(), removeStoredSession: vi.fn(), setActiveSessionId: vi.fn(),
    clearAllSessions: vi.fn(), supabaseSessionToStored: vi.fn(),
}))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.active.mockReturnValue(false)
    mocks.stored.mockReturnValue([{ userId: 'existing-user', accessToken: 'offline-access', refreshToken: 'offline-refresh' }])
    mocks.restore.mockResolvedValue({ error: null })
    mocks.subscribe.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})
afterEach(cleanup)
function mount() {
    return render(<QueryClientProvider client={new QueryClient()}><MultiSessionProvider><div>App</div></MultiSessionProvider></QueryClientProvider>)
}
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
    it.each(['active', 'expired'])('never restores saved legacy credentials for %s owned mode', async kind => {
        mocks.active.mockReturnValue(true)
        mocks.probe.mockResolvedValue({ kind })
        mount()
        await act(async () => {})
        expect(mocks.stored).not.toHaveBeenCalled()
        expect(mocks.restore).not.toHaveBeenCalled()
        expect(mocks.subscribe).not.toHaveBeenCalled()
    })
})
