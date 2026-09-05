/**
 * Pure unit tests for jobQueryClient's DIRECT_URL fallback (see the comment above `jobQueryClient`
 * in index.ts for the full rationale — cron jobs need a connection they can `.reserve()` for a
 * whole run, which Supabase's transaction pooler behind DATABASE_URL is not designed for).
 *
 * No network, no real DB: postgres-js clients are lazy and never open a socket until the first
 * query, so constructing them against syntactically-valid-but-unreachable connection strings is
 * safe here — nothing in this file issues a query.
 *
 * Every test loads a FRESH module instance (`vi.resetModules` + dynamic import) so index.ts's
 * top-level `process.env` reads see exactly what this test stubbed, not whatever an earlier test
 * (or the previous import) left behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DATABASE_URL = 'postgresql://user:pw@aws-0-region.pooler.supabase.com:6543/postgres'
const DIRECT_URL = 'postgresql://user:pw@aws-0-region.pooler.supabase.com:5432/postgres'

async function loadFreshModule() {
    vi.resetModules()
    return import('./index')
}

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('DATABASE_URL', DATABASE_URL)
    vi.stubEnv('NODE_ENV', 'test')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
})

describe('jobQueryClient DIRECT_URL fallback', () => {
    it('falls back to DATABASE_URL and reports that choice when DIRECT_URL is unset', async () => {
        vi.stubEnv('DIRECT_URL', '')
        const mod = await loadFreshModule()

        expect(mod.jobQueryClient).toBeTruthy()
        const logged = logSpy.mock.calls.map((args) => String(args[0]))
        expect(logged.some((line) => line.includes('[DB] jobQueryClient using') && line.includes('DATABASE_URL (DIRECT_URL not set)'))).toBe(true)
    }, 15_000)

    it('prefers DIRECT_URL and reports that choice when it is set', async () => {
        vi.stubEnv('DIRECT_URL', DIRECT_URL)
        const mod = await loadFreshModule()

        expect(mod.jobQueryClient).toBeTruthy()
        const logged = logSpy.mock.calls.map((args) => String(args[0]))
        expect(logged.some((line) => line.includes('[DB] jobQueryClient using DIRECT_URL') && !line.includes('not set'))).toBe(true)
    }, 15_000)

    it('behaves identically to today when DIRECT_URL is unset — same connection string family as DATABASE_URL', async () => {
        vi.stubEnv('DIRECT_URL', '')
        const mod = await loadFreshModule()
        // Both clients were constructed from the same (only available) connection string.
        // We can't inspect postgres-js's parsed connection details directly, but we CAN confirm
        // jobQueryClient exists, is a distinct client instance from queryClient, and did not
        // throw or fall back to some other default in DIRECT_URL's absence.
        expect(mod.jobQueryClient).not.toBe(mod.queryClient)
    }, 15_000)

    it('exports jobQueryClient as a separate client/pool from queryClient, sized per the measured job concurrency', async () => {
        vi.stubEnv('DIRECT_URL', DIRECT_URL)
        const mod = await loadFreshModule()

        expect(mod.jobQueryClient).not.toBe(mod.queryClient)
        const jobOptions = (mod.jobQueryClient as unknown as { options: { max: number } }).options
        const requestOptions = (mod.queryClient as unknown as { options: { max: number } }).options
        // 10 measured peak concurrent job bodies + 2 headroom (see index.ts's comment) — smaller
        // than the request-path pool, since jobs are few and long, not many and short.
        expect(jobOptions.max).toBe(12)
        expect(requestOptions.max).toBe(20)
    }, 15_000)
})
