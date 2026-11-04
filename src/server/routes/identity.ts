import { Router, json, type Request, type Response, type NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { getIdentityRuntime, newBrowserSecret, type IdentityRuntime } from '../lib/identity/runtime'
import { ownedIdentityEnabled, hashOwnedSessionToken } from '../lib/identity/owned-session'
import { clearIdentityCookie, consumeIdentityChallenge, identityCookie, identityCookieOptions, trustedIdentityRequest } from '../lib/identity/http-security'

export function createIdentityRouter(dependencies: {
    enabled?: () => boolean; runtime?: () => Promise<IdentityRuntime>; maxAttempts?: number; bodyTimeoutMs?: number
} = {}) {
    const router = Router(), enabled = dependencies.enabled ?? (() => ownedIdentityEnabled(process.env))
    const getRuntime = dependencies.runtime ?? getIdentityRuntime
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store')
        if (!enabled()) return res.status(404).json({ error: 'Not found' })
        next()
    })
    router.use((req, res, next) => {
        const controller = new AbortController()
        req.once('aborted', () => controller.abort())
        res.once('close', () => { if (!res.writableEnded) controller.abort() })
        res.locals.identitySignal = controller.signal
        next()
    })
    router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }))
    router.post(/.*/, rateLimit({ windowMs: 15 * 60 * 1000, max: dependencies.maxAttempts ?? 15,
        standardHeaders: true, legacyHeaders: false, message: { error: 'Too many identity attempts.' } }))
    router.use((req, res, next) => {
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.get('content-type') || '')
            || (req.get('content-encoding') && req.get('content-encoding') !== 'identity')) return res.status(415).json({ error: 'JSON is required.' })
        const length = req.get('content-length')
        if (length && (!/^\d+$/.test(length) || Number(length) > 20_480)) return res.status(413).json({ error: 'Identity request is too large.' })
        const timeout = setTimeout(() => {
            if (!res.headersSent) res.status(408).json({ error: 'Identity request timed out.' })
            req.destroy()
        }, dependencies.bodyTimeoutMs ?? 5_000)
        const clear = () => clearTimeout(timeout)
        req.once('end', clear); req.once('close', clear); res.once('finish', clear)
        next()
    })
    router.use(json({ limit: '20kb', strict: true, inflate: false }))
    router.use(async (req, res, next) => {
        try {
            const cookieName = process.env.NODE_ENV === 'development' ? 'xmail_identity_dev' : '__Host-xmail_identity'
            if (req.method === 'GET' && req.path === '/session' && !identityCookie(req, cookieName)) return res.json({ user: null, authMode: 'owned' })
            const runtime = await getRuntime()
            if (!trustedIdentityRequest(req, runtime.config, req.method !== 'GET')) return res.status(403).json({ error: 'Identity origin is not allowed.' })
            res.locals.identityRuntime = runtime
            next()
        } catch { res.status(503).json({ error: 'Identity service is unavailable.' }) }
    })
    router.get('/config', async (_req, res) => {
        const runtime = res.locals.identityRuntime as IdentityRuntime
        try {
            await runtime.assertReady(res.locals.identitySignal as AbortSignal)
            res.json({ projectId: runtime.config.projectId, apiKey: runtime.config.apiKey, authDomain: runtime.config.authDomain })
        } catch { res.status(503).json({ error: 'Identity service is unavailable.' }) }
    })
    router.get('/challenge', async (req, res) => {
        try {
            const runtime = res.locals.identityRuntime as IdentityRuntime
            const operation = z.enum(['session', 'link', 'existing-account-link', 'logout', 'revoke-all', 'api']).parse(req.query.purpose)
            let target: string = operation
            if (operation === 'api') target = z.string().regex(/^(POST|PUT|PATCH|DELETE) \/api\/[a-zA-Z0-9_/%.-]{1,900}$/).parse(req.query.target)
            const browser = identityCookie(req, runtime.config.browserCookie) || newBrowserSecret()
            const challenge = newBrowserSecret()
            await runtime.store.createChallenge({ challengeHash: hashOwnedSessionToken(challenge), browserHash: hashOwnedSessionToken(browser),
                origin: runtime.config.origin, operation: target, expiresAt: new Date(Date.now() + 5 * 60_000) }, new Date())
            res.cookie(runtime.config.browserCookie, browser, { ...identityCookieOptions(runtime.config), maxAge: 10 * 60_000 })
            res.json({ challenge })
        } catch { res.status(400).json({ error: 'Identity challenge is unavailable.' }) }
    })
    router.get('/session', async (req, res) => {
        const runtime = res.locals.identityRuntime as IdentityRuntime
        try {
            const raw = identityCookie(req, runtime.config.sessionCookie)
            if (!raw) return res.json({ user: null, authMode: 'owned' })
            const principal = await runtime.sessions.authenticate(raw, res.locals.identitySignal as AbortSignal)
            const profile = principal ? await runtime.store.profile(principal.userId) : null
            if (!profile) return res.status(401).json({ error: 'Identity session is unavailable.' })
            res.json({ user: { id: profile.id, email: profile.email, isAdmin: profile.isAdmin, user_metadata: { firstName: profile.firstName, lastName: profile.lastName } }, authMode: 'owned' })
        } catch { res.status(401).json({ error: 'Identity session is unavailable.' }) }
    })
    const providerBody = z.object({ token: z.string().min(1).max(16_384) }).strict()
    router.post('/existing-account-link', async (req, res) => {
        const runtime = res.locals.identityRuntime as IdentityRuntime
        try {
            const body = providerBody.extend({ email: z.string().trim().email().max(320), password: z.string().min(1).max(4096) }).strict().parse(req.body)
            if (!await consumeIdentityChallenge(req, runtime, 'existing-account-link')) return res.status(403).json({ error: 'Identity challenge is invalid or expired.' })
            await runtime.assertReady(res.locals.identitySignal as AbortSignal)
            const old = identityCookie(req, runtime.config.sessionCookie)
            await runtime.linkExistingAccount(body.token, { email: body.email, password: body.password }, old, res.locals.identitySignal as AbortSignal)
            // A separate explicit owned login rechecks provider, binding and
            // local controls. The old provider's session never admits the app.
            return res.json({ linked: true })
        } catch (error) {
            return res.status(error instanceof z.ZodError ? 400 : 401).json({ error: 'Account ownership could not be confirmed. Use reviewed recovery if needed.' })
        }
    })
    for (const action of ['session', 'link', 'logout', 'revoke-all'] as const) {
        router.post(`/${action}`, async (req, res) => {
            const runtime = res.locals.identityRuntime as IdentityRuntime
            try {
                const providerToken = action === 'session' || action === 'link' ? providerBody.parse(req.body).token : undefined
                if (!providerToken) z.object({}).strict().parse(req.body)
                if (!await consumeIdentityChallenge(req, runtime, action)) return res.status(403).json({ error: 'Identity challenge is invalid or expired.' })
                const old = identityCookie(req, runtime.config.sessionCookie)
                if (action === 'logout') {
                    if (old) await runtime.sessions.revoke(old)
                    clearIdentityCookie(res, runtime.config)
                    return res.json({ ok: true })
                }
                if (action === 'revoke-all') {
                    if (!old || !await runtime.revokeAll(old, res.locals.identitySignal as AbortSignal)) return res.status(401).json({ error: 'Recent identity authentication is required.' })
                    clearIdentityCookie(res, runtime.config)
                    return res.json({ ok: true })
                }
                if (!providerToken) return res.status(400).json({ error: 'Invalid identity request.' })
                await runtime.assertReady(res.locals.identitySignal as AbortSignal)
                if (action === 'link') {
                    const authorization = req.get('authorization') || ''
                    await runtime.link(providerToken, { ownedToken: old, legacyToken: authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined }, res.locals.identitySignal as AbortSignal)
                }
                const issued = await runtime.sessions.issue(providerToken, res.locals.identitySignal as AbortSignal)
                if (old) await runtime.sessions.revoke(old)
                res.cookie(runtime.config.sessionCookie, issued.token, { ...identityCookieOptions(runtime.config), expires: issued.expiresAt })
                res.json({ ok: true })
            } catch (error) {
                res.status(error instanceof z.ZodError ? 400 : 401).json({ error: 'Identity authentication failed. Existing accounts require independent ownership proof.' })
            }
        })
    }
    router.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (!res.headersSent) res.status(400).json({ error: 'Invalid identity request.' })
    })
    return router
}
