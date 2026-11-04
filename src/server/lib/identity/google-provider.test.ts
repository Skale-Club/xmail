import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { createGoogleAccountStatusReader, createGoogleIdentityVerifier, createGoogleSigningKeyResolver, GOOGLE_CERTIFICATES_URL, requireActiveGoogleAccount } from './google-provider'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const project = 'skaleclub', now = 1_800_000_000
const claims = {
    aud: project, iss: `https://securetoken.google.com/${project}`, sub: 'firebase-user',
    iat: now, exp: now + 3600, auth_time: now,
    firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['immutable-google-subject'] } },
}
const verify = createGoogleIdentityVerifier(project, async () => publicKey, () => now * 1000)
function signed(overrides: Record<string, unknown> = {}) {
    const payload = Object.fromEntries(Object.entries({ ...claims, ...overrides }).filter(([, value]) => value !== undefined))
    return jwt.sign(payload, privateKey, {
        algorithm: 'RS256', keyid: 'test-key',
        ...(Object.prototype.hasOwnProperty.call(overrides, 'iat') && overrides.iat === undefined ? { noTimestamp: true } : {}),
    })
}

describe('Google identity verification', () => {
    it('returns only signed project/subjects/provider/auth time, never contact matches or grants', async () => {
        expect(await verify(signed({ email: 'profile@example.invalid', email_verified: true, admin: true }))).toEqual({
            projectId: project, subject: 'firebase-user', provider: 'google.com', providerSubject: 'immutable-google-subject', authenticatedAt: now,
        })
    })
    it('accepts phone only from the phone sign-in provider with signed E.164 proof', async () => {
        expect((await verify(signed({ firebase: { sign_in_provider: 'phone' }, phone_number: '+12025550123' }))).provider).toBe('phone')
    })
    it.each([
        { aud: 'other-project' }, { aud: [project] }, { iss: 'https://attacker.invalid' },
        { sub: '' }, { sub: 'x'.repeat(129) }, { sub: ' padded ' },
        { exp: undefined }, { exp: now - 10 }, { exp: now + 7200 },
        { iat: undefined }, { iat: now + 20 }, { iat: now - 4000 },
        { auth_time: undefined }, { auth_time: now + 20 }, { auth_time: 1.5 },
        { firebase: { sign_in_provider: 'password' } }, { firebase: { sign_in_provider: 'custom' } },
        { firebase: { sign_in_provider: 'anonymous' } },
        { firebase: { ...claims.firebase, tenant: 'unconfigured-tenant' } },
        { firebase: { sign_in_provider: 'google.com', identities: {} } },
        { firebase: { sign_in_provider: 'google.com', identities: { 'google.com': ['one', 'two'] } } },
        { firebase: { sign_in_provider: 'phone' }, phone_number: '2025550123' },
        { firebase: { sign_in_provider: 'phone' }, phone_number: undefined },
    ])('rejects unsupported or invalid signed claims %#', async overrides => {
        await expect(verify(signed(overrides))).rejects.toThrow('Invalid Google identity.')
    })
    it('rejects an HMAC token rather than confusing its key with a Google RSA certificate', async () => {
        await expect(verify(jwt.sign(claims, randomUUID(), { algorithm: 'HS256', keyid: 'test-key' })))
            .rejects.toThrow('Invalid Google identity.')
    })
    it('rejects a token signed with another RSA key', async () => {
        const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
        await expect(verify(jwt.sign(claims, other.privateKey, { algorithm: 'RS256', keyid: 'test-key' })))
            .rejects.toThrow('Invalid Google identity.')
    })
    it('rejects absent key ID, malformed/oversized tokens and invalid configured projects', async () => {
        for (const token of ['', 'invalid', 'x'.repeat(16_385), jwt.sign(claims, privateKey, { algorithm: 'RS256' })]) {
            await expect(verify(token)).rejects.toThrow('Invalid Google identity.')
        }
        expect(() => createGoogleIdentityVerifier('invalid/project')).toThrow('Invalid Google identity project.')
    })
})

