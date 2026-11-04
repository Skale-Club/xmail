import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createServer as createTcpServer, type AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { resolveStagingHttpConfig } from './staging-config'

const mocks = vi.hoisted(() => ({ legacy: vi.fn(), dangerous: vi.fn(), query: vi.fn(), end: vi.fn(), factory: vi.fn() }))
vi.mock('dotenv/config', () => ({})) // Tests never read repository dotenv files.
vi.mock('./production-server', () => { mocks.legacy(); return { default: {} } })
vi.mock('./jobs/index', () => { mocks.dangerous('jobs'); throw new Error('Forbidden jobs import') })
vi.mock('./smtp-server', () => { mocks.dangerous('smtp'); throw new Error('Forbidden SMTP import') })
vi.mock('./imap-server', () => { mocks.dangerous('imap'); throw new Error('Forbidden IMAP import') })
vi.mock('./mx-server', () => { mocks.dangerous('mx'); throw new Error('Forbidden MX import') })
vi.mock('./lib/supabase', () => { mocks.dangerous('auth'); throw new Error('Forbidden Auth import') })
vi.mock('./lib/db-liveness', () => { mocks.dangerous('watchdog'); throw new Error('Forbidden watchdog import') })
vi.mock('./lib/install-alerting', () => { mocks.dangerous('alerts'); throw new Error('Forbidden alert import') })
vi.mock('./lib/telegram-approvals', () => { mocks.dangerous('telegram'); throw new Error('Forbidden Telegram import') })
vi.mock('../db', () => { mocks.dangerous('legacy-db'); throw new Error('Forbidden legacy database import') })
vi.mock('postgres', () => ({ default: (...args: unknown[]) => {
    mocks.factory(...args)
    return { begin: async (mode: string, run: (tx: unknown) => Promise<unknown>) => {
        expect(mode).toBe('read only'); return run({ unsafe: mocks.query })
    }, end: mocks.end }
} }))

const database = new URL('postgres://e12scyfsrp822dag7m9wwd4x:5432/xmail')
database.username = 'xmail_staging_reader'; database.password = randomUUID()
const env = { NODE_ENV: 'test', XMAIL_STAGING_HTTP_ONLY: 'true', XMAIL_STAGING_DATABASE_URL: database.href,
    XMAIL_STAGING_ORIGIN: 'http://127.0.0.1:0', XMAIL_GOOGLE_AUTH_ENABLED: 'false', GOOGLE_AUTH_ENABLED: 'false' }
const safeProof = () => ({ database: 'xmail', current_role: 'xmail_staging_reader', session_role: 'xmail_staging_reader', read_only: 'on',
    login: true, bypass_rls: true, memberships: 0, tables: 74, readable: 74, business_tables: 70, identity_rls: 4,
    identity_tables: ['xmail_identity_bindings', 'xmail_identity_browser_challenges', 'xmail_identity_owned_sessions', 'xmail_identity_user_controls'],
    superuser: false, create_db: false, create_role: false,
    replication: false, owns_database: false, owns_tables: false, create_schema: false, create_database: false, temp_database: false,
    table_writes: false, sequence_writes: false, function_execute: false })
let proof = safeProof()
let running: Awaited<ReturnType<typeof import('./staging-http').startStagingHttp>> | undefined

beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); proof = safeProof()
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    vi.stubEnv('ENABLE_MAIL_SERVER', 'true')
    vi.stubEnv('DATABASE_URL', 'postgres://production-alias.invalid')
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Forbidden external fetch') }))
    mocks.end.mockResolvedValue(undefined)
    mocks.query.mockImplementation(async (sql: string) => sql.includes('FROM pg_roles r') ? [{ ...proof }]
        : [{ users: 39, organization_users: 38, platform_admins: 1, native_password_hashes: 37 }])
})
afterEach(async () => {
    await running?.close(); running = undefined
    vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
async function boot() {
    const entry = await import('./index')
    running = await entry.startup as NonNullable<typeof running>
    return running
}
async function request(path: string, method = 'GET', host?: string) {
    if (!running) throw new Error('Not started')
    const port = (running.server.address() as AddressInfo).port
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: host ? { Host: host } : {} }, res => {
            let body = ''; res.on('data', value => { body += value }); res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }))
        }); req.on('error', reject); req.end()
    })
}

