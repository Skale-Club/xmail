import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from 'postgres'
import type { Request, Response } from 'express'
import type { IdentityRuntime } from './runtime'
import { createOwnedStreamAuthorizer, readOwnedStreamLease } from './owned-stream-access'

const principal = { userId: '10000000-0000-4000-8000-000000000001', sessionHash: 'a'.repeat(64), authenticatedAt: Math.floor(Date.now() / 1000) - 2 }
const target = { kind: 'mailbox' as const, id: '20000000-0000-4000-8000-000000000002' }
const token = 's'.repeat(43)
beforeEach(() => {
    vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true'); vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned')
    vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
})
afterEach(() => vi.unstubAllEnvs())
function fixture() {
    let rows = [{ expiresAt: new Date(Date.now() + 60000) }]
    const cancel = vi.fn()
    const query = vi.fn((_statement: string, _parameters: unknown[]) => Object.assign(Promise.resolve(rows), { cancel }))
    const sql = { unsafe: query } as unknown as Sql
    const authenticate = vi.fn(async () => principal)
    const runtime = { config: { projectId: 'skaleclub', origin: 'https://mail.example.invalid', sessionCookie: '__Host-xmail_identity' }, sessions: { authenticate } } as unknown as IdentityRuntime
    const req = { headers: { cookie: `__Host-xmail_identity=${token}`, authorization: 'Bearer ignored-legacy-fixture', 'x-user-id': 'ignored-caller' },
        get: (name: string) => name === 'host' ? 'mail.example.invalid' : undefined } as unknown as Request
    const res = { locals: { xmailOwnedIdentity: true, xmailOwnedPrincipal: principal } } as unknown as Response
    const sqlGetter = vi.fn(async () => sql)
    const authorize = createOwnedStreamAuthorizer(req, res, target, { runtime: async () => runtime, sql: sqlGetter })
    return { query, cancel, sql, authenticate, sqlGetter, authorize, req, res, setRows: (value: typeof rows) => { rows = value } }
}
describe('owned stream provider proof followed by final local snapshot', () => {
    it('holds no SQL query/connection while checking the provider and pins the exact server principal', async () => {
        const test = fixture()
        let finish!: (value: typeof principal) => void
        test.authenticate.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
        const result = test.authorize(new AbortController().signal)
        await Promise.resolve(); expect(test.query).not.toHaveBeenCalled(); expect(test.sqlGetter).not.toHaveBeenCalled()
        finish(principal)
        expect(await result).toEqual({ expiresAt: expect.any(Number) })
        expect(test.authenticate).toHaveBeenCalledWith(token, expect.any(AbortSignal))
        expect(test.query.mock.calls[0][1]).toEqual([principal.userId, principal.sessionHash, principal.authenticatedAt, 'skaleclub', target.id])
    })
    it('does not query SQL for a missing/replaced principal or a wrong original host', async () => {
        const test = fixture()
        test.authenticate.mockResolvedValueOnce(null as never)
        expect(await test.authorize(new AbortController().signal)).toBeNull()
        test.authenticate.mockResolvedValueOnce({ ...principal, userId: target.id })
        expect(await test.authorize(new AbortController().signal)).toBeNull()
        test.req.get = (() => 'other.example.invalid') as unknown as Request['get']
        expect(await test.authorize(new AbortController().signal)).toBeNull()
        expect(test.query).not.toHaveBeenCalled()
    })
    it('requires final local authorization even when the provider proof succeeded', async () => {
        const test = fixture()
        test.authenticate.mockImplementationOnce(async () => { test.setRows([]); return principal })
        expect(await test.authorize(new AbortController().signal)).toBeNull()
        expect(test.query).toHaveBeenCalledOnce()
    })
    it('rechecks the pilot kill switch after the provider wait', async () => {
        const test = fixture()
        test.authenticate.mockImplementationOnce(async () => { vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'false'); return principal })
        expect(await test.authorize(new AbortController().signal)).toBeNull()
        expect(test.query).not.toHaveBeenCalled()
    })
    it('refuses malformed target/principal without executing arbitrary SQL', async () => {
        const test = fixture(), signal = new AbortController().signal
        expect(await readOwnedStreamLease(test.sql, principal, { ...target, id: '../other' }, 'skaleclub', signal)).toBeNull()
        expect(await readOwnedStreamLease(test.sql, { ...principal, sessionHash: 'invalid' }, target, 'skaleclub', signal)).toBeNull()
        expect(test.query).not.toHaveBeenCalled()
    })
    it('cancels an in-flight final snapshot on stream abort instead of allowing a late lease', async () => {
        const test = fixture(), controller = new AbortController()
        let finish!: (rows: { expiresAt: Date }[]) => void
        test.query.mockReturnValueOnce(Object.assign(new Promise(resolve => { finish = resolve }), { cancel: test.cancel }) as never)
        const result = readOwnedStreamLease(test.sql, principal, target, 'skaleclub', controller.signal)
        controller.abort(); expect(test.cancel).toHaveBeenCalledOnce()
        finish([{ expiresAt: new Date(Date.now() + 60000) }])
        await expect(result).rejects.toThrow()
    })
})
