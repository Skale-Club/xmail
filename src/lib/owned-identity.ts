export interface OwnedIdentityUser { id: string; email: string; isAdmin: boolean; user_metadata?: { firstName?: string | null; lastName?: string | null } }
export interface FirebaseIdentityConfig { projectId: string; apiKey: string; authDomain: string }
const modeKey = 'xmail-prefer-owned-identity'
let active = false
let probe: Promise<{ kind: 'active' | 'none' | 'disabled' | 'expired'; user?: OwnedIdentityUser }> | undefined
export function ownedIdentityActive() {
    return active || (typeof window !== 'undefined' && window.sessionStorage.getItem(modeKey) === 'true')
}
export function preferOwnedIdentity() {
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
            const response = await request('session')
            if (response.status === 404) {
                active = false; window.sessionStorage.removeItem(modeKey)
                return { kind: 'disabled' as const }
            }
            if (!response.ok) { preferOwnedIdentity(); return { kind: 'expired' as const } }
            const body = await response.json() as { user: OwnedIdentityUser | null }
            if (body.user) { preferOwnedIdentity(); return { kind: 'active' as const, user: body.user } }
            return { kind: ownedIdentityActive() ? 'expired' as const : 'none' as const }
        } catch { return { kind: ownedIdentityActive() ? 'expired' as const : 'none' as const } }
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
        : 'Sign-in could not be confirmed. Existing accounts need to be linked first.')
    preferOwnedIdentity()
    probe = undefined
}
export async function loadFirebaseIdentityConfig(): Promise<FirebaseIdentityConfig> {
    const response = await request('config')
    if (!response.ok) throw new Error('Verified sign-in is not available yet. Use the current sign-in page.')
    return response.json() as Promise<FirebaseIdentityConfig>
}
export async function leaveOwnedIdentity() {
    await ownedIdentityAction('logout')
    active = false; probe = undefined
    window.sessionStorage.removeItem(modeKey)
    window.location.href = '/login'
}
export async function signOutOfXmail() {
    const owned = ownedIdentityActive()
    if (owned) await ownedIdentityAction('logout')
    const { supabase } = await import('./supabase')
    if (owned) await supabase.auth.signOut({ scope: 'local' })
    else await supabase.auth.signOut()
    return owned
}
