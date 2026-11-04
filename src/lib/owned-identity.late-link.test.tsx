import { beforeEach, expect, it, vi } from 'vitest'
import { linkExistingIdentityAccount } from './owned-identity'

vi.mock('./browser-auth-authority', () => ({ currentBrowserAuthAuthority: () => 'owned', legacyBrowserAuthConfirmed: () => false,
    lockLegacyBrowserAuth: vi.fn(), resolveBrowserAuthAuthority: async () => 'owned' }))
const request = vi.fn<typeof fetch>()
beforeEach(() => { request.mockReset(); vi.stubGlobal('fetch', request); localStorage.clear(); sessionStorage.clear() })
it('sends old credentials only in the dedicated same-origin one-use challenge flow, with no legacy bearer or storage', async () => {
    const password = crypto.randomUUID(), token = crypto.randomUUID()
    request.mockResolvedValueOnce(new Response(JSON.stringify({ challenge: 'offline-challenge' })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ linked: true })))
    await linkExistingIdentityAccount(token, 'old@example.invalid', password)
    expect(request.mock.calls.map(c => c[0])).toEqual(['/api/auth/identity/challenge?purpose=existing-account-link', '/api/auth/identity/existing-account-link'])
    const init = request.mock.calls[1][1]!
    expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store', method: 'POST' })
    expect(new Headers(init.headers).get('Authorization')).toBeNull()
    expect(JSON.parse(init.body as string)).toEqual({ token, email: 'old@example.invalid', password })
    expect(JSON.stringify(localStorage)).not.toContain(password); expect(JSON.stringify(sessionStorage)).not.toContain(token)
})
it('fails closed on challenge/network/proof failure without trying legacy SDK login or refresh', async () => {
    request.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    await expect(linkExistingIdentityAccount('provider', 'old@example.invalid', crypto.randomUUID())).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
    request.mockReset()
    request.mockResolvedValueOnce(new Response(JSON.stringify({ challenge: 'offline-challenge' })))
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await expect(linkExistingIdentityAccount('provider', 'old@example.invalid', crypto.randomUUID())).rejects.toThrow('Account ownership')
    expect(request).toHaveBeenCalledTimes(2)
})
