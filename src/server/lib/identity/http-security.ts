import type { Request, Response } from 'express'
import type { IdentityConfig } from './config'
import { hashOwnedSessionToken } from './owned-session'
import type { IdentityRuntime } from './runtime'

export function identityCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
    const matches = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`))
    if (matches.length > 1) throw new Error('Invalid identity cookie.')
    const value = matches[0]?.slice(name.length + 1)
    if (value !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid identity cookie.')
    return value
}
export function identityCookieOptions(config: IdentityConfig) {
    return { httpOnly: true, secure: config.secure, sameSite: 'strict' as const, path: '/' }
}
export function trustedIdentityRequest(req: Request, config: IdentityConfig, mutation = false): boolean {
    if (req.get('host') !== new URL(config.origin).host || req.get('sec-fetch-site') === 'cross-site') return false
    return !mutation || req.get('origin') === config.origin
}
export async function consumeIdentityChallenge(req: Request, runtime: IdentityRuntime, operation: string): Promise<boolean> {
    if (!trustedIdentityRequest(req, runtime.config, true)) return false
    const challenge = req.get('x-xmail-csrf'), browser = identityCookie(req, runtime.config.browserCookie)
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !browser) return false
    return runtime.store.consumeChallenge({ challengeHash: hashOwnedSessionToken(challenge), browserHash: hashOwnedSessionToken(browser), origin: runtime.config.origin, operation }, new Date())
}
export function clearIdentityCookie(res: Response, config: IdentityConfig) {
    res.clearCookie(config.sessionCookie, identityCookieOptions(config))
}
