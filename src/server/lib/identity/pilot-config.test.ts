import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveIdentityConfig } from './config'
import { createKeylessAccessTokenSupplier, verifyGoogleWebProject, verifyLegacyIdentity } from './runtime'

const ref = 'abcdefghijklmnopqrst'
const env = {
    NODE_ENV: 'development', XMAIL_GOOGLE_AUTH_ENABLED: 'true',
    XMAIL_DEV_GOOGLE_AUTH_PROJECT_ID: 'xmail-isolated-dev', XMAIL_DEV_GOOGLE_AUTH_PROJECT_NUMBER: '123456789012',
    XMAIL_DEV_GOOGLE_AUTH_WEB_API_KEY: 'offline-public-key', XMAIL_DEV_GOOGLE_AUTH_ORIGIN: 'http://localhost:9000',
    XMAIL_DEV_SUPABASE_PROJECT_REF: ref, XMAIL_PRODUCTION_SUPABASE_PROJECT_REF: 'zyxwvutsrqponmlkjihg',
    XMAIL_DEV_SUPABASE_ANON_KEY: 'offline-anon', XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY: 'offline-role',
    XMAIL_DEV_DATABASE_URL: `postgres://postgres.${ref}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
}
// Build a password in memory so a fixture never resembles a committed credential.
env.XMAIL_DEV_DATABASE_URL = env.XMAIL_DEV_DATABASE_URL.replace('@', `:${crypto.randomUUID()}@`)
afterEach(() => vi.unstubAllGlobals())

describe('identity pilot isolation and API-key provenance', () => {
    it('does nothing while disabled and requires explicit isolated dev settings', () => {
        expect(resolveIdentityConfig({})).toBeNull()
        expect(() => resolveIdentityConfig({ NODE_ENV: 'development', XMAIL_GOOGLE_AUTH_ENABLED: 'true' })).toThrow()
        const config = resolveIdentityConfig(env)!
        expect(config.projectId).toBe('xmail-isolated-dev')
        expect(config.sessionCookie).toBe('xmail_identity_dev')
        expect(() => resolveIdentityConfig({ ...env, XMAIL_DEV_GOOGLE_AUTH_PROJECT_ID: 'skaleclub' })).toThrow()
        expect(() => resolveIdentityConfig({ ...env, XMAIL_DEV_GOOGLE_AUTH_PROJECT_NUMBER: '937861185231' })).toThrow()
        expect(() => resolveIdentityConfig({ ...env, XMAIL_PRODUCTION_SUPABASE_PROJECT_REF: ref })).toThrow()
    })
    it('rejects embedded credentials, insecure remote origins and unapproved paths', () => {
        for (const origin of ['http://remote.example', 'https://user:password@example.invalid', 'https://example.invalid/path']) {
            expect(() => resolveIdentityConfig({ ...env, XMAIL_DEV_GOOGLE_AUTH_ORIGIN: origin })).toThrow()
        }
    })
    it('proves the actual API-key project and canonical domain before exposing provider configuration', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
            projectId: '123456789012', authorizedDomains: ['xmail-isolated-dev.firebaseapp.com', 'localhost'],
        })))
        vi.stubGlobal('fetch', fetcher)
        const config = resolveIdentityConfig(env)!
        await expect(verifyGoogleWebProject(config)).resolves.toBeUndefined()
        expect(String(fetcher.mock.calls[0][0])).toBe('https://identitytoolkit.googleapis.com/v1/projects')
        expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-Goog-Api-Key')).toBe(config.apiKey)
        expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Referer')).toBe('http://localhost:9000/')
        expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
    })
    it.each([
        { projectId: '937861185231', authorizedDomains: ['skaleclub.firebaseapp.com', 'localhost'] },
        { projectId: '123456789012', authorizedDomains: ['localhost'] },
        { projectId: '123456789012', authorizedDomains: ['xmail-isolated-dev.firebaseapp.com'] },
        { projectId: 123456789012, authorizedDomains: ['xmail-isolated-dev.firebaseapp.com', 'localhost'] },
        { authorizedDomains: ['xmail-isolated-dev.firebaseapp.com', 'localhost'] },
    ])('refuses production/wrong/unproven API keys %#', async body => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
        await expect(verifyGoogleWebProject(resolveIdentityConfig(env)!)).rejects.toThrow()
    })
    it('fails closed without an explicitly selected keyless credential mechanism', async () => {
        await expect(createKeylessAccessTokenSupplier(resolveIdentityConfig(env)!)).rejects.toThrow('Keyless Google credentials are not configured.')
    })
    it('selects X509 expectations only from the approved environment prefix, without production DEV fallback', () => {
        const isolated = resolveIdentityConfig({ ...env, XMAIL_GOOGLE_AUTH_ADC_AUDIENCE: 'production-only',
            XMAIL_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT: 'production-only', XMAIL_GOOGLE_AUTH_ADC_ROOT: 'production-only' })!
        expect(isolated.adcAudience).toBeUndefined()
        expect(isolated.adcServiceAccount).toBeUndefined()
        expect(isolated.adcRoot).toBeUndefined()
        const configured = resolveIdentityConfig({ ...env, XMAIL_DEV_GOOGLE_AUTH_ADC_AUDIENCE: 'explicit-dev',
            XMAIL_DEV_GOOGLE_AUTH_ADC_SERVICE_ACCOUNT: 'explicit-dev-sa', XMAIL_DEV_GOOGLE_AUTH_ADC_ROOT: 'explicit-dev-root' })!
        expect(configured).toMatchObject({ adcAudience: 'explicit-dev', adcServiceAccount: 'explicit-dev-sa', adcRoot: 'explicit-dev-root' })
    })
    it('uses only the explicit development Supabase host for uncached online exact-UID proof', async () => {
        const uid = crypto.randomUUID()
        const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: uid, app_metadata: {} })))
        vi.stubGlobal('fetch', fetcher)
        expect(await verifyLegacyIdentity('offline-proof', { ...env, SUPABASE_URL: 'https://production.invalid' })).toBe(uid)
        expect(String(fetcher.mock.calls[0][0])).toBe(`https://${ref}.supabase.co/auth/v1/user`)
        expect(fetcher.mock.calls[0][1]?.redirect).toBe('error')
    })
    it('combines cancellation with the eight-second deadline and sanitizes a stalled legacy lookup', async () => {
        const timeout = new AbortController(), caller = new AbortController()
        const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
        vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('private-provider-details')), { once: true })
        })))
        const result = verifyLegacyIdentity('offline-proof', env, caller.signal)
        const assertion = expect(result).rejects.toThrow('Existing account proof is unavailable.')
        caller.abort()
        await assertion
        expect(deadline).toHaveBeenCalledWith(8_000)
        deadline.mockRestore()
    })
})
