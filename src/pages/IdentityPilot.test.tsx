import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import IdentityPilot from './IdentityPilot'

const mocks = vi.hoisted(() => ({
    config: vi.fn(), probe: vi.fn(), action: vi.fn(), google: vi.fn(), phone: vi.fn(), confirm: vi.fn(), dispose: vi.fn(), linkExisting: vi.fn(), storedLegacy: vi.fn(),
}))
vi.mock('../components/AppLogo', () => ({ AppLogo: () => <span>Xmail</span> }))
vi.mock('../lib/owned-identity', () => ({
    loadFirebaseIdentityConfig: mocks.config, probeOwnedIdentitySession: mocks.probe, ownedIdentityAction: mocks.action,
    ownedIdentityActive: () => false, leaveOwnedIdentity: vi.fn(), linkExistingIdentityAccount: mocks.linkExisting, storedLegacyFirstLinkToken: mocks.storedLegacy,
}))
vi.mock('../lib/firebase-identity', () => ({ googleIdentityToken: mocks.google, beginPhoneIdentity: mocks.phone }))
vi.mock('../lib/browser-auth-authority', () => ({ currentBrowserAuthAuthority: () => 'legacy', resolveBrowserAuthAuthority: async () => 'legacy', legacyBrowserAuthConfirmed: () => false }))

beforeEach(() => {
    // jsdom has neither of these and the searchable country list (cmdk) needs both.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    Element.prototype.scrollIntoView = () => undefined
    vi.clearAllMocks()
    window.history.replaceState(null, '', '/auth/identity')
    mocks.config.mockResolvedValue({ projectId: 'offline-dev', apiKey: 'offline-public-key', authDomain: 'offline-dev.firebaseapp.com' })
    mocks.probe.mockResolvedValue({ kind: 'none' })
    mocks.google.mockResolvedValue('offline-provider-token')
    mocks.confirm.mockResolvedValue('offline-phone-token')
    mocks.phone.mockResolvedValue({ confirm: mocks.confirm, dispose: mocks.dispose })
    mocks.action.mockRejectedValue(new Error('Existing ownership proof is required.'))
    mocks.linkExisting.mockResolvedValue(undefined)
})

it('shows phone first, then Google, only after server configuration proof succeeds', async () => {
    render(<IdentityPilot />)
    expect(await screen.findByLabelText('Phone number')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send code' })).toBeVisible()
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
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }))
    await userEvent.type(await screen.findByLabelText('Verification code'), '123456')
    expect(mocks.phone).toHaveBeenCalledWith(expect.anything(), '+12025550123', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    await waitFor(() => expect(mocks.action).toHaveBeenCalledWith('session', 'offline-phone-token', undefined))
    expect(mocks.config).toHaveBeenCalledTimes(3)
    expect(mocks.confirm).toHaveBeenCalledWith('123456', expect.objectContaining({ projectId: 'offline-dev' }))
})

it('sends the number built from the chosen country and a national number', async () => {
    render(<IdentityPilot />)
    await userEvent.click(await screen.findByRole('button', { name: 'Country: United States, +1' }))
    await userEvent.type(screen.getByPlaceholderText('Search country or code'), 'brazil')
    await userEvent.click(await screen.findByRole('option', { name: /Brazil/ }))
    expect(screen.getByRole('button', { name: 'Country: Brazil, +55' })).toBeVisible()
    await waitFor(() => expect(screen.getByLabelText('Phone number')).toHaveFocus())
    await userEvent.type(screen.getByLabelText('Phone number'), '11987654321')
    expect(screen.getByLabelText('Phone number')).toHaveValue('(11) 98765-4321')
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(mocks.phone).toHaveBeenCalledWith(expect.anything(), '+5511987654321', expect.anything()))
})

it('keeps sending disabled while empty and refuses an incomplete number without calling the provider', async () => {
    render(<IdentityPilot />)
    const send = await screen.findByRole('button', { name: 'Send code' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Phone number'), '508555')
    await userEvent.click(send)
    expect(await screen.findByRole('alert')).toHaveTextContent('valid phone number')
    expect(mocks.phone).not.toHaveBeenCalled()
})

it('blocks a provider action when configuration is withdrawn after the page loads', async () => {
    render(<IdentityPilot />)
    const google = await screen.findByRole('button', { name: /Continue with Google/ })
    mocks.config.mockRejectedValue(new Error('Pilot disabled'))
    await userEvent.click(google)
    expect(await screen.findByRole('alert')).toHaveTextContent('Pilot disabled')
    expect(mocks.google).not.toHaveBeenCalled()
})

it('offers an explicit previous-account path without a generic legacy login fallback', async () => {
    render(<IdentityPilot />)
    expect(await screen.findByRole('link', { name: 'Link an existing account' })).toHaveAttribute('href', '/auth/identity?action=existing-account-link')
})

it('links an expired old account using previous credentials plus fresh Google, then attempts only owned login', async () => {
    window.history.replaceState(null, '', '/auth/identity?action=existing-account-link')
    const password = crypto.randomUUID()
    render(<IdentityPilot />)
    await userEvent.type(await screen.findByLabelText('Previous account email'), 'old@example.invalid')
    await userEvent.type(screen.getByLabelText('Previous account password'), password)
    await userEvent.click(screen.getByRole('button', { name: /Continue with Google/ }))
    await waitFor(() => expect(mocks.linkExisting).toHaveBeenCalledWith('offline-provider-token', 'old@example.invalid', password))
    expect(mocks.storedLegacy).not.toHaveBeenCalled()
    expect(mocks.action).toHaveBeenCalledWith('session', 'offline-provider-token')
    expect(screen.getByLabelText('Previous account password')).toHaveValue('')
    expect(JSON.stringify(window.localStorage)).not.toContain(password)
    expect(JSON.stringify(window.sessionStorage)).not.toContain(password)
})

it('does not begin Google or SMS until previous-account details are supplied', async () => {
    window.history.replaceState(null, '', '/auth/identity?action=existing-account-link')
    render(<IdentityPilot />)
    await userEvent.click(await screen.findByRole('button', { name: /Continue with Google/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('previous account email and password')
    expect(mocks.google).not.toHaveBeenCalled(); expect(mocks.phone).not.toHaveBeenCalled()
})
