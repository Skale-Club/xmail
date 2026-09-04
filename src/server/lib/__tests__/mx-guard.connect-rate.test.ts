/**
 * Pure unit tests for the connect-rate limiter and its own-host exemption.
 *
 * 2026-09 fix: 840 "Invalid greeting ... 421 4.7.0 Too many connections from your IP" errors in
 * 7 days (838 in one post-restart burst) turned out to be our own `checkConnectRate` rejecting
 * our own warm-up mesh, which routes between our own inboxes all pointed at this same MX. This
 * file guards `isOwnHostIp` (the exemption signal: loopback / Docker bridge range / MAIL_HOST's
 * resolved public IP) and `checkConnectRate` (exempts that signal entirely, still rate-limits
 * everyone else).
 *
 * `dns.resolve4` is mocked and every test loads a FRESH module instance (`vi.resetModules` +
 * dynamic import) so the background-refreshed IP cache, its timer, and the per-IP connection
 * map all start clean — otherwise state from one test (a resolved IP, a used-up rate-limit
 * window) would leak into the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolve4Mock = vi.hoisted(() => vi.fn())

vi.mock('dns', () => ({
    promises: { resolve4: (...args: unknown[]) => resolve4Mock(...args) },
}))

// mx-guard.ts also imports queryClient from '../../db' for isOwnMeshSender/shouldGreylist, which
// this file doesn't exercise — stub it so importing the module never touches a real DB.
vi.mock('../../../db', () => ({ queryClient: vi.fn() }))

async function loadFreshModule() {
    vi.resetModules()
    return import('../mx-guard')
}

beforeEach(() => {
    resolve4Mock.mockReset()
    vi.unstubAllEnvs()
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
})

describe('isOwnHostIp', () => {
    it('matches loopback addresses without any DNS lookup', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { isOwnHostIp } = await loadFreshModule()
        expect(isOwnHostIp('127.0.0.1')).toBe(true)
        expect(isOwnHostIp('::1')).toBe(true)
        expect(isOwnHostIp('::ffff:127.0.0.1')).toBe(true)
        expect(resolve4Mock).not.toHaveBeenCalled()
    })

    it('matches the Docker bridge range (172.16.0.0/12)', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { isOwnHostIp } = await loadFreshModule()
        expect(isOwnHostIp('172.16.0.1')).toBe(true)
        expect(isOwnHostIp('172.17.0.2')).toBe(true)
        expect(isOwnHostIp('172.31.255.1')).toBe(true)
    })

    it('does NOT match a private range outside the Docker bridge allocation', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { isOwnHostIp } = await loadFreshModule()
        expect(isOwnHostIp('172.32.0.1')).toBe(false)
        expect(isOwnHostIp('172.15.0.1')).toBe(false)
        expect(isOwnHostIp('10.0.0.5')).toBe(false)
        expect(isOwnHostIp('192.168.1.1')).toBe(false)
    })

    it("matches MAIL_HOST's resolved public IP once refreshOwnHostIpCache resolves", async () => {
        vi.stubEnv('MAIL_HOST', 'mx.skale.club')
        resolve4Mock.mockResolvedValue(['203.0.113.9'])
        const { isOwnHostIp, refreshOwnHostIpCache } = await loadFreshModule()
        await refreshOwnHostIpCache()
        expect(isOwnHostIp('203.0.113.9')).toBe(true)
        expect(resolve4Mock).toHaveBeenCalledWith('mx.skale.club')
    })

    it('does not match a stranger IP even after a successful resolution', async () => {
        vi.stubEnv('MAIL_HOST', 'mx.skale.club')
        resolve4Mock.mockResolvedValue(['203.0.113.9'])
        const { isOwnHostIp, refreshOwnHostIpCache } = await loadFreshModule()
        await refreshOwnHostIpCache()
        expect(isOwnHostIp('198.51.100.7')).toBe(false)
    })

    it('leaves the previous cache in place on a DNS error rather than clearing it', async () => {
        vi.stubEnv('MAIL_HOST', 'mx.skale.club')
        resolve4Mock.mockResolvedValue(['203.0.113.9'])
        const { isOwnHostIp, refreshOwnHostIpCache } = await loadFreshModule()
        // Explicit await regardless of the module's own fire-and-forget refresh at import time —
        // this establishes a known-good cache before the failure case below.
        await refreshOwnHostIpCache()
        expect(isOwnHostIp('203.0.113.9')).toBe(true)

        resolve4Mock.mockRejectedValueOnce(new Error('ENOTFOUND'))
        await refreshOwnHostIpCache()
        // Still exempt: a transient resolution failure must not silently revoke the exemption.
        expect(isOwnHostIp('203.0.113.9')).toBe(true)
    })

    it('does nothing (no DNS call) when MAIL_HOST is unset', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { refreshOwnHostIpCache } = await loadFreshModule()
        await refreshOwnHostIpCache()
        expect(resolve4Mock).not.toHaveBeenCalled()
    })
})

describe('checkConnectRate', () => {
    it('exempts our own host entirely — never rejects no matter how many connections', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { checkConnectRate } = await loadFreshModule()
        for (let i = 0; i < 50; i++) {
            expect(checkConnectRate('127.0.0.1')).toBe(true)
        }
    })

    it('still rejects a stranger past the threshold', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { checkConnectRate } = await loadFreshModule()
        const stranger = '198.51.100.42'
        for (let i = 0; i < 10; i++) {
            expect(checkConnectRate(stranger)).toBe(true)
        }
        expect(checkConnectRate(stranger)).toBe(false)
    })

    it('rate-limits each stranger IP independently', async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { checkConnectRate } = await loadFreshModule()
        for (let i = 0; i < 10; i++) checkConnectRate('198.51.100.1')
        expect(checkConnectRate('198.51.100.1')).toBe(false)
        // A different, unrelated IP is unaffected by the first one's exhausted window.
        expect(checkConnectRate('198.51.100.2')).toBe(true)
    })

    it("a Docker-bridge peer is exempt even though it would otherwise exceed the threshold", async () => {
        vi.stubEnv('MAIL_HOST', '')
        const { checkConnectRate } = await loadFreshModule()
        for (let i = 0; i < 50; i++) {
            expect(checkConnectRate('172.18.0.5')).toBe(true)
        }
    })
})
