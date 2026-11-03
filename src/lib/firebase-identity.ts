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
    finally { await signOut(client) }
}
export async function beginPhoneIdentity(config: FirebaseIdentityConfig, phone: string, captcha: HTMLElement) {
    const client = memoryAuth(config)
    const verifier = new RecaptchaVerifier(client, captcha, { size: 'normal' })
    try {
        const confirmation = await signInWithPhoneNumber(client, phone, verifier)
        return {
            async confirm(code: string, currentConfig: FirebaseIdentityConfig) {
                if (memoryAuth(currentConfig) !== client) throw new Error('Identity configuration changed. Reload the page.')
                try { return await (await confirmation.confirm(code)).user.getIdToken(true) }
                finally { verifier.clear(); await signOut(client) }
            },
            dispose() { verifier.clear(); void signOut(client) },
        }
    } catch { verifier.clear(); await signOut(client); throw new Error('SMS could not be sent. Check the number and try again.') }
}
