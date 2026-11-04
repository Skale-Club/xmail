import { beforeEach, expect, it, vi } from 'vitest'
import { createExistingAccountLinker } from './existing-account-link'
import type { GoogleIdentity } from './google-provider'

const now = 1_800_000_000_000, uid = '11111111-1111-4111-8111-111111111111'
let identity: GoogleIdentity
const verify = vi.fn(), status = vi.fn(), passwordProof = vi.fn(), authenticate = vi.fn(), profile = vi.fn(), linkExisting = vi.fn()
const link = () => createExistingAccountLinker({ verify, status, passwordProof, sessions: { authenticate }, store: { profile, linkExisting }, clock: () => now })
const credentials = () => ({ email: 'form@example.invalid', password: crypto.randomUUID() })
beforeEach(() => {
    vi.resetAllMocks()
    identity = { projectId: 'skaleclub', subject: 'new-immutable-provider-id', provider: 'google.com', providerSubject: 'google-subject', authenticatedAt: now / 1000 }
    verify.mockResolvedValue(identity); status.mockResolvedValue({ disabled: false, validSince: 0 }); passwordProof.mockResolvedValue({ id: uid })
    profile.mockResolvedValue({ id: uid, email: 'different-local@example.invalid', isAdmin: true }); linkExisting.mockResolvedValue(true)
    authenticate.mockResolvedValue({ userId: uid })
})
it('binds only the independent online UUID to a recent provider, without a session or contact lookup', async () => {
    await link()('fresh-provider', credentials())
    expect(profile).toHaveBeenCalledWith(uid)
    expect(linkExisting).toHaveBeenCalledWith(identity, uid, 'legacy-password', new Date(now))
    expect(authenticate).not.toHaveBeenCalled()
})
it.each([-6, 301])('rejects future/stale provider proof before using the previous password (%s seconds)', async age => {
    verify.mockResolvedValue({ ...identity, authenticatedAt: now / 1000 - age })
    await expect(link()('provider', credentials())).rejects.toThrow()
    expect(passwordProof).not.toHaveBeenCalled(); expect(linkExisting).not.toHaveBeenCalled()
})
it('requires the fresh provider account to remain active', async () => {
    status.mockResolvedValue({ disabled: true, validSince: 0 })
    await expect(link()('provider', credentials())).rejects.toThrow()
    expect(passwordProof).not.toHaveBeenCalled(); expect(linkExisting).not.toHaveBeenCalled()
})
it('does not treat an existing owned cookie as proof of another account or ignore its expiry', async () => {
    for (const current of [null, { userId: '22222222-2222-4222-8222-222222222222' }]) {
        authenticate.mockResolvedValue(current)
        await expect(link()('provider', credentials(), 'owned-cookie')).rejects.toThrow()
    }
    expect(linkExisting).not.toHaveBeenCalled()
})
it('refuses failed old proof, missing/disabled controls and atomic binding conflicts', async () => {
    passwordProof.mockResolvedValueOnce(null)
    await expect(link()('provider', credentials())).rejects.toThrow()
    expect(profile).not.toHaveBeenCalled()
    profile.mockResolvedValueOnce(null)
    await expect(link()('provider', credentials())).rejects.toThrow()
    expect(linkExisting).not.toHaveBeenCalled()
    linkExisting.mockResolvedValueOnce(false)
    await expect(link()('provider', credentials())).rejects.toThrow()
})
it('cancels before a binding after slow independent proof, never changing native credentials', async () => {
    const caller = new AbortController()
    passwordProof.mockImplementationOnce(async () => { caller.abort(); return { id: uid } })
    await expect(link()('provider', credentials(), undefined, caller.signal)).rejects.toThrow()
    expect(profile).not.toHaveBeenCalled(); expect(linkExisting).not.toHaveBeenCalled()
})
