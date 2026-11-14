import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    initialize: vi.fn(), captcha: vi.fn(), clear: vi.fn(), sms: vi.fn(), confirm: vi.fn(), token: vi.fn(), signOut: vi.fn(), popup: vi.fn(),
}))
vi.mock('firebase/app', () => ({ initializeApp: vi.fn(), getApps: () => [] }))
vi.mock('firebase/auth', () => ({
    initializeAuth: mocks.initialize, inMemoryPersistence: {}, browserPopupRedirectResolver: {},
    GoogleAuthProvider: class { setCustomParameters() {} },
    RecaptchaVerifier: class { constructor(...args: unknown[]) { mocks.captcha(...args) } clear() { mocks.clear() } },
    signInWithPhoneNumber: mocks.sms, signInWithPopup: mocks.popup, signOut: mocks.signOut,
}))

const config = { projectId: 'offline-dev', apiKey: 'public-offline-key', authDomain: 'offline-dev.firebaseapp.com' }
beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.initialize.mockReturnValue({})
    mocks.sms.mockResolvedValue({ confirm: mocks.confirm })
    mocks.confirm.mockResolvedValue({ user: { getIdToken: mocks.token } })
    mocks.token.mockResolvedValue('offline-proof')
    mocks.signOut.mockResolvedValue(undefined)
})

it('uses one invisible challenge and removes it as soon as the SMS is sent', async () => {
    const { beginPhoneIdentity } = await import('./firebase-identity')
    const element = {} as HTMLElement
    await beginPhoneIdentity(config, '+12025550123', element)
    expect(mocks.captcha).toHaveBeenCalledExactlyOnceWith(expect.anything(), element, { size: 'invisible' })
    expect(mocks.sms).toHaveBeenCalledOnce()
    expect(mocks.clear).toHaveBeenCalledOnce()
})

it('allows an incorrect code to be corrected without another SMS or CAPTCHA', async () => {
    mocks.confirm.mockRejectedValueOnce({ code: 'auth/invalid-verification-code' })
    const { beginPhoneIdentity } = await import('./firebase-identity')
    const pending = await beginPhoneIdentity(config, '+12025550123', {} as HTMLElement)
    await expect(pending.confirm('111111', config)).rejects.toThrow('incorrect')
    await expect(pending.confirm('222222', config)).resolves.toBe('offline-proof')
    expect(mocks.sms).toHaveBeenCalledOnce()
    expect(mocks.captcha).toHaveBeenCalledOnce()
})

it('reuses a successful proof in memory when the Xmail request needs retrying', async () => {
    const { beginPhoneIdentity } = await import('./firebase-identity')
    const pending = await beginPhoneIdentity(config, '+12025550123', {} as HTMLElement)
    expect(await pending.confirm('123456', config)).toBe('offline-proof')
    expect(await pending.confirm('123456', config)).toBe('offline-proof')
    expect(mocks.confirm).toHaveBeenCalledOnce()
    expect(mocks.signOut).toHaveBeenCalledOnce()
    pending.dispose()
    await expect(pending.confirm('123456', config)).rejects.toThrow('Request a new')
    expect(mocks.clear).toHaveBeenCalledOnce()
})

it('retains the verified user if fetching its token fails temporarily', async () => {
    mocks.token.mockRejectedValueOnce({ code: 'auth/network-request-failed' })
    const { beginPhoneIdentity } = await import('./firebase-identity')
    const pending = await beginPhoneIdentity(config, '+12025550123', {} as HTMLElement)
    await expect(pending.confirm('123456', config)).rejects.toThrow('connection')
    await expect(pending.confirm('123456', config)).resolves.toBe('offline-proof')
    expect(mocks.confirm).toHaveBeenCalledOnce()
})

it('cleans up a failed send and gives a useful throttling error', async () => {
    mocks.sms.mockRejectedValueOnce({ code: 'auth/too-many-requests' })
    const { beginPhoneIdentity } = await import('./firebase-identity')
    await expect(beginPhoneIdentity(config, '+12025550123', {} as HTMLElement)).rejects.toThrow('Too many attempts')
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(mocks.signOut).toHaveBeenCalledOnce()
})

it('explains a blocked Google popup and still clears the provider session', async () => {
    mocks.popup.mockRejectedValueOnce({ code: 'auth/popup-blocked' })
    const { googleIdentityToken } = await import('./firebase-identity')
    await expect(googleIdentityToken(config)).rejects.toThrow('Allow pop-ups for Xmail')
    expect(mocks.signOut).toHaveBeenCalledOnce()
})
