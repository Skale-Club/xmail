import type { Request, Response } from 'express'
import { getIdentityRuntime, type IdentityRuntime } from './runtime'
import { ownedIdentityEnabled } from './owned-session'
import { consumeIdentityChallenge, identityCookie, trustedIdentityRequest } from './http-security'

/** Returns absent only when there is no owned credential; an invalid cookie never falls back. */
export async function admitOwnedIdentity(req: Request, res: Response, dependencies: {
    enabled?: () => boolean; runtime?: () => Promise<IdentityRuntime>
} = {}): Promise<'absent' | 'rejected' | 'authenticated'> {
    if (!(dependencies.enabled ?? (() => ownedIdentityEnabled(process.env)))()) return 'absent'
    const name = process.env.NODE_ENV === 'development' ? 'xmail_identity_dev' : '__Host-xmail_identity'
    if (!(req.headers.cookie || '').split(';').some(value => value.trim().startsWith(`${name}=`))) return 'absent'
    try {
        const controller = new AbortController()
        req.once('aborted', () => controller.abort())
        res.once('close', () => { if (!res.writableEnded) controller.abort() })
        const runtime = await (dependencies.runtime ?? getIdentityRuntime)()
        if (!trustedIdentityRequest(req, runtime.config)) { res.status(403).json({ error: 'Identity origin is not allowed.' }); return 'rejected' }
        const raw = identityCookie(req, runtime.config.sessionCookie)
        const principal = raw ? await runtime.sessions.authenticate(raw, controller.signal) : null
        const profile = principal ? await runtime.store.profile(principal.userId) : null
        if (!profile) { res.status(401).json({ error: 'Identity session is unavailable.' }); return 'rejected' }
        // Only these handlers continuously revalidate owned/provider/local/target
        // admission. Other SSE routes retain the explicit fail-closed boundary.
        const streamPath = req.originalUrl.split('?')[0]
        const auditedStream = req.method === 'GET' && (/^\/api\/mail\/mailboxes\/[0-9a-f-]{36}\/events$/i.test(streamPath)
            || streamPath === '/api/outreach/unified-inbox/events')
        if (req.get('accept')?.includes('text/event-stream') && !auditedStream) {
            res.status(409).json({ error: 'Live streams are not available for the identity pilot. Refresh to update.' }); return 'rejected'
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
            && !await consumeIdentityChallenge(req, runtime, `${req.method} ${req.originalUrl.split('?')[0]}`)) {
            res.status(403).json({ error: 'Identity challenge is invalid or expired.' }); return 'rejected'
        }
        req.headers['x-user-id'] = profile.id
        req.headers['x-user-email'] = profile.email
        req.headers['x-user-first-name'] = profile.firstName ?? ''
        req.headers['x-user-last-name'] = profile.lastName ?? ''
        req.headers['x-user-email-verified'] = String(profile.emailVerified)
        // Only the server can set this response-local marker. No profile creation or
        // metadata synchronization may be inferred from a provider/contact snapshot.
        res.locals.xmailOwnedIdentity = true
        res.locals.xmailOwnedPrincipal = principal
        return 'authenticated'
    } catch { res.status(503).json({ error: 'Identity service is unavailable.' }); return 'rejected' }
}
