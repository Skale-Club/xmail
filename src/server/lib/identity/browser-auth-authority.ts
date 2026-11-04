import type { RequestHandler } from 'express'
import { ownedIdentityEnabled } from './owned-session'

/** Browser authority is an explicit cutover, never inferred from a cookie. */
export function browserAuthAuthority(env: Record<string, string | undefined>): 'legacy' | 'owned' {
    const authority = env.XMAIL_BROWSER_AUTH_AUTHORITY
    if (authority === undefined || authority === 'legacy') return 'legacy'
    if (authority === 'owned' && ownedIdentityEnabled(env) && env.XMAIL_USER_ADMIN_AUTHORITY === 'owned') return 'owned'
    throw new Error('Browser identity authority is unavailable.')
}

export function createBrowserAuthRouteGuard(env: () => Record<string, string | undefined>): RequestHandler {
    return (req, res, next) => {
        if (req.method === 'GET' && req.path === '/authority') res.setHeader('Cache-Control', 'no-store')
        let authority: 'legacy' | 'owned'
        try { authority = browserAuthAuthority(env()) }
        catch { return void res.status(503).json({ error: 'Browser identity authority is unavailable.' }) }
        if (req.method === 'GET' && req.path === '/authority') {
            res.setHeader('Cache-Control', 'no-store')
            return void res.json({ authority, available: true })
        }
        if (authority === 'legacy') return next()
        if (req.method === 'GET' && req.path === '/me') {
            const principal = res.locals.xmailOwnedIdentity === true ? res.locals.xmailOwnedPrincipal : undefined
            if (!principal || principal.userId !== req.headers['x-user-id']) return void res.status(401).json({ error: 'Owned identity authentication is required.' })
            return void res.json({ user: { id: principal.userId, email: req.headers['x-user-email'],
                user_metadata: { firstName: req.headers['x-user-first-name'], lastName: req.headers['x-user-last-name'] } }, authMode: 'owned' })
        }
        // Login/refresh/recovery/logout from this legacy router must never reach
        // provider SDKs after the explicit cutover. The identity router is separate.
        return void res.status(409).json({ error: 'Use verified sign-in. Legacy browser authentication and recovery are unavailable.', code: 'LEGACY_BROWSER_AUTH_UNAVAILABLE' })
    }
}
