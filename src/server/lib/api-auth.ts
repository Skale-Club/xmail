/**
 * Express `/api` authentication middleware.
 *
 * Extracted from server/index.ts so it can be exercised directly in tests. It resolves,
 * in order:
 *   1. explicitly public routes (method + path bound);
 *   2. machine-to-machine service-key auth for `/api/outreach/*` (bound principal + org);
 *   3. Supabase JWT bearer auth (the normal path).
 *
 * On every request it first strips the internal service-principal markers so a client can
 * never forge them, and this middleware is the ONLY place that overwrites the trusted
 * `x-user-id` header from a verified identity.
 */
import type { RequestHandler } from 'express'
import { resolveUserFromToken } from './auth-cache'
import {
    applyServicePrincipal,
    resolveServiceAuthConfig,
    SERVICE_KEY_HEADER,
    timingSafeEqualStr,
} from './service-auth'
import { SERVICE_ORGANIZATION_HEADER, SERVICE_PRINCIPAL_HEADER } from './outreach-access'

// SEC — each entry binds a METHOD to a path. Matching on path alone would make a route
// public for writes just because it is public for reads (see the branding write bypass note
// this replaced).
const PUBLIC_ROUTES: { method: string; path: string }[] = [
    { method: 'POST', path: '/api/auth/login' },
    { method: 'POST', path: '/api/auth/register' },
    { method: 'POST', path: '/api/auth/reset-password' },
    { method: 'POST', path: '/api/auth/refresh' },
    { method: 'GET', path: '/api/system/branding' },
    { method: 'GET', path: '/api/system/mail-server-info' },
]

// GET-only autodiscover config (Apple .mobileconfig); a prefix because the path carries a query.
const PUBLIC_GET_PREFIXES = ['/api/system/mail-config/']

export function createApiAuthMiddleware(): RequestHandler {
    return async (req, res, next) => {
        const path = req.originalUrl.split('?')[0]

        // Internal service markers are set only by this middleware after the service key is
        // verified. Strip any client-supplied copies so they can never be forged.
        delete req.headers[SERVICE_PRINCIPAL_HEADER]
        delete req.headers[SERVICE_ORGANIZATION_HEADER]

        if (PUBLIC_ROUTES.some((r) => r.method === req.method && r.path === path)) {
            return next()
        }
        if (req.method === 'GET' && PUBLIC_GET_PREFIXES.some((p) => path.startsWith(p))) {
            return next()
        }

        // Machine-to-machine auth for the Xphere orchestrator, which drives outreach
        // server-to-server and cannot hold a Supabase session. Only active when the full
        // service principal is configured (fails closed — a partial/unset config means the
        // bypass does not exist). The verified caller acts ONLY as the server-configured
        // principal and organization; the client cannot pick its own identity or tenant.
        const serviceConfig = resolveServiceAuthConfig()
        if (path.startsWith('/api/outreach/') && serviceConfig) {
            const providedKey = req.headers[SERVICE_KEY_HEADER]
            if (typeof providedKey === 'string' && providedKey.length > 0) {
                if (!timingSafeEqualStr(providedKey, serviceConfig.key)) {
                    return res.status(401).json({ error: 'Unauthorized' })
                }
                // Never let the verified secret travel further with the request.
                delete req.headers[SERVICE_KEY_HEADER]
                const bound = applyServicePrincipal(req, serviceConfig)
                if (!bound.ok) {
                    return res.status(bound.status ?? 403).json(bound.body)
                }
                return next()
            }
        }

        const authHeader = req.headers.authorization
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const token = authHeader.replace('Bearer ', '')
        // SEC-03 — see src/server/lib/auth-cache.ts
        const { user, error } = await resolveUserFromToken(token)

        if (error || !user) {
            return res.status(401).json({ error: error ?? 'Invalid or expired token' })
        }

        req.headers['x-user-id'] = user.id
        req.headers['x-user-email'] = user.email ?? ''
        req.headers['x-user-first-name'] = user.firstName
        req.headers['x-user-last-name'] = user.lastName
        req.headers['x-user-email-verified'] = String(user.emailVerified)

        next()
    }
}
