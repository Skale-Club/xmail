import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import IdentityPilot from './IdentityPilot'

const mocks = vi.hoisted(() => ({
    config: vi.fn(), probe: vi.fn(), action: vi.fn(), google: vi.fn(), phone: vi.fn(), confirm: vi.fn(), dispose: vi.fn(),
}))
vi.mock('../components/AppLogo', () => ({ AppLogo: () => <span>Xmail</span> }))
vi.mock('../lib/owned-identity', () => ({
    loadFirebaseIdentityConfig: mocks.config, probeOwnedIdentitySession: mocks.probe, ownedIdentityAction: mocks.action,
    ownedIdentityActive: () => false, leaveOwnedIdentity: vi.fn(),
}))
vi.mock('../lib/firebase-identity', () => ({ googleIdentityToken: mocks.google, beginPhoneIdentity: mocks.phone }))
vi.mock('../lib/browser-auth-authority', () => ({ currentBrowserAuthAuthority: () => 'legacy', resolveBrowserAuthAuthority: async () => 'legacy' }))

beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/auth/identity')
    mocks.config.mockResolvedValue({ projectId: 'offline-dev', apiKey: 'offline-public-key', authDomain: 'offline-dev.firebaseapp.com' })
    mocks.probe.mockResolvedValue({ kind: 'none' })
    mocks.google.mockResolvedValue('offline-provider-token')
    mocks.confirm.mockResolvedValue('offline-phone-token')
    mocks.phone.mockResolvedValue({ confirm: mocks.confirm, dispose: mocks.dispose })
    mocks.action.mockRejectedValue(new Error('Existing ownership proof is required.'))
})

it('shows phone first, then Google, only after server configuration proof succeeds', async () => {
    render(<IdentityPilot />)
    expect(await screen.findByLabelText('Phone number')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send verification code' })).toBeVisible()
    expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(mocks.phone).not.toHaveBeenCalled()
    expect(mocks.google).not.toHaveBeenCalled()
})

it('does not offer or initialize provider auth when the server pilot is disabled/unproven', async () => {
    mocks.config.mockRejectedValue(new Error('Unavailable'))
    render(<IdentityPilot />)
    expect(await screen.findByRole('alert')).toHaveTextContent('not available')
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument()
    expect(mocks.google).not.toHaveBeenCalled()
    expect(mocks.phone).not.toHaveBeenCalled()
})

it('revalidates the kill switch before Google, submits the fresh token once and keeps it out of browser storage', async () => {
    render(<IdentityPilot />)
    await userEvent.click(await screen.findByRole('button', { name: /Continue with Google/ }))
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('session', 'offline-provider-token', undefined))
    expect(mocks.config).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('alert')).toHaveTextContent('Existing ownership proof')
    expect(JSON.stringify(window.localStorage)).not.toContain('offline-provider-token')
    expect(JSON.stringify(window.sessionStorage)).not.toContain('offline-provider-token')
})

it('requests SMS, asks for the code, then revalidates before confirmation', async () => {
    render(<IdentityPilot />)
    await userEvent.type(await screen.findByLabelText('Phone number'), '+12025550123')
    await userEvent.click(screen.getByRole('button', { name: 'Send verification code' }))
    await userEvent.type(await screen.findByLabelText('Verification code'), '123456')
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('session', 'offline-phone-token', undefined))
    expect(mocks.config).toHaveBeenCalledTimes(3)
    expect(mocks.confirm).toHaveBeenCalledWith('123456', expect.objectContaining({ projectId: 'offline-dev' }))
})

it('blocks a provider action when configuration is withdrawn after the page loads', async () => {
    render(<IdentityPilot />)
    const google = await screen.findByRole('button', { name: /Continue with Google/ })
    mocks.config.mockRejectedValue(new Error('Pilot disabled'))
    await userEvent.click(google)
    expect(await screen.findByRole('alert')).toHaveTextContent('Pilot disabled')
    expect(mocks.google).not.toHaveBeenCalled()
})