describe('explicit HTTP-only staging bootstrap', () => {
    it('preserves the legacy default and refuses partial/ambiguous stage configuration', async () => {
        expect(resolveStagingHttpConfig({})).toBeNull()
        for (const config of [{ XMAIL_STAGING_HTTP_ONLY: 'TRUE' }, { XMAIL_STAGING_DATABASE_URL: database.href }, { ...env, NODE_ENV: 'development' }, { ...env, XMAIL_GOOGLE_AUTH_ENABLED: 'true' }]) {
            expect(() => resolveStagingHttpConfig(config)).toThrow('Explicit isolated HTTP staging configuration is required.')
        }
        const { startSelectedRuntime } = await import('./runtime-entry')
        await startSelectedRuntime({})
        expect(mocks.legacy).toHaveBeenCalledOnce()
        expect(mocks.factory).not.toHaveBeenCalled()
    })
    it('requires the dedicated candidate reader URL and ignores inherited source aliases', () => {
        expect(resolveStagingHttpConfig({ ...env, DATABASE_URL: 'postgres://production-alias.invalid' })?.databaseUrl).toBe(database.href)
        for (const change of [
            (url: URL) => { url.username = 'xmail_owner' }, (url: URL) => { url.hostname = 'production.invalid' },
            (url: URL) => { url.pathname = '/postgres' }, (url: URL) => { url.port = '6543' }, (url: URL) => { url.search = 'options=unsafe' },
        ]) { const target = new URL(database); change(target); expect(() => resolveStagingHttpConfig({ ...env, XMAIL_STAGING_DATABASE_URL: target.href })).toThrow() }
        expect(() => resolveStagingHttpConfig({ ...env, XMAIL_STAGING_DATABASE_URL: undefined })).toThrow()
    })
    it('boots the real index and loopback HTTP under production NODE_ENV without loading startup effects', async () => {
        const reservation = createTcpServer()
        await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
        const port = (reservation.address() as AddressInfo).port
        await new Promise<void>(resolve => reservation.close(() => resolve()))
        vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('XMAIL_STAGING_ORIGIN', `http://127.0.0.1:${port}`)
        await boot()
        expect((await request('/health')).status).toBe(200)
        const summary = await request('/api/staging/summary')
        expect(JSON.parse(summary.body).summary).toEqual({ users: 39, organization_users: 38, platform_admins: 1, native_password_hashes: 37 })
        expect(summary.headers['cache-control']).toBe('no-store')
        expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.dangerous).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
        expect(mocks.factory).toHaveBeenCalledWith(database.href, expect.objectContaining({ max: 2, connection: expect.objectContaining({ default_transaction_read_only: true }) }))
    })
    it('refuses mutations, Auth/integrations/tracking and wrong host without touching SQL after boot', async () => {
        await boot(); const before = mocks.query.mock.calls.length
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await request('/api/messages', method)).status).toBe(405)
        for (const path of ['/api/auth/login', '/api/auth/identity/config', '/api/mail/mailboxes', '/t/open', '/o/u/token', '/app-config.js']) expect((await request(path)).status).toBe(403)
        expect((await request('/health', 'GET', 'foreign.invalid')).status).toBe(403)
        expect(mocks.query.mock.calls.length).toBe(before)
        expect(mocks.dangerous).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    })
    it('rechecks live SQL privileges for every aggregate read and denies privilege drift without data', async () => {
        await boot()
        for (const key of ['superuser', 'create_role', 'owns_tables', 'table_writes', 'sequence_writes', 'function_execute'] as const) {
            proof = { ...safeProof(), [key]: true }
            const response = await request('/api/staging/summary')
            expect(response.status).toBe(503); expect(response.body).not.toContain('users')
        }
    })
    it('closes its database pool and refuses listening when reader authority is wrong at boot', async () => {
        proof.current_role = 'xmail_owner'
        const { startSelectedRuntime } = await import('./runtime-entry')
        await expect(startSelectedRuntime(env)).rejects.toThrow('Staging reader startup verification failed.')
        expect(mocks.end).toHaveBeenCalledOnce(); expect(mocks.legacy).not.toHaveBeenCalled()
    })
    it('requires exactly 70 business tables and the four reviewed RLS identity tables', async () => {
        await boot()
        for (const change of [
            { tables: 73 }, { tables: 75 }, { readable: 70 }, { business_tables: 69 }, { identity_rls: 3 },
            { identity_tables: [...safeProof().identity_tables.slice(0, 3), 'unreviewed_identity_table'] },
        ]) {
            proof = { ...safeProof(), ...change }
            const response = await request('/health/ready')
            expect(response.status).toBe(503)
            expect(response.body).not.toContain('native_password_hashes')
        }
    })
    it('sanitizes database errors without falling back to legacy services', async () => {
        await boot(); mocks.query.mockRejectedValue(new Error('private-database-credential-value'))
        const response = await request('/health/ready')
        expect(response.status).toBe(503); expect(response.body).not.toContain('credential')
        expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.dangerous).not.toHaveBeenCalled()
    })
})
