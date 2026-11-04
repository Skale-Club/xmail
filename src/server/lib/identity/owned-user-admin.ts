import type { RequestHandler } from 'express'
import { z } from 'zod'

export interface OwnedAdminPrincipal { userId: string; sessionHash: string; authenticatedAt: number }
export class OwnedAdminError extends Error {
    constructor(public status: number, message: string) { super(message) }
}
const uuid = z.string().uuid()
const nativePassword = z.string().min(8).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Native passwords must fit the bcrypt byte limit.')
export const ownedCreateUserSchema = z.object({
    email: z.string().email().transform(value => value.toLowerCase()),
    password: nativePassword.optional(),
    firstName: z.string().max(200).optional(), lastName: z.string().max(200).optional(),
    isAdmin: z.boolean().default(false), sendInvite: z.boolean().default(true),
    organizationId: uuid.optional(), organizationRole: z.enum(['admin', 'member', 'viewer']).default('member'),
}).strict()
export type OwnedCreateUser = z.infer<typeof ownedCreateUserSchema>
export const ownedUpdateUserSchema = z.object({
    firstName: z.string().max(200).optional(), lastName: z.string().max(200).optional(),
    isAdmin: z.boolean().optional(), emailVerified: z.boolean().optional(),
}).strict()
export type OwnedUpdateUser = z.infer<typeof ownedUpdateUserSchema>
export interface OwnedAdminStore {
    list(principal: OwnedAdminPrincipal): Promise<unknown[]>
    create(principal: OwnedAdminPrincipal, input: OwnedCreateUser): Promise<unknown>
    update(principal: OwnedAdminPrincipal, id: string, input: OwnedUpdateUser): Promise<unknown>
    setActive(principal: OwnedAdminPrincipal, id: string, active: boolean): Promise<unknown>
    resetNativePassword(principal: OwnedAdminPrincipal, id: string, password: string): Promise<void>
}

/** The pilot does not select administrative authority implicitly. */
export function userAdminAuthority(env: Record<string, string | undefined>): 'legacy' | 'owned' | 'unavailable' {
    const value = env.XMAIL_USER_ADMIN_AUTHORITY
    if (value !== undefined && value !== 'legacy' && value !== 'owned') return 'unavailable'
    if (value === 'owned') return env.XMAIL_GOOGLE_AUTH_ENABLED === 'true' && !env.FIREBASE_AUTH_EMULATOR_HOST ? 'owned' : 'unavailable'
    if (value === 'legacy') return 'legacy'
    return env.XMAIL_GOOGLE_AUTH_ENABLED === 'true' ? 'unavailable' : 'legacy'
}

export function managedUserAdminPath(method: string, path: string): boolean {
    return (path === '/' && ['GET', 'POST'].includes(method))
        || (path === '/me/change-password' && method === 'POST')
        || (/^\/[^/]+$/.test(path) && !['/profile', '/organizations'].includes(path) && ['PATCH', 'DELETE'].includes(method))
        || (/^\/[^/]+\/(activate|deactivate|resend-invite)$/.test(path) && method === 'POST')
        || (/^\/[^/]+\/password$/.test(path) && method === 'PUT')
}

/** Terminal owned branch: neither errors nor unsupported operations reach legacy handlers. */
export function createOwnedUserAdminAdmission(dependencies: {
    env: () => Record<string, string | undefined>
    store: () => Promise<OwnedAdminStore>
    clock?: () => number
}): RequestHandler {
    return async (req, res, next) => {
        if (!managedUserAdminPath(req.method, req.path)) return next()
        const authority = userAdminAuthority(dependencies.env())
        if (authority === 'legacy' && res.locals.xmailOwnedIdentity !== true) return next()
        if (authority !== 'owned') return void res.status(409).json({ error: 'Select the user administration authority explicitly before using owned identity.' })
        const principal: OwnedAdminPrincipal | undefined = res.locals.xmailOwnedIdentity === true ? res.locals.xmailOwnedPrincipal : undefined
        const now = (dependencies.clock ?? Date.now)() / 1000
        if (!principal || !uuid.safeParse(principal.userId).success || !/^[a-f0-9]{64}$/.test(principal.sessionHash)
            || !Number.isSafeInteger(principal.authenticatedAt) || now - principal.authenticatedAt > 300 || now - principal.authenticatedAt < -5) {
            return void res.status(401).json({ error: 'Recent owned authentication is required.' })
        }
        try {
            // No password reset email, hosted-account deletion or provider binding is
            // inferred from a local profile/contact. These require separate reviewed flows.
            if (req.method === 'DELETE' || req.path.endsWith('/resend-invite') || req.path === '/me/change-password') {
                return void res.status(409).json({ error: 'This action is unavailable under owned administration; an explicit owned recovery or deletion flow is required.', code: 'OWNED_ACTION_UNAVAILABLE' })
            }
            if (req.path === '/' && req.method === 'POST') {
                const input = ownedCreateUserSchema.parse(req.body)
                if (input.sendInvite) throw new OwnedAdminError(409, 'Owned invitations are unavailable. No invitation has been sent.')
                if (!input.isAdmin && !input.password) throw new OwnedAdminError(400, 'A native mailbox password is required for a new mailbox.')
                const user = await (await dependencies.store()).create(principal, input)
                return void res.status(201).json({ user, inviteSent: false, identityLinkRequired: true, message: 'Local account created. Browser identity requires an independent reviewed link.' })
            }
            const store = await dependencies.store()
            if (req.path === '/') return void res.json({ users: await store.list(principal) })
            const id = uuid.parse(req.path.split('/')[1])
            if (req.method === 'PATCH') return void res.json({ user: await store.update(principal, id, ownedUpdateUserSchema.parse(req.body)) })
            if (req.path.endsWith('/password')) {
                const { password } = z.object({ password: nativePassword }).strict().parse(req.body)
                await store.resetNativePassword(principal, id, password)
                return void res.json({ success: true, nativePasswordUpdated: true, browserIdentityChanged: false })
            }
            return void res.json({ user: await store.setActive(principal, id, req.path.endsWith('/activate')) })
        } catch (error) {
            if (error instanceof z.ZodError) return void res.status(400).json({ error: 'Invalid user administration input.' })
            if (error instanceof OwnedAdminError) return void res.status(error.status).json({ error: error.message })
            // SQL statements and credentials must not appear in logs or responses.
            return void res.status(503).json({ error: 'Owned user administration is unavailable. No legacy fallback was attempted.' })
        }
    }
}
