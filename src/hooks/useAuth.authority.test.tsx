import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from './useAuth'

const mocks = vi.hoisted(() => ({ probe: vi.fn(), legacy: vi.fn(), session: vi.fn(), subscribe: vi.fn(), profile: vi.fn(), owned: false, generation: 0, boundary: undefined as (() => void) | undefined }))
vi.mock('../lib/owned-identity', () => ({ probeOwnedIdentitySession: mocks.probe, ownedIdentityActive: () => mocks.owned }))
vi.mock('../lib/browser-auth-authority', () => ({ requireLegacyBrowserAuth: mocks.legacy, browserAuthGeneration: () => mocks.generation,
    legacyBrowserAuthSnapshotCurrent: (generation: number) => !mocks.owned && generation === mocks.generation,
    subscribeBrowserAuthBoundary: (listener: () => void) => { mocks.boundary = listener; return () => {} } }))
vi.mock('../lib/api-client', () => ({ apiFetch: mocks.profile, clearTokenCache: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: mocks.session, onAuthStateChange: mocks.subscribe } } }))
beforeEach(() => {
    vi.clearAllMocks(); mocks.legacy.mockResolvedValue(undefined)
    mocks.owned = false; mocks.generation = 0; mocks.boundary = undefined
    mocks.session.mockResolvedValue({ data: { session: null }, error: null })
    mocks.subscribe.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})
afterEach(cleanup)
function State() { const state = useAuth(); return <output>{JSON.stringify(state)}</output> }
function mount() { return render(<AuthProvider><State /></AuthProvider>) }
describe('browser authority bootstraps user state without legacy fallback', () => {
    it.each(['expired', 'unavailable'])('does not read or subscribe to legacy credentials on %s owned admission', async kind => {
        mocks.probe.mockResolvedValue({ kind })
        mount()
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('"isLoading":false'))
        expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled()
    })
    it('waits for the owned probe before constructing any legacy session listener', async () => {
        let finish!: (value: { kind: string }) => void
        mocks.probe.mockReturnValue(new Promise(resolve => { finish = resolve }))
        mount(); expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled()
        await act(async () => finish({ kind: 'disabled' }))
        await waitFor(() => expect(mocks.session).toHaveBeenCalledOnce())
        expect(mocks.subscribe).toHaveBeenCalledOnce()
    })
    it('uses the admitted local profile instead of provider role/contact metadata', async () => {
        mocks.probe.mockResolvedValue({ kind: 'active', user: { id: 'exact-fixture', email: 'local@example.invalid', isAdmin: true } })
        mount()
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('exact-fixture'))
        expect(screen.getByRole('status')).toHaveTextContent('"isAdmin":true')
        expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled()
    })
    it('discards a delayed legacy bootstrap user after owned authority takes over', async () => {
        let finish!: (value: unknown) => void
        mocks.probe.mockResolvedValue({ kind: 'disabled' })
        mocks.session.mockReturnValue(new Promise(resolve => { finish = resolve }))
        mount(); await waitFor(() => expect(mocks.session).toHaveBeenCalledOnce())
        await act(async () => {
            mocks.owned = true; mocks.generation++; mocks.boundary?.()
            finish({ data: { session: { user: { id: 'old-user', email: 'old@example.invalid' }, access_token: 'old-proof' } }, error: null })
        })
        expect(screen.getByRole('status')).not.toHaveTextContent('old-user')
        expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled()
    })
    it('does not publish a delayed legacy admin profile after the authority changes', async () => {
        let finish!: (value: unknown) => void
        mocks.probe.mockResolvedValue({ kind: 'disabled' })
        mocks.session.mockResolvedValue({ data: { session: { user: { id: 'old-user', email: 'old@example.invalid' }, access_token: 'old-proof' } }, error: null })
        mocks.profile.mockReturnValue(new Promise(resolve => { finish = resolve }))
        mount(); await waitFor(() => expect(mocks.profile).toHaveBeenCalledOnce())
        await act(async () => { mocks.owned = true; mocks.generation++; mocks.boundary?.(); finish({ user: { isAdmin: true } }) })
        expect(screen.getByRole('status')).not.toHaveTextContent('old-user')
        expect(screen.getByRole('status')).not.toHaveTextContent('"isAdmin":true')
        expect(mocks.subscribe).not.toHaveBeenCalled()
    })
})
