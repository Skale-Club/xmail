import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createApiAuthMiddleware } from '../api-auth'

vi.mock('../auth-cache', () => ({
    resolveUserFromToken: vi.fn(async () => ({
        user: {
            id: 'offboarded-user',
            email: 'former@example.com',
            firstName: 'Former',
            lastName: 'User',
            emailVerified: true,
            disabled: true,
        },
        error: null,
    })),
}))
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

describe('disabled user authentication', () => {
    it('rejects an otherwise valid live token before exposing identity headers', async () => {
        const req = {
            method: 'GET',
            originalUrl: '/api/users/profile',
            headers: { authorization: 'Bearer still-live-token' },
        } as unknown as Request
        let status = 0
        let body: unknown
        let passed = false
        const res = {
            status(code: number) { status = code; return this },
            json(value: unknown) { body = value; return this },
        } as unknown as Response

        await createApiAuthMiddleware()(req, res, () => { passed = true })

        expect(passed).toBe(false)
        expect(status).toBe(403)
        expect(body).toEqual({ error: 'Account disabled' })
        expect(req.headers['x-user-id']).toBeUndefined()
    })
})
