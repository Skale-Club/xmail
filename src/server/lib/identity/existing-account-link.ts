import type { GoogleIdentity, GoogleAccountStatus } from './google-provider'
import { requireActiveGoogleAccount } from './google-provider'
import type { IdentityPilotStore } from './pilot-store'
import type { createOwnedIdentitySessions } from './owned-session'

/** Linking never creates a user, grants a role or creates an application session. */
export function createExistingAccountLinker(dependencies: {
    verify(token: string, signal?: AbortSignal): Promise<GoogleIdentity>
    status(identity: Pick<GoogleIdentity, 'projectId' | 'subject'>, signal?: AbortSignal): Promise<GoogleAccountStatus>
    passwordProof(email: string, password: string, signal?: AbortSignal): Promise<{ id: string } | null>
    sessions: Pick<ReturnType<typeof createOwnedIdentitySessions>, 'authenticate'>
    store: Pick<IdentityPilotStore, 'profile' | 'linkExisting'>
    clock?: () => number
}) {
    return async (token: string, credentials: { email: string; password: string }, ownedToken?: string, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        const identity = await dependencies.verify(token, signal)
        const now = (dependencies.clock ?? Date.now)(), age = now / 1000 - identity.authenticatedAt
        if (!Number.isSafeInteger(identity.authenticatedAt) || age < -5 || age > 300) throw new Error('Recent verified authentication is required.')
        requireActiveGoogleAccount(identity, await dependencies.status(identity, signal))
        const owner = await dependencies.passwordProof(credentials.email, credentials.password, signal)
        if (!owner) throw new Error('Existing account proof is unavailable.')
        if (ownedToken) {
            const current = await dependencies.sessions.authenticate(ownedToken, signal)
            if (!current || current.userId !== owner.id) throw new Error('Sign out before linking another existing account.')
        }
        signal?.throwIfAborted()
        const profile = await dependencies.store.profile(owner.id)
        if (!profile || profile.id !== owner.id || !await dependencies.store.linkExisting(identity, owner.id, 'legacy-password', new Date(now))) {
            throw new Error('Independent account ownership could not be established.')
        }
    }
}
