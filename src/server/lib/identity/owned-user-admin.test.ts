import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createOwnedUserAdminAdmission, OwnedAdminError, type OwnedAdminStore, userAdminAuthority } from './owned-user-admin'
import { admitOwnedIdentity } from './api-admission'
import type { IdentityRuntime } from './runtime'
import type { Request, Response } from 'express'

const actor = '10000000-0000-4000-8000-000000000001'
const target = '10000000-0000-4000-8000-000000000002'
const now = 1800000000000
let server: Server, origin: string, env: Record<string, string | undefined>, admitted: boolean, authTime: number
let store: OwnedAdminStore, resolveStore: ReturnType<typeof vi.fn<() => Promise<OwnedAdminStore>>>, legacy: ReturnType<typeof vi.fn<() => void>>
beforeEach(async () => {
    env = { XMAIL_GOOGLE_AUTH_ENABLED: 'true', XMAIL_USER_ADMIN_AUTHORITY: 'owned', XMAIL_BROWSER_AUTH_AUTHORITY: 'owned' }
    admitted = true; authTime = now / 1000
    store = { list: vi.fn(async () => [{ id: target }]), create: vi.fn(async () => ({ id: target })), update: vi.fn(async () => ({ id: target })),
        setActive: vi.fn(async () => ({ id: target })), resetNativePassword: vi.fn(async () => {}) }
    resolveStore = vi.fn(async () => store); legacy = vi.fn()
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
        // Only this server-side fixture represents the prior authenticated admission.
        if (admitted) { res.locals.xmailOwnedIdentity = true; res.locals.xmailOwnedPrincipal = { userId: actor, sessionHash: 'a'.repeat(64), authenticatedAt: authTime } }
        next()
    })
    app.use('/api/users', createOwnedUserAdminAdmission({ env: () => env, store: resolveStore, clock: () => now }))
    app.use((_req, res) => { legacy(); res.status(202).json({ legacy: true }) })
    server = createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/users`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
function request(path = '/', method = 'GET', body?: unknown, headers = {}) {
    return fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
describe('owned user administration authority and HTTP contract', () => {
    it('obtains the administrative principal only from successful owned session admission', async () => {
        const verified = { userId: actor, sessionHash: 'c'.repeat(64), authenticatedAt: Math.floor(Date.now() / 1000) }
        const runtime = {
            config: { origin: 'https://app.example.invalid', sessionCookie: '__Host-xmail_identity' },
            sessions: { authenticate: vi.fn(async () => verified) },
            store: { profile: vi.fn(async () => ({ id: actor, email: 'local@example.invalid', firstName: null, lastName: null, emailVerified: false })) },
        } as unknown as IdentityRuntime
        const req = { method: 'GET', originalUrl: '/api/users', headers: { cookie: `__Host-xmail_identity=${'s'.repeat(43)}`, 'x-user-id': target }, once: vi.fn(),
            get: (name: string) => name === 'host' ? 'app.example.invalid' : undefined } as unknown as Request
        const res = { locals: {}, once: vi.fn() } as unknown as Response
        expect(await admitOwnedIdentity(req, res, { enabled: () => true, runtime: async () => runtime })).toBe('authenticated')
        expect(res.locals.xmailOwnedPrincipal).toEqual(verified)
        expect(req.headers['x-user-id']).toBe(actor)
    })
    it('preserves flag-off legacy default but requires an explicit decision during the pilot', () => {
        expect(userAdminAuthority({})).toBe('legacy')
        expect(userAdminAuthority({ XMAIL_GOOGLE_AUTH_ENABLED: 'true' })).toBe('unavailable')
        expect(userAdminAuthority({ XMAIL_GOOGLE_AUTH_ENABLED: 'true', XMAIL_USER_ADMIN_AUTHORITY: 'legacy' })).toBe('legacy')
        expect(userAdminAuthority({ XMAIL_USER_ADMIN_AUTHORITY: 'owned' })).toBe('unavailable')
        expect(userAdminAuthority({ XMAIL_USER_ADMIN_AUTHORITY: 'typo' })).toBe('unavailable')
    })
    it('does not construct the owned store on an explicitly legacy request', async () => {
        env = {}; admitted = false
        expect((await request()).status).toBe(202)
        expect(legacy).toHaveBeenCalledOnce(); expect(resolveStore).not.toHaveBeenCalled()
    })
    it('never routes an owned credential to legacy administration even when legacy is configured', async () => {
        env.XMAIL_USER_ADMIN_AUTHORITY = 'legacy'
        expect((await request(`/${target}/deactivate`, 'POST', {})).status).toBe(409)
        expect(legacy).not.toHaveBeenCalled(); expect(resolveStore).not.toHaveBeenCalled()
    })
    it('rejects ambiguous pilot mutations before either store/provider branch', async () => {
        delete env.XMAIL_USER_ADMIN_AUTHORITY
        expect((await request('/', 'POST', { email: 'a@example.invalid' })).status).toBe(409)
        expect(legacy).not.toHaveBeenCalled(); expect(resolveStore).not.toHaveBeenCalled()
    })
    it('requires the global authority before local administration can disable legacy-browser admission', async () => {
        delete env.XMAIL_BROWSER_AUTH_AUTHORITY
        expect((await request(`/${target}/deactivate`, 'POST', {})).status).toBe(409)
        expect(resolveStore).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled()
    })
    it('rejects forged headers and a stale or future proof', async () => {
        admitted = false
        expect((await request('/', 'GET', undefined, { 'x-user-id': actor, 'x-xmail-owned-identity': 'true' })).status).toBe(401)
        admitted = true; authTime -= 301
        expect((await request()).status).toBe(401)
        authTime = now / 1000 + 6
        expect((await request()).status).toBe(401)
        expect(resolveStore).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled()
    })
    it('requires explicit local creation and reports no invitation or identity binding', async () => {
        const response = await request('/', 'POST', { email: 'Mailbox@Example.invalid', sendInvite: false, password: 'native-password', organizationId: target })
        expect(response.status).toBe(201)
        expect(await response.json()).toMatchObject({ inviteSent: false, identityLinkRequired: true })
        expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ userId: actor }), expect.objectContaining({ email: 'mailbox@example.invalid', sendInvite: false }))
        expect(legacy).not.toHaveBeenCalled()
    })
    it('refuses implicit invitations, provider subjects and bcrypt truncation before SQL', async () => {
        expect((await request('/', 'POST', { email: 'new@example.invalid' })).status).toBe(409)
        expect((await request('/', 'POST', { email: 'new@example.invalid', sendInvite: false, isAdmin: true, subject: 'bind-me' })).status).toBe(400)
        expect((await request(`/${target}/password`, 'PUT', { password: 'é'.repeat(40) })).status).toBe(400)
        expect(store.create).not.toHaveBeenCalled(); expect(store.resetNativePassword).not.toHaveBeenCalled()
    })
    it.each([['DELETE', `/${target}`], ['POST', `/${target}/resend-invite`], ['POST', '/me/change-password']])('makes unsupported %s %s terminal and explicit', async (method, path) => {
        const response = await request(path, method, {})
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: 'OWNED_ACTION_UNAVAILABLE' })
        expect(resolveStore).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled()
    })
    it('passes only validated target UUIDs and native-reset intent to the store', async () => {
        expect((await request(`/${target}/password`, 'PUT', { password: 'native-password' })).status).toBe(200)
        expect(store.resetNativePassword).toHaveBeenCalledWith(expect.objectContaining({ userId: actor }), target, 'native-password')
        expect((await request('/not-a-uuid/deactivate', 'POST', {})).status).toBe(400)
        expect(store.setActive).not.toHaveBeenCalled()
    })
    it('preserves public error classifications and sanitizes unknown failures without fallback', async () => {
        vi.mocked(store.list).mockRejectedValueOnce(new OwnedAdminError(403, 'Platform admin access is required.'))
        expect((await request()).status).toBe(403)
        vi.mocked(store.list).mockRejectedValueOnce(new Error('postgres://secret; password_hash=private'))
        const response = await request()
        expect(response.status).toBe(503)
        expect(await response.text()).not.toMatch(/postgres|password_hash|private/)
        expect(legacy).not.toHaveBeenCalled()
    })
    it('leaves existing profile and membership endpoints with their authenticated handlers', async () => {
        expect((await request('/profile')).status).toBe(202)
        expect((await request('/organizations')).status).toBe(202)
        expect(resolveStore).not.toHaveBeenCalled()
    })
})