describe('fixed signing key source', () => {
    it('shares/cache-bounds key retrieval and never serves stale keys after a failed refresh', async () => {
        let clock = now * 1000
        const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ 'test-key': 'public-certificate' }), { headers: { 'cache-control': 'public, max-age=30' } }))
        const resolve = createGoogleSigningKeyResolver(fetcher, () => clock)
        expect(await Promise.all([resolve('test-key'), resolve('test-key')])).toEqual(['public-certificate', 'public-certificate'])
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(fetcher.mock.calls[0][0]).toBe(GOOGLE_CERTIFICATES_URL)
        expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
        clock += 31_000
        fetcher.mockRejectedValue(new Error('private-provider-details'))
        await expect(resolve('test-key')).rejects.toThrow('Google signing keys are unavailable.')
    })
    it('does not accept a caller-supplied URL as key ID', async () => {
        const fetcher = vi.fn<typeof fetch>()
        await expect(createGoogleSigningKeyResolver(fetcher)('https://attacker.invalid/key')).rejects.toThrow()
        expect(fetcher).not.toHaveBeenCalled()
    })
})

describe('live Google account status', () => {
    it('looks up only the exact UID in the configured project using a supplied short-lived credential', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ users: [{ localId: 'firebase-user', validSince: String(now) }] })))
        const read = createGoogleAccountStatusReader(project, async () => randomUUID(), fetcher)
        expect(await read({ projectId: project, subject: 'firebase-user' })).toEqual({ disabled: false, validSince: now })
        expect(fetcher.mock.calls[0][0]).toBe(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:lookup`)
        expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ localId: ['firebase-user'] })
    })
    it.each([
        {}, { users: [] }, { users: [{ localId: 'another-user' }] },
        { users: [{ localId: 'firebase-user', disabled: 'false' }] },
        { users: [{ localId: 'firebase-user', validSince: '-1' }] },
        { users: [{ localId: 'firebase-user', validSince: 'not-a-timestamp' }] },
        { users: [{ localId: 'firebase-user', tenantId: 'another-tenant' }] },
    ])('fails closed on absent/invalid provider accounts %#', async body => {
        const read = createGoogleAccountStatusReader(project, async () => randomUUID(), async () => new Response(JSON.stringify(body)))
        await expect(read({ projectId: project, subject: 'firebase-user' })).rejects.toThrow('Google account status is unavailable.')
    })
    it('never treats provider/credential failure as an active account or uses another project', async () => {
        const fetcher = vi.fn<typeof fetch>()
        const read = createGoogleAccountStatusReader(project, async () => { throw new Error('private-credential-details') }, fetcher)
        await expect(read({ projectId: project, subject: 'firebase-user' })).rejects.toThrow('Google account status is unavailable.')
        await expect(read({ projectId: 'other-project', subject: 'firebase-user' })).rejects.toThrow('Google account status is unavailable.')
        expect(fetcher).not.toHaveBeenCalled()
    })
    it('enforces provider bans and revocation against original authentication time', () => {
        expect(() => requireActiveGoogleAccount({ authenticatedAt: now }, { disabled: true, validSince: 0 })).toThrow()
        expect(() => requireActiveGoogleAccount({ authenticatedAt: now }, { disabled: false, validSince: now + 1 })).toThrow()
        expect(() => requireActiveGoogleAccount({ authenticatedAt: now }, { disabled: false, validSince: now })).not.toThrow()
    })
    it('shares one deadline across credentials and lookup instead of granting a fresh eight seconds', async () => {
        const token = vi.fn(async (_signal?: AbortSignal) => 'offline-token')
        const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ users: [{ localId: 'firebase-user' }] })))
        await createGoogleAccountStatusReader(project, token, fetcher)({ projectId: project, subject: 'firebase-user' })
        expect(token.mock.calls[0][0]).toBe(fetcher.mock.calls[0][1]?.signal)
        expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
    })
    it('does not call lookup after credential acquisition consumes the deadline', async () => {
        const caller = new AbortController(), fetcher = vi.fn<typeof fetch>()
        const token = vi.fn(async () => { caller.abort(); return 'offline-token' })
        await expect(createGoogleAccountStatusReader(project, token, fetcher)({ projectId: project, subject: 'firebase-user' }, caller.signal))
            .rejects.toThrow('Google account status is unavailable.')
        expect(fetcher).not.toHaveBeenCalled()
    })
    it('bounds oversized and stalled lookup bodies, even if stream cancellation never resolves', async () => {
        const oversized = createGoogleAccountStatusReader(project, async () => 'offline-token', async () => new Response('x'.repeat(65_537)))
        await expect(oversized({ projectId: project, subject: 'firebase-user' })).rejects.toThrow('Google account status is unavailable.')
        const caller = new AbortController()
        const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
            pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}),
        })))
        const pending = createGoogleAccountStatusReader(project, async () => 'offline-token', fetcher)({ projectId: project, subject: 'firebase-user' }, caller.signal)
        const assertion = expect(pending).rejects.toThrow('Google account status is unavailable.')
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
        caller.abort()
        await assertion
    })
})
