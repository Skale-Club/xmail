import { currentBrowserAuthAuthority, legacyBrowserAuthConfirmed, lockLegacyBrowserAuth, resolveBrowserAuthAuthority } from './browser-auth-authority'
import { getActiveSessionId, getStoredSessions } from './session-store'

export interface OwnedIdentityUser { id: string; email: string; isAdmin: boolean; user_metadata?: { firstName?: string | null; lastName?: string | null } }
export interface FirebaseIdentityConfig { projectId: string; apiKey: string; authDomain: string }
const modeKey = 'xmail-prefer-owned-identity'
if (typeof window !== 'undefined' && window.sessionStorage.getItem(modeKey) === 'true') lockLegacyBrowserAuth()
let active = false
let probe: Promise<{ kind: 'active' | 'none' | 'disabled' | 'expired' | 'unavailable'; user?: OwnedIdentityUser }> | undefined
export function ownedIdentityActive() {
    return currentBrowserAuthAuthority() === 'owned' || active || (typeof window !== 'undefined' && window.sessionStorage.getItem(modeKey) === 'true')
}
export function preferOwnedIdentity() {
    lockLegacyBrowserAuth()
    active = true
    window.sessionStorage.setItem(modeKey, 'true') // Preference only; never a credential or provider session.
}
async function request(path: string, init: RequestInit = {}) {
    return fetch(`/api/auth/identity/${path}`, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
}
export function probeOwnedIdentitySession() {
    probe ??= (async () => {
        try {
            const authority = await resolveBrowserAuthAuthority()
            const response = await request('session')
            if (response.status === 404) {
                if (authority === 'owned') { preferOwnedIdentity(); return { kind: 'expired' as const } }
                active = false; window.sessionStorage.removeItem(modeKey)
                return { kind: 'disabled' as const }
            }
            if (!response.ok) { preferOwnedIdentity(); return { kind: 'expired' as const } }
            const body = await response.json() as { user: OwnedIdentityUser | null }
            if (body.user) { preferOwnedIdentity(); return { kind: 'active' as const, user: body.user } }
            return { kind: ownedIdentityActive() ? 'expired' as const : 'none' as const }
        } catch { return { kind: 'unavailable' as const } }
    })()
    return probe
}
export async function ownedMutationHeaders(method: string, path: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!ownedIdentityActive() || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return {}
    const url = new URL(path, window.location.origin)
    if (url.origin !== window.location.origin) throw new Error('Identity requests must use this origin.')
    const response = await request(`challenge?purpose=api&target=${encodeURIComponent(`${method.toUpperCase()} ${url.pathname}`)}`, { signal })
    if (!response.ok) throw new Error('Identity confirmation is unavailable.')
    return { 'X-Xmail-CSRF': (await response.json() as { challenge: string }).challenge }
}
export async function ownedIdentityAction(action: 'session' | 'link' | 'logout' | 'revoke-all', token?: string, legacyToken?: string) {
    const challengeResponse = await request(`challenge?purpose=${action}`)
    if (!challengeResponse.ok) throw new Error('Identity confirmation is unavailable.')
    const { challenge } = await challengeResponse.json() as { challenge: string }
    const response = await request(action, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Xmail-CSRF': challenge, ...(legacyToken ? { Authorization: `Bearer ${legacyToken}` } : {}) },
        body: JSON.stringify(token ? { token } : {}),
    })
    if (!response.ok) throw new Error(action === 'link'
        ? 'Account ownership could not be confirmed. Contact support for reviewed recovery.'
        : 'Sign-in could not be confirmed. Please try again.')
    preferOwnedIdentity()
    probe = undefined
}

/** User-initiated linking only. Credentials stay in this request and never enter
 * the SDK, app session store, URL, returned response or legacy sign-in flow. */
export async function linkExistingIdentityAccount(token: string, email: string, password: string) {
    const challengeResponse = await request('challenge?purpose=existing-account-link')
    if (!challengeResponse.ok) throw new Error('Account confirmation is unavailable.')
    const { challenge } = await challengeResponse.json() as { challenge: string }
    const response = await request('existing-account-link', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Xmail-CSRF': challenge },
        body: JSON.stringify({ token, email, password }),
    })
    if (!response.ok || (await response.json() as { linked?: unknown }).linked !== true) {
        throw new Error('Account ownership could not be confirmed. Use reviewed recovery if needed.')
    }
    probe = undefined
}
export async function loadFirebaseIdentityConfig(): Promise<FirebaseIdentityConfig> {
    await resolveBrowserAuthAuthority()
    const response = await request('config')
    if (!response.ok) throw new Error('Verified sign-in is not available yet. Contact support for reviewed recovery.')
    return response.json() as Promise<FirebaseIdentityConfig>
}
export async function leaveOwnedIdentity() {
    await ownedIdentityAction('logout')
    active = false; probe = undefined
    window.sessionStorage.removeItem(modeKey)
    window.location.href = currentBrowserAuthAuthority() === 'owned' ? '/auth/identity' : '/login'
}
export async function signOutOfXmail() {
    await resolveBrowserAuthAuthority({ force: true })
    const owned = ownedIdentityActive()
    if (owned) { await ownedIdentityAction('logout'); return true }
    if (!legacyBrowserAuthConfirmed()) throw new Error('Sign-in status is unavailable.')
    const { supabase } = await import('./supabase')
    await supabase.auth.signOut()
    return owned
}

/** Used only by the explicit first-link action; the server independently verifies
 * this existing token online and selects its exact UUID. No refresh or SDK login. */
export function storedLegacyFirstLinkToken(): string | undefined {
    const activeId = getActiveSessionId()
    const stored: unknown = getStoredSessions()
    if (!activeId || !Array.isArray(stored)) return undefined
    const matches = stored.filter(row => row && typeof row === 'object' && row.userId === activeId)
    const token = matches.length === 1 ? matches[0].accessToken : undefined
    return typeof token === 'string' && token.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : undefined
}
