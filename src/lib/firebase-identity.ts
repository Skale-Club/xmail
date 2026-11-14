import { initializeApp, getApps } from 'firebase/app'
import { initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, RecaptchaVerifier, signInWithPhoneNumber, signInWithPopup, signOut, type Auth } from 'firebase/auth'
import type { FirebaseIdentityConfig } from './owned-identity'

let auth: Auth | undefined
let selectedProject = ''
function memoryAuth(config: FirebaseIdentityConfig) {
    const identity = JSON.stringify(config)
    if (auth && identity !== selectedProject) throw new Error('Identity configuration changed. Reload the page.')
    if (!auth) {
        const app = getApps().find(app => app.name === 'xmail-identity-pilot') || initializeApp(config, 'xmail-identity-pilot')
        auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver })
        selectedProject = identity
    }
    return auth
}
export async function googleIdentityToken(config: FirebaseIdentityConfig) {
    const client = memoryAuth(config)
    const provider = new GoogleAuthProvider()
    provider.setCustomParameters({ prompt: 'select_account' })
    try { return await (await signInWithPopup(client, provider)).user.getIdToken(true) }
    catch (failure) { throw identityError(failure) }
    finally { await signOut(client) }
}

function identityError(failure: unknown, phone = false) {
    const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined
    switch (code) {
        case 'auth/invalid-verification-code': return new Error('That code is incorrect. Check the SMS and try again.')
        case 'auth/code-expired':
        case 'auth/session-expired': return new Error('That code has expired. Request a new code.')
        case 'auth/too-many-requests': return new Error('Too many attempts. Wait a few minutes and try again.')
        case 'auth/network-request-failed': return new Error('Check your connection and try again.')
        case 'auth/popup-blocked': return new Error('Allow pop-ups for Xmail, then try Google again.')
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request': return new Error('Google sign-in was closed. Try again to continue.')
        default: return new Error(phone ? 'SMS verification could not be completed. Check the number and try again.' : 'Google sign-in could not be completed. Please try again.')
    }
}

export async function beginPhoneIdentity(config: FirebaseIdentityConfig, phone: string, captcha: HTMLElement) {
    const client = memoryAuth(config)
    const verifier = new RecaptchaVerifier(client, captcha, { size: 'invisible' })
    let cleared = false
    const clear = () => { if (!cleared) { cleared = true; verifier.clear() } }
    try {
        const confirmation = await signInWithPhoneNumber(client, phone, verifier)
        // The CAPTCHA protects sending, and has no role in entering the SMS code.
        clear()
        let disposed = false
        let verifiedUser: Awaited<ReturnType<typeof confirmation.confirm>>['user'] | undefined
        let token: string | undefined
        return {
            async confirm(code: string, currentConfig: FirebaseIdentityConfig) {
                if (disposed) throw new Error('Request a new verification code.')
                if (memoryAuth(currentConfig) !== client) throw new Error('Identity configuration changed. Reload the page.')
                if (token) return token
                try {
                    // A server retry must not consume a successfully verified code twice.
                    verifiedUser ??= (await confirmation.confirm(code)).user
                    if (disposed) throw new Error('Request a new verification code.')
                    const proof = await verifiedUser.getIdToken(true)
                    if (disposed) throw new Error('Request a new verification code.')
                    token = proof
                    return token
                } catch (failure) { throw identityError(failure, true) }
                finally { await signOut(client) }
            },
            dispose() { disposed = true; token = undefined; verifiedUser = undefined; clear(); void signOut(client) },
        }
    } catch (failure) { clear(); await signOut(client); throw identityError(failure, true) }
}
