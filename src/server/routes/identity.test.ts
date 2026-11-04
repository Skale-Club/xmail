import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createIdentityRouter } from './identity'
import { admitOwnedIdentity } from '../lib/identity/api-admission'
import type { IdentityRuntime } from '../lib/identity/runtime'
import type { BrowserChallenge } from '../lib/identity/pilot-store'
import mailEventsRouter from './mail/events'

vi.mock('./mail/mailboxes', () => ({ checkUserMailboxAccess: vi.fn() }))
vi.mock('../lib/identity/owned-stream-access', () => ({ createOwnedStreamAuthorizer: () => async () => null }))

let server: Server, origin: string, runtime: IdentityRuntime, runtimeResolver: ReturnType<typeof vi.fn<() => Promise<IdentityRuntime>>>
const token = 's'.repeat(43)
beforeEach(async () => {
    const challenges = new Map<string, BrowserChallenge>()
    runtime = {
        config: { projectId: 'offline-project', projectNumber: '123456789012', apiKey: 'offline-public-key', authDomain: 'offline-project.firebaseapp.com', origin: '', secure: true,
            sessionCookie: '__Host-xmail_identity', browserCookie: '__Host-xmail_identity_browser', adcMode: '' },
        sessions: {
            issue: vi.fn(async () => ({ token, expiresAt: new Date(Date.now() + 60_000), userId: '10000000-0000-4000-8000-000000000001' })),
            authenticate: vi.fn(async () => ({ userId: '10000000-0000-4000-8000-000000000001', sessionHash: 'hash', authenticatedAt: Date.now() / 1000 })),
            revoke: vi.fn(async () => {}),
        },
        store: {
            profile: vi.fn(async () => ({ id: '10000000-0000-4000-8000-000000000001', email: 'existing@example.invalid', firstName: 'Local', lastName: 'User', isAdmin: false, emailVerified: true })),
            createChallenge: vi.fn(async value => { challenges.set(value.challengeHash, value) }),
            consumeChallenge: vi.fn(async value => {
                const row = challenges.get(value.challengeHash)
                if (!row || row.browserHash !== value.browserHash || row.origin !== value.origin || row.operation !== value.operation || row.expiresAt.getTime() <= Date.now()) return false
                challenges.delete(value.challengeHash); return true
            }),
            linkExisting: vi.fn(async () => true), setDisabled: vi.fn(async () => {}),
        },
        assertReady: vi.fn(async () => {}), revokeAll: vi.fn(async () => true), link: vi.fn(async () => {}),
    }
    runtimeResolver = vi.fn(async () => runtime)
    const app = express()
    app.use('/disabled', createIdentityRouter({ enabled: () => false, runtime: runtimeResolver }))
    app.use('/limited', createIdentityRouter({ enabled: () => true, runtime: runtimeResolver, maxAttempts: 1 }))
    app.use('/api/auth/identity', createIdentityRouter({ enabled: () => true, runtime: async () => runtime, bodyTimeoutMs: 100 }))
    app.use('/api/example', async (req, res) => {
        delete req.headers['x-user-id']
        const result = await admitOwnedIdentity(req, res, { enabled: () => true, runtime: async () => runtime })
        if (result === 'authenticated') res.json({ id: req.headers['x-user-id'] })
        else if (result === 'absent') res.status(401).end()
    })
    app.use('/api/mail/mailboxes', async (req, res, next) => {
        const result = await admitOwnedIdentity(req, res, { enabled: () => true, runtime: async () => runtime })
        if (result === 'authenticated') next()
        else if (result === 'absent') res.status(401).end()
    }, mailEventsRouter)
    server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    runtime.config.origin = origin
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })

async function challenge(purpose: string, target?: string) {
    const response = await fetch(`${origin}/api/auth/identity/challenge?purpose=${purpose}${target ? `&target=${encodeURIComponent(target)}` : ''}`)
    expect(response.status).toBe(200)
    return { csrf: (await response.json() as { challenge: string }).challenge, cookie: response.headers.get('set-cookie')!.split(';')[0] }
}
function post(path: string, proof: { csrf: string; cookie: string }, body: unknown = { token: 'verified-offline-token' }, headers: Record<string, string> = {}) {
    return fetch(`${origin}/api/auth/identity/${path}`, { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json', 'X-Xmail-CSRF': proof.csrf, Cookie: proof.cookie, ...headers,
    }, body: JSON.stringify(body) })
}
describe('disabled-by-default owned identity HTTP pilot', () => {
    it('returns 404 without constructing a runtime, reading credentials or changing the legacy principal', async () => {
        expect((await fetch(`${origin}/disabled/config`)).status).toBe(404)
        expect((await fetch(`${origin}/disabled/session`)).status).toBe(404)
        expect(runtimeResolver).not.toHaveBeenCalled()
        const result = await admitOwnedIdentity({ headers: { cookie: `__Host-xmail_identity=${token}` } } as never, {} as never,
            { enabled: () => false, runtime: runtimeResolver })
        expect(result).toBe('absent')
        expect(runtimeResolver).not.toHaveBeenCalled()
    })
    it('bounds login attempts before provider effects and rejects spoofed host/cross-site requests', async () => {
        expect((await fetch(`${origin}/limited/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400)
        expect((await fetch(`${origin}/limited/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(429)
        const spoofedHost = await new Promise<number>(resolve => {
            const request = httpRequest(`${origin}/api/auth/identity/config`, { headers: { Host: 'other.invalid' } }, response => {
                response.resume(); resolve(response.statusCode || 0)
            })
            request.end()
        })
        expect(spoofedHost).toBe(403)
        expect((await fetch(`${origin}/api/auth/identity/config`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
        expect(runtime.sessions.issue).not.toHaveBeenCalled()
        expect(runtime.assertReady).not.toHaveBeenCalled()
    })
    it('issues only a host-only HttpOnly Secure Strict cookie and never returns raw/provider tokens', async () => {
        const proof = await challenge('session'), response = await post('session', proof)
        expect(response.status).toBe(200)
        const cookie = response.headers.get('set-cookie')!
        expect(cookie).toContain('__Host-xmail_identity=')
        for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) expect(cookie).toContain(attribute)
        expect(cookie).not.toContain('Domain=')
        expect(await response.json()).toEqual({ ok: true })
        expect((await post('session', proof)).status).toBe(403)
    })
    it('binds CSRF challenges to browser, origin, operation and one consumption', async () => {
        const proof = await challenge('session')
        expect((await post('session', proof, undefined, { Origin: 'https://other.invalid' })).status).toBe(403)
        expect((await post('link', proof)).status).toBe(403)
        expect((await post('session', { ...proof, cookie: '__Host-xmail_identity_browser=' + 'b'.repeat(43) })).status).toBe(403)
        expect(runtime.sessions.issue).not.toHaveBeenCalled()
    })
    it('requires JSON, bounded bytes and a strict token-only payload', async () => {
        const proof = await challenge('session')
        expect((await post('session', proof, {}, { 'Content-Type': 'text/plain' })).status).toBe(415)
        expect((await post('session', proof, { token: 'x'.repeat(30_000) })).status).toBe(413)
        expect((await post('session', proof, { token: 'verified', userId: 'forged', isAdmin: true })).status).toBe(400)
        expect(runtime.sessions.issue).not.toHaveBeenCalled()
    })
    it('stops a stalled request body rather than holding a provider lookup open', async () => {
        const status = await new Promise<number>(resolve => {
            const request = httpRequest(`${origin}/api/auth/identity/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
                response.resume(); resolve(response.statusCode || 0)
            })
            request.on('error', () => resolve(408))
            request.write('{')
        })
        expect(status).toBe(408)
        expect(runtime.sessions.issue).not.toHaveBeenCalled()
    })
    it('fails closed when provider/ADC readiness is unavailable and sanitizes the response', async () => {
        vi.mocked(runtime.assertReady).mockRejectedValue(new Error('private-credential-details'))
        const response = await fetch(`${origin}/api/auth/identity/config`)
        expect(response.status).toBe(503)
        expect(await response.text()).not.toContain('private-credential-details')
    })
    it('passes only independent existing account proofs to linking, not body user IDs', async () => {
        const proof = await challenge('link')
        expect((await post('link', proof, { token: 'verified' }, { Authorization: 'Bearer offline-legacy-proof' })).status).toBe(200)
        expect(runtime.link).toHaveBeenCalledWith('verified', { ownedToken: undefined, legacyToken: 'offline-legacy-proof' }, expect.any(AbortSignal))
    })
    it('revokes local/all sessions and clears only the host cookie', async () => {
        const proof = await challenge('logout')
        const response = await post('logout', { ...proof, cookie: `${proof.cookie}; __Host-xmail_identity=${token}` }, {})
        expect(response.status).toBe(200)
        expect(runtime.sessions.revoke).toHaveBeenCalledWith(token)
        expect(response.headers.get('set-cookie')).toContain('__Host-xmail_identity=;')
        const all = await challenge('revoke-all')
        expect((await post('revoke-all', { ...all, cookie: `${all.cookie}; __Host-xmail_identity=${token}` }, {})).status).toBe(200)
        expect(runtime.revokeAll).toHaveBeenCalledWith(token, expect.any(AbortSignal))
    })
    it('admits the fresh SQL principal and rejects invalid owned cookies without legacy fallback', async () => {
        const response = await fetch(`${origin}/api/example`, { headers: { Cookie: `__Host-xmail_identity=${token}`, Authorization: 'Bearer unrelated-legacy', 'X-User-Id': 'forged-user' } })
        expect(await response.json()).toEqual({ id: '10000000-0000-4000-8000-000000000001' })
        vi.mocked(runtime.sessions.authenticate).mockResolvedValue(null)
        expect((await fetch(`${origin}/api/example`, { headers: { Cookie: `__Host-xmail_identity=${token}`, Authorization: 'Bearer unrelated-legacy' } })).status).toBe(401)
        expect((await fetch(`${origin}/api/example`, { headers: { Cookie: `__Host-xmail_identity=${token}; __Host-xmail_identity=${token}` } })).status).toBe(503)
    })
    it('requires path-bound CSRF on protected writes and denies legacy SSE until audited', async () => {
        expect((await fetch(`${origin}/api/example`, { method: 'POST', headers: { Origin: origin, Cookie: `__Host-xmail_identity=${token}` } })).status).toBe(403)
        const proof = await challenge('api', 'POST /api/example')
        expect((await fetch(`${origin}/api/example`, { method: 'POST', headers: { Origin: origin, Cookie: `${proof.cookie}; __Host-xmail_identity=${token}`, 'X-Xmail-CSRF': proof.csrf } })).status).toBe(200)
        expect((await fetch(`${origin}/api/example`, { headers: { Cookie: `__Host-xmail_identity=${token}`, Accept: 'text/event-stream' } })).status).toBe(409)
    })
    it.each([undefined, '*/*', 'text/event-stream'])('requires current stream admission regardless of Accept=%s', async accept => {
        const status = await new Promise<number>((resolve, reject) => {
            const request = httpRequest(`${origin}/api/mail/mailboxes/20000000-0000-4000-8000-000000000002/events`, { headers: {
                Cookie: `__Host-xmail_identity=${token}`, ...(accept ? { Accept: accept } : {}),
            } }, response => { response.resume(); resolve(response.statusCode || 0) })
            request.setTimeout(1000, () => request.destroy(new Error('Unexpected open stream')))
            request.on('error', reject); request.end()
        })
        expect(status).toBe(401)
    })
})
