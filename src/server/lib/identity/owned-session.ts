import { createHash, randomBytes } from 'node:crypto'
import { requireActiveGoogleAccount, type GoogleAccountStatus, type GoogleIdentity } from './google-provider'

export const OWNED_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000
export const OWNED_SESSION_COOKIE = '__Host-xmail_identity'

export interface IdentityBinding {
    id: string
    userId: string
    projectId: string
    subject: string
    disabledAt: Date | null
}
export interface UserIdentityControl {
    disabledAt: Date | null
    sessionsValidAfter: Date
}
export interface OwnedSession {
    tokenHash: string
    bindingId: string
    authenticatedAt: number
    createdAt: Date
    expiresAt: Date
    revokedAt: Date | null
}
type Admission = { binding: IdentityBinding; control: UserIdentityControl }
type SessionAdmission = Admission & { session: OwnedSession }

/** Implementations must join an existing user and reviewed local control record. */
export interface OwnedIdentityStore {
    findBinding(projectId: string, subject: string): Promise<Admission | null>
    // Atomic admission: lock/recheck this binding and control against revocation
    // inside the insertion transaction. Returning false must persist no session.
    insertSessionIfActive(session: OwnedSession, binding: IdentityBinding): Promise<boolean>
    findSession(tokenHash: string): Promise<(Admission & { session: OwnedSession }) | null>
    revokeSession(tokenHash: string, now: Date): Promise<void>
    // Must atomically advance sessionsValidAfter and revoke existing sessions.
    revokeUserSessions(userId: string, now: Date): Promise<void>
}

export function ownedIdentityEnabled(env: Record<string, string | undefined>): boolean {
    return env.XMAIL_GOOGLE_AUTH_ENABLED === 'true' && !env.FIREBASE_AUTH_EMULATOR_HOST
}

export function hashOwnedSessionToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

function activeLocal(admission: Admission, authenticatedAt: number): boolean {
    const cutoff = admission.control.sessionsValidAfter.getTime()
    return !admission.binding.disabledAt && !admission.control.disabledAt
        && Number.isFinite(cutoff) && authenticatedAt * 1000 >= cutoff
}

function activeSession(admission: SessionAdmission, tokenHash: string, now: number): boolean {
    const { binding, session } = admission
    const created = session.createdAt.getTime(), expires = session.expiresAt.getTime()
    return session.tokenHash === tokenHash && session.bindingId === binding.id
        && !session.revokedAt && Number.isFinite(created) && Number.isFinite(expires)
        && created <= now + 5_000 && expires > now && expires > created
        && expires - created <= OWNED_SESSION_LIFETIME_MS && Number.isSafeInteger(session.authenticatedAt)
        && session.authenticatedAt > 0 && session.authenticatedAt * 1000 <= created + 5_000
        && activeLocal(admission, session.authenticatedAt)
}

/** No contact lookup, account creation, role grant or provider token persistence. */
export function createOwnedIdentitySessions(dependencies: {
    enabled: () => boolean
    verifyIdentity: (token: string) => Promise<GoogleIdentity>
    readProviderStatus: (identity: Pick<GoogleIdentity, 'projectId' | 'subject'>) => Promise<GoogleAccountStatus>
    store: OwnedIdentityStore
    clock?: () => number
}) {
    const clock = dependencies.clock ?? Date.now
    function requireEnabled() {
        if (!dependencies.enabled()) throw new Error('Owned identity pilot is not enabled.')
    }
    return {
        async issue(providerToken: string) {
            requireEnabled()
            try {
                const identity = await dependencies.verifyIdentity(providerToken)
                const now = clock()
                const age = now / 1000 - identity.authenticatedAt
                if (age < -5 || age > 300) throw new Error('Recent provider authentication is required.')
                requireActiveGoogleAccount(identity, await dependencies.readProviderStatus(identity))
                const admission = await dependencies.store.findBinding(identity.projectId, identity.subject)
                if (!admission || admission.binding.projectId !== identity.projectId
                    || admission.binding.subject !== identity.subject || !activeLocal(admission, identity.authenticatedAt)) {
                    throw new Error('An independently verified existing Xmail account is required.')
                }
                const token = randomBytes(32).toString('base64url')
                const expiresAt = new Date(now + OWNED_SESSION_LIFETIME_MS)
                const session: OwnedSession = {
                    tokenHash: hashOwnedSessionToken(token), bindingId: admission.binding.id,
                    authenticatedAt: identity.authenticatedAt, createdAt: new Date(now), expiresAt, revokedAt: null,
                }
                if (!await dependencies.store.insertSessionIfActive(session, admission.binding)) {
                    throw new Error('Local identity admission changed.')
                }
                return { token, expiresAt, userId: admission.binding.userId }
            } catch {
                throw new Error('Owned identity authentication failed.')
            }
        },
        async authenticate(token: string) {
            requireEnabled()
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
            try {
                const tokenHash = hashOwnedSessionToken(token)
                const admission = await dependencies.store.findSession(tokenHash)
                if (!admission || !activeSession(admission, tokenHash, clock())) return null
                const { binding, session } = admission
                requireActiveGoogleAccount({ authenticatedAt: session.authenticatedAt }, await dependencies.readProviderStatus(binding))
                // A provider round-trip can outlast a concurrent local revocation.
                // Re-read local admission before exposing the trusted principal.
                const latest = await dependencies.store.findSession(tokenHash)
                if (!latest || !activeSession(latest, tokenHash, clock()) || latest.binding.id !== binding.id
                    || latest.binding.userId !== binding.userId || latest.binding.projectId !== binding.projectId
                    || latest.binding.subject !== binding.subject || latest.session.authenticatedAt !== session.authenticatedAt) return null
                return { userId: binding.userId, sessionHash: session.tokenHash, authenticatedAt: session.authenticatedAt }
            } catch {
                return null
            }
        },
        async revoke(token: string) {
            requireEnabled()
            if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
                await dependencies.store.revokeSession(hashOwnedSessionToken(token), new Date(clock()))
            }
        },
    }
}
