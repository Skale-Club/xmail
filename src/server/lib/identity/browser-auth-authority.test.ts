import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { browserAuthAuthority, createBrowserAuthRouteGuard } from './browser-auth-authority'
import { createApiAuthMiddleware } from '../api-auth'

const calls = vi.hoisted(() => ({ legacy: vi.fn(), owned: vi.fn(), agent: vi.fn(), service: vi.fn(), bind: vi.fn() }))
vi.mock('../auth-cache', () => ({ resolveUserFromToken: calls.legacy }))
vi.mock('./api-admission', () => ({ admitOwnedIdentity: calls.owned }))
vi.mock('../agent-auth', () => ({ authenticateOutreachAgent: calls.agent, stripAgentHeaders: vi.fn() }))
vi.mock('../outreach-access', () => ({ SERVICE_ORGANIZATION_HEADER: 'x-service-organization', SERVICE_PRINCIPAL_HEADER: 'x-service-principal' }))
vi.mock('../service-auth', () => ({ resolveServiceAuthConfig: calls.service, applyServicePrincipal: calls.bind,
    SERVICE_KEY_HEADER: 'x-service-key', timingSafeEqualStr: (a: string, b: string) => a === b }))

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned'); vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true')
    vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
    calls.owned.mockResolvedValue('absent'); calls.service.mockReturnValue(null)
    calls.agent.mockResolvedValue({ ok: true }); calls.bind.mockReturnValue({ ok: true })
    calls.legacy.mockResolvedValue({ user: { id: 'legacy-fixture', email: 'legacy@example.invalid', disabled: false }, error: null })
})
afterEach(() => vi.unstubAllEnvs())
async function admission(path: string, method = 'GET', headers: Record<string, string> = {}) {
    const req = { originalUrl: path, method, headers: { ...headers } } as Request
    let status = 200, passed = false
    const res = { locals: {}, status(code: number) { status = code; return this }, json() { return this } } as unknown as Response
    await createApiAuthMiddleware()(req, res, () => { passed = true })
    return { status, passed, req }
}
describe('explicit global browser identity authority', () => {
    it('defaults to legacy and refuses invalid or incomplete owned configuration', () => {
        expect(browserAuthAuthority({})).toBe('legacy')
        expect(() => browserAuthAuthority({ XMAIL_BROWSER_AUTH_AUTHORITY: 'typo' })).toThrow()
        expect(() => browserAuthAuthority({ XMAIL_BROWSER_AUTH_AUTHORITY: 'owned' })).toThrow()
        expect(() => browserAuthAuthority({ XMAIL_BROWSER_AUTH_AUTHORITY: 'owned', XMAIL_GOOGLE_AUTH_ENABLED: 'true' })).toThrow()
        expect(browserAuthAuthority({ XMAIL_BROWSER_AUTH_AUTHORITY: 'owned', XMAIL_GOOGLE_AUTH_ENABLED: 'true', XMAIL_USER_ADMIN_AUTHORITY: 'owned' })).toBe('owned')
    })
    it('never resolves a legacy bearer without an owned cookie after cutover', async () => {
        const result = await admission('/api/users/profile', 'GET', { authorization: 'Bearer old-fixture', 'x-user-id': 'forged' })
        expect(result).toMatchObject({ status: 401, passed: false })
        expect(result.req.headers['x-user-id']).toBeUndefined()
        expect(calls.legacy).not.toHaveBeenCalled()
    })
    it.each([401, 503])('does not fall back after an owned cookie rejection (%s)', async status => {
        calls.owned.mockImplementation(async (_req, res: Response) => { res.status(status).json({ error: 'Unavailable' }); return 'rejected' })
        expect(await admission('/api/users/profile', 'GET', { cookie: '__Host-xmail_identity=invalid', authorization: 'Bearer old-fixture' })).toMatchObject({ status, passed: false })
        expect(calls.legacy).not.toHaveBeenCalled()
    })
    it('accepts only the owned admission result and refuses malformed configuration before provider lookup', async () => {
        calls.owned.mockResolvedValue('authenticated')
        expect((await admission('/api/users/profile')).passed).toBe(true)
        vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'legacy'); calls.owned.mockClear()
        expect(await admission('/api/users/profile')).toMatchObject({ status: 503, passed: false })
        expect(calls.owned).not.toHaveBeenCalled(); expect(calls.legacy).not.toHaveBeenCalled()
    })
    it('preserves method-bound public endpoints and capability-scoped machine/agent admission', async () => {
        expect((await admission('/api/system/branding')).passed).toBe(true)
        expect((await admission('/api/auth/authority')).passed).toBe(true)
        expect((await admission('/api/system/branding', 'PATCH')).passed).toBe(false)
        calls.owned.mockClear()
        calls.service.mockReturnValue({ key: 'machine-fixture' })
        const result = await admission('/api/outreach/campaigns', 'POST', { 'x-service-key': 'machine-fixture', 'x-extra-machine-header': 'preserved' })
        expect(result.passed).toBe(true); expect(result.req.headers['x-extra-machine-header']).toBe('preserved')
        expect(calls.bind).toHaveBeenCalledOnce()
        expect((await admission('/api/agent/outreach/status', 'GET', { authorization: 'Bearer agent-fixture' })).passed).toBe(true)
        expect(calls.agent).toHaveBeenCalledOnce(); expect(calls.owned).not.toHaveBeenCalled(); expect(calls.legacy).not.toHaveBeenCalled()
    })
    it('retains default legacy browser bearer behavior when explicitly selected', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy')
        expect((await admission('/api/users/profile', 'GET', { authorization: 'Bearer old-fixture' })).passed).toBe(true)
        expect(calls.legacy).toHaveBeenCalledWith('old-fixture')
    })
    it('makes legacy authentication/recovery routes terminal under owned authority', async () => {
        const guard = createBrowserAuthRouteGuard(() => process.env)
        for (const path of ['/login','/refresh','/reset-password','/update-password','/logout','/register']) {
            let status = 0, next = false
            const res = { status(code: number) { status = code; return this }, json() { return this } } as unknown as Response
            await guard({ method: 'POST', path } as Request, res, () => { next = true })
            expect(status).toBe(409); expect(next).toBe(false)
        }
    })
    it('publishes only safe authority status and projects /me only from server-admitted identity', async () => {
        const guard = createBrowserAuthRouteGuard(() => process.env)
        let body: unknown, next = false, status = 200
        const res = { locals: {}, setHeader: vi.fn(), status(code: number) { status = code; return this }, json(value: unknown) { body = value; return this } } as unknown as Response
        guard({ method: 'GET', path: '/authority' } as Request, res, () => { next = true })
        expect(body).toEqual({ authority: 'owned', available: true }); expect(next).toBe(false)
        guard({ method: 'GET', path: '/me', headers: { 'x-user-id': 'forged' } } as unknown as Request, res, () => {})
        expect(status).toBe(401)
        res.locals = { xmailOwnedIdentity: true, xmailOwnedPrincipal: { userId: 'exact-fixture' } }
        guard({ method: 'GET', path: '/me', headers: { 'x-user-id': 'exact-fixture', 'x-user-email': 'local@example.invalid' } } as unknown as Request, res, () => {})
        expect(body).toMatchObject({ user: { id: 'exact-fixture', email: 'local@example.invalid' }, authMode: 'owned' })
    })
})
