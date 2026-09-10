/**
 * SEC-01 — SSRF guard for `deliverViaRoutes`'s HTTP branch (inbound-route forwarding).
 *
 * No real DB, no real network: `db` is mocked (the module import throws at load time without a
 * configured DATABASE_URL — see mx-guard.connect-rate.test.ts / outreach-approval-preview.test.ts
 * for the same convention) and `isPrivateHostWithDns` (network-guard.ts) is mocked so the DNS
 * resolution never actually runs. `fetch` is stubbed globally so nothing leaves the process.
 *
 * `tracking.ts` (imported transitively via route-matcher.ts's `incrementStat`) pulls in
 * outreach-tokens.ts, which throws at import time without ENCRYPTION_KEY/JWT_SECRET — set a
 * placeholder before the dynamic import below, mirroring runDailyProspecting.test.ts's pattern
 * for env vars that must exist before the module graph loads.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatchedRoute } from '../route-matcher'

process.env.ENCRYPTION_KEY ||= 'test-only-placeholder-encryption-key'

const isPrivateHostWithDnsMock = vi.fn()

vi.mock('../../../db', () => ({ db: {} }))
vi.mock('../network-guard', () => ({ isPrivateHostWithDns: isPrivateHostWithDnsMock }))

let deliverViaRoutes: typeof import('../route-matcher').deliverViaRoutes

// The module graph behind route-matcher (drizzle schema, nodemailer, outbound transport) is
// heavy to transform; import it once with a generous timeout so a loaded CI box does not
// trip the default 10s hook timeout on the first test.
beforeAll(async () => {
    ({ deliverViaRoutes } = await import('../route-matcher'))
}, 60_000)

beforeEach(() => {
    isPrivateHostWithDnsMock.mockReset()
    vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function httpRoute(url: string, overrides: Partial<{ method: string; headers: Record<string, string>; includeOriginal: boolean }> = {}): MatchedRoute {
    return {
        route: { name: 'test-route' } as unknown as MatchedRoute['route'],
        endpoint: {
            type: 'http',
            config: { url, method: overrides.method, headers: overrides.headers, includeOriginal: overrides.includeOriginal },
        },
    }
}

describe('deliverViaRoutes — HTTP branch SSRF guard', () => {
    it('does not fetch when the resolved host is private/internal', async () => {
        isPrivateHostWithDnsMock.mockResolvedValue(true)
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await deliverViaRoutes(
            'user@example.com',
            Buffer.from('raw'),
            [httpRoute('http://169.254.169.254/latest/meta-data')],
            'org-1',
        )

        expect(isPrivateHostWithDnsMock).toHaveBeenCalledWith('169.254.169.254')
        expect(fetch).not.toHaveBeenCalled()
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('private/internal host'))
    })

    it('fails closed (does not fetch) when the DNS check itself throws', async () => {
        isPrivateHostWithDnsMock.mockRejectedValue(new Error('resolver exploded'))
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await deliverViaRoutes(
            'user@example.com',
            Buffer.from('raw'),
            [httpRoute('http://example.com/hook')],
            'org-1',
        )

        expect(fetch).not.toHaveBeenCalled()
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('DNS check failed'))
    })

    it('does not follow a 3xx redirect and logs it as a failed delivery', async () => {
        isPrivateHostWithDnsMock.mockResolvedValue(false)
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302 })
        vi.stubGlobal('fetch', fetchMock)
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await deliverViaRoutes(
            'user@example.com',
            Buffer.from('raw'),
            [httpRoute('http://example.com/hook')],
            'org-1',
        )

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [, options] = fetchMock.mock.calls[0]
        expect(options.redirect).toBe('manual')
        expect(options.signal).toBeInstanceOf(AbortSignal)
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('status=302'))
    })

    it('fetches a public host normally and does not log a failure', async () => {
        isPrivateHostWithDnsMock.mockResolvedValue(false)
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
        vi.stubGlobal('fetch', fetchMock)
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await deliverViaRoutes(
            'user@example.com',
            Buffer.from('raw'),
            [httpRoute('http://example.com/hook')],
            'org-1',
        )

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(errSpy).not.toHaveBeenCalled()
    })

    it('never throws when fetch itself rejects (network error)', async () => {
        isPrivateHostWithDnsMock.mockResolvedValue(false)
        const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
        vi.stubGlobal('fetch', fetchMock)
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(
            deliverViaRoutes('user@example.com', Buffer.from('raw'), [httpRoute('http://example.com/hook')], 'org-1'),
        ).resolves.toBeUndefined()

        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP route delivery error'), 'ECONNREFUSED')
    })
})
