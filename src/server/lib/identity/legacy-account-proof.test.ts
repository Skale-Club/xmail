import { describe, expect, it, vi } from 'vitest'
import { legacyAccountProofConfig, readLegacyPasswordProof } from './legacy-account-proof'

const ref = 'zzbudkfkcmqkavgwselc', uid = '11111111-1111-4111-8111-111111111111'
const publicKey = (role='anon', project=ref) => ['offline', Buffer.from(JSON.stringify({ role, ref: project })).toString('base64url'), 'signature'].join('.')
const env = { NODE_ENV: 'production', SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_ANON_KEY: publicKey() }
const providerToken = ['offline', Buffer.from(JSON.stringify({ sub: 'forged-token-claim' })).toString('base64url'), 'signature'].join('.')
const password = () => crypto.randomUUID()

describe('explicit previous-account possession proof', () => {
    it('uses only a matching public key and the original production project', () => {
        expect(legacyAccountProofConfig(env).origin).toBe(`https://${ref}.supabase.co`)
        for (const changed of [
            { SUPABASE_ANON_KEY: publicKey('service_role') }, { SUPABASE_ANON_KEY: publicKey('anon', 'abcdefghijklmnopqrst') },
            { SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, { SUPABASE_URL: 'http://127.0.0.1' },
            { SUPABASE_URL: `https://${ref}.supabase.co/path` }, { SUPABASE_ANON_KEY: '' },
            { NODE_ENV: 'test' },
        ]) expect(() => legacyAccountProofConfig({ ...env, ...changed })).toThrow()
    })
    it('keeps development isolated without requiring or using an administrative key', () => {
        const devRef = 'abcdefghijklmnopqrst'
        const config = { ...env, NODE_ENV: 'development', XMAIL_DEV_SUPABASE_PROJECT_REF: devRef,
            XMAIL_DEV_SUPABASE_ANON_KEY: publicKey('anon', devRef) }
        expect(legacyAccountProofConfig(config).origin).toBe(`https://${devRef}.supabase.co`)
        expect(() => legacyAccountProofConfig({ ...config, XMAIL_DEV_SUPABASE_PROJECT_REF: ref })).toThrow()
        expect(() => legacyAccountProofConfig({ ...config, XMAIL_DEV_SUPABASE_ANON_KEY: undefined })).toThrow()
    })
    it('proves the online exact UID independently of the form email and token/profile claims', async () => {
        const secret = password(), request = vi.fn<typeof fetch>()
        request.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: providerToken, refresh_token: 'discarded', user: { id: 'untrusted-token-endpoint-id' } })))
        request.mockResolvedValueOnce(new Response(JSON.stringify({ id: uid, email: 'different@example.invalid', app_metadata: { role: 'admin' } })))
        const result = await readLegacyPasswordProof('input@example.invalid', secret, { env, request })
        expect(result).toEqual({ id: uid })
        expect(request).toHaveBeenCalledTimes(2)
        expect(String(request.mock.calls[0][0])).toBe(`https://${ref}.supabase.co/auth/v1/token?grant_type=password`)
        expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ email: 'input@example.invalid', password: secret })
        expect(String(request.mock.calls[1][0])).toBe(`https://${ref}.supabase.co/auth/v1/user`)
        expect(new Headers(request.mock.calls[1][1]!.headers).get('Authorization')).toBe(`Bearer ${providerToken}`)
        for (const [, init] of request.mock.calls) expect(init).toMatchObject({ redirect: 'error', cache: 'no-store' })
        expect(JSON.stringify(result)).not.toContain(secret)
        expect(JSON.stringify(result)).not.toContain(providerToken)
    })
    it.each([
        { id: 'not-a-uuid' }, { id: uid, deleted_at: '2000-01-01' }, { id: uid, banned_until: 'invalid' },
        { id: uid, banned_until: '2099-01-01' }, { id: uid, app_metadata: { xmail_disabled: true } },
        { id: uid, app_metadata: { xmail_disabled: 'false' } }, { email: 'input@example.invalid' },
    ])('refuses disabled, deleted, ambiguous or unproved old accounts %#', async user => {
        const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: providerToken })))
            .mockResolvedValueOnce(new Response(JSON.stringify(user)))
        expect(await readLegacyPasswordProof('input@example.invalid', password(), { env, request })).toBeNull()
    })
    it('stops after an invalid password, malformed token or oversized/redirected response', async () => {
        for (const response of [new Response('{}', { status: 400 }), new Response(JSON.stringify({ access_token: 'invalid' })),
            new Response('x'.repeat(65_537)), new Response('{}', { headers: { 'Content-Length': '90000' } })]) {
            const request = vi.fn<typeof fetch>().mockResolvedValue(response)
            expect(await readLegacyPasswordProof('input@example.invalid', password(), { env, request })).toBeNull()
            expect(request).toHaveBeenCalledTimes(1)
        }
    })
    it('bounds non-cooperative fetches/body streams and honors cancellation without falling back', async () => {
        const stalled = vi.fn<typeof fetch>(() => new Promise(() => {}))
        expect(await readLegacyPasswordProof('input@example.invalid', password(), { env, request: stalled, timeoutMs: 15 })).toBeNull()
        const body = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })))
        expect(await readLegacyPasswordProof('input@example.invalid', password(), { env, request: body, timeoutMs: 15 })).toBeNull()
        const caller = new AbortController(); caller.abort()
        const request = vi.fn<typeof fetch>()
        expect(await readLegacyPasswordProof('input@example.invalid', password(), { env, request, signal: caller.signal })).toBeNull()
        expect(request).not.toHaveBeenCalled()
    })
})
