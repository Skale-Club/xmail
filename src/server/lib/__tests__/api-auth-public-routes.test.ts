/**
 * Guards the public-route allowlist in the /api auth middleware.
 *
 * The allowlist is the one place in this codebase where adding a line makes a
 * route reachable without a Supabase session. The monitor-config entry was
 * added on 2026-08-30 after the endpoint turned out to have been unreachable
 * since it shipped: the JWT gate 401'd it before its own `x-monitor-token`
 * check ever ran, and nobody noticed because MONITOR_API_TOKEN was unset too,
 * so the handler would have returned 503 anyway.
 *
 * These cases pin both directions — that the exemption exists, and that it is
 * narrow. The dependencies are mocked because the public-route branch returns
 * before any of them is touched; importing them for real would open a Supabase
 * client just to assert a routing decision.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
// vitest hoists the vi.mock calls below above this import; none of their factories
// close over local state, so a static import is enough and avoids top-level await
// (which tsconfig.server.json rejects).
import { createApiAuthMiddleware } from '../api-auth'

vi.mock('../auth-cache', () => ({ resolveUserFromToken: vi.fn(async () => ({ user: null, error: 'unused' })) }))
vi.mock('../service-auth', () => ({
    applyServicePrincipal: vi.fn(),
    resolveServiceAuthConfig: vi.fn(() => null),
    SERVICE_KEY_HEADER: 'x-service-key',
    timingSafeEqualStr: vi.fn(() => false),
}))
vi.mock('../outreach-access', () => ({
    SERVICE_ORGANIZATION_HEADER: 'x-service-organization',
    SERVICE_PRINCIPAL_HEADER: 'x-service-principal',
}))
vi.mock('../agent-auth', () => ({
    authenticateOutreachAgent: vi.fn(async () => null),
    stripAgentHeaders: vi.fn(),
}))

/** Drives the middleware and reports whether it passed the request through. */
async function run(method: string, url: string): Promise<{ passed: boolean; status: number | null }> {
    const req = { method, originalUrl: url, headers: {} as Record<string, unknown> } as unknown as Request

    let status: number | null = null
    const res = {
        status(code: number) {
            status = code
            return this
        },
        json() {
            return this
        },
    } as unknown as Response

    let passed = false
    await createApiAuthMiddleware()(req, res, () => {
        passed = true
    })

    return { passed, status }
}

describe('/api auth middleware public routes', () => {
    it('lets the uptime probe reach monitor-config without a bearer token', async () => {
        const { passed } = await run('GET', '/api/admin/integrations/monitor-config')
        expect(passed).toBe(true)
    })

    it('still passes it through when a query string is appended', async () => {
        const { passed } = await run('GET', '/api/admin/integrations/monitor-config?cb=1')
        expect(passed).toBe(true)
    })

    it('does NOT open the rest of the integrations admin API', async () => {
        const listing = await run('GET', '/api/admin/integrations')
        expect(listing.passed).toBe(false)
        expect(listing.status).toBe(401)

        const test = await run('POST', '/api/admin/integrations/test')
        expect(test.passed).toBe(false)
        expect(test.status).toBe(401)
    })

    it('binds the exemption to GET, so it cannot be used to write', async () => {
        for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
            const { passed, status } = await run(method, '/api/admin/integrations/monitor-config')
            expect(passed, `${method} must not be public`).toBe(false)
            expect(status).toBe(401)
        }
    })

    it('keeps an arbitrary admin path behind authentication', async () => {
        const { passed, status } = await run('GET', '/api/admin/outreach/health')
        expect(passed).toBe(false)
        expect(status).toBe(401)
    })
})
