import { randomBytes } from 'node:crypto'
import { resolveDevelopmentServerAuth } from '../../../lib/development-auth'
import { resolveIdentityConfig, type IdentityConfig } from './config'
import { identityFetch, identityLookupSignal } from './bounded-fetch'
import { createGoogleAccountStatusReader, createGoogleIdentityVerifier, createGoogleSigningKeyResolver, requireActiveGoogleAccount } from './google-provider'
import { createOwnedIdentitySessions, ownedIdentityEnabled } from './owned-session'
import { createPostgresOwnedIdentityStore } from './postgres-store'
import { createIdentityPilotStore, type IdentityPilotStore } from './pilot-store'
import { loadValidatedGoogleAdc } from './google-adc-config'
import { getGoogleX509AccessToken } from './google-x509-access-token'

export interface IdentityRuntime {
    config: IdentityConfig
    sessions: ReturnType<typeof createOwnedIdentitySessions>
    store: IdentityPilotStore
    assertReady(signal?: AbortSignal): Promise<void>
    revokeAll(token: string, signal?: AbortSignal): Promise<boolean>
    link(providerToken: string, proof: { ownedToken?: string; legacyToken?: string }, signal?: AbortSignal): Promise<void>
}

/** Absolute deadline even when an external credential supplier fails to cancel. */
async function bounded<T>(run: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const signal = identityLookupSignal(caller)
    let listener: (() => void) | undefined
    try {
        return await Promise.race([run(signal), new Promise<never>((_, reject) => {
            listener = () => reject(new Error('Identity dependency is unavailable.'))
            if (signal.aborted) listener()
            else signal.addEventListener('abort', listener, { once: true })
        })])
    } finally { if (listener) signal.removeEventListener('abort', listener) }
}

/** Only explicitly selected metadata or renewable external-account file ADC. */
export async function createKeylessAccessTokenSupplier(config: IdentityConfig) {
    if (!['metadata', 'external_account'].includes(config.adcMode)) throw new Error('Keyless Google credentials are not configured.')
    const validated = config.adcMode === 'external_account' ? loadValidatedGoogleAdc(config) : undefined
    if (validated?.kind === 'x509') return async (signal?: AbortSignal) => {
        // Revalidate every read, including renewed files, instead of caching a
        // private key or allowing SDK ambient certificate-config fallbacks.
        const fresh = loadValidatedGoogleAdc(config)
        if (fresh.kind !== 'x509') throw new Error('Keyless Google credentials are not configured.')
        return getGoogleX509AccessToken(fresh.credential, identityLookupSignal(signal))
    }
    const options = { scopes: ['https://www.googleapis.com/auth/identitytoolkit'], transporterOptions: { timeout: 8_000, redirect: 'error' as const, retry: false } }
    const { GoogleAuth, Compute } = await import('google-auth-library')
    let client
    if (config.adcMode === 'metadata') client = new Compute(options)
    else {
        if (validated?.kind !== 'oidc') throw new Error('Keyless Google credentials are not configured.')
        const credentials = validated.credentials
        client = await new GoogleAuth({ ...options, projectId: config.projectId, credentials }).getClient()
    }
    return async (signal?: AbortSignal) => bounded(async abort => {
        if (validated?.kind === 'oidc' && JSON.stringify(loadValidatedGoogleAdc(config)) !== JSON.stringify(validated)) {
            throw new Error('Keyless Google credentials are not configured.')
        }
        client.transporter.defaults = { ...client.transporter.defaults, ...options.transporterOptions, signal: abort }
        const result = await client.getAccessToken()
        if (!result.token) throw new Error('Keyless Google credentials are unavailable.')
        return result.token
    }, signal)
}

/** Read-only API-key provenance check before a browser can create or mutate a provider account. */
export async function verifyGoogleWebProject(config: IdentityConfig, signal?: AbortSignal) {
    const response = await identityFetch('https://identitytoolkit.googleapis.com/v1/projects', {
        signal, headers: { 'X-Goog-Api-Key': config.apiKey, Referer: `${config.origin}/` },
    })
    if (!response.ok) throw new Error('Google web project is unavailable.')
    const data: unknown = await response.json()
    if (!data || typeof data !== 'object' || !('projectId' in data) || typeof data.projectId !== 'string'
        || ![config.projectId, config.projectNumber].includes(data.projectId)
        || !('authorizedDomains' in data) || !Array.isArray(data.authorizedDomains)
        || !data.authorizedDomains.includes(config.authDomain) || !data.authorizedDomains.includes(new URL(config.origin).hostname)) {
        throw new Error('Google web project does not match the approved identity project.')
    }
}

/** Fresh legacy bearer proof, deliberately uncached and exact-UID only. */
export async function verifyLegacyIdentity(token: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string> {
    if (!token || token.length > 16_384) throw new Error('Existing account proof is invalid.')
    const auth = env.NODE_ENV === 'development' ? resolveDevelopmentServerAuth(env)
        : { url: env.SUPABASE_URL || '', anonKey: env.SUPABASE_ANON_KEY || '' }
    try {
        const response = await identityFetch(new URL('/auth/v1/user', auth.url), {
            headers: { apikey: auth.anonKey, Authorization: `Bearer ${token}` }, signal,
        })
        if (!response.ok) throw new Error('Proof failed')
        const user = await response.json() as Record<string, any>
        if (typeof user.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(user.id) || user.app_metadata?.xmail_disabled === true
            || (user.banned_until && (!Number.isFinite(Date.parse(user.banned_until)) || Date.parse(user.banned_until) > Date.now()))) throw new Error('Proof failed')
        return user.id
    } catch { throw new Error('Existing account proof is unavailable.') }
}

let runtime: Promise<IdentityRuntime> | undefined
export function getIdentityRuntime(): Promise<IdentityRuntime> {
    if (!ownedIdentityEnabled(process.env)) return Promise.reject(new Error('Owned identity pilot is not enabled.'))
    runtime ??= (async (): Promise<IdentityRuntime> => {
        const config = resolveIdentityConfig(process.env)!
        let credential: ReturnType<typeof createKeylessAccessTokenSupplier> | undefined
        const token = async (signal?: AbortSignal) => {
            credential ??= createKeylessAccessTokenSupplier(config).catch(() => { credential = undefined; throw new Error('Keyless Google credentials are unavailable.') })
            return (await credential)(signal)
        }
        const { queryClient } = await import('../../../db')
        const ownedStore = createPostgresOwnedIdentityStore(queryClient)
        const store = createIdentityPilotStore(queryClient)
        const verify = createGoogleIdentityVerifier(config.projectId, createGoogleSigningKeyResolver(identityFetch))
        const status = createGoogleAccountStatusReader(config.projectId, token, identityFetch)
        const sessions = createOwnedIdentitySessions({ enabled: () => ownedIdentityEnabled(process.env), verifyIdentity: verify, readProviderStatus: status, store: ownedStore })
        return {
            config, sessions, store,
            async assertReady(signal) {
                await token(signal)
                await verifyGoogleWebProject(config, signal)
            },
            async revokeAll(raw, signal) {
                const principal = await sessions.authenticate(raw, signal)
                if (!principal || Date.now() / 1000 - principal.authenticatedAt > 300) return false
                await ownedStore.revokeUserSessions(principal.userId, new Date())
                return true
            },
            async link(providerToken, proof, signal) {
                const identity = await verify(providerToken, signal)
                if (Date.now() / 1000 - identity.authenticatedAt > 300) throw new Error('Recent authentication is required.')
                requireActiveGoogleAccount(identity, await status(identity, signal))
                let userId: string, proofSource: 'owned-session' | 'legacy-session'
                if (proof.ownedToken) {
                    const principal = await sessions.authenticate(proof.ownedToken, signal)
                    if (!principal || Date.now() / 1000 - principal.authenticatedAt > 300) throw new Error('Recent account proof is required.')
                    userId = principal.userId; proofSource = 'owned-session'
                } else {
                    userId = await verifyLegacyIdentity(proof.legacyToken || '', process.env, signal); proofSource = 'legacy-session'
                }
                signal?.throwIfAborted()
                if (!await store.profile(userId) || !await store.linkExisting(identity, userId, proofSource, new Date())) throw new Error('Independent account ownership could not be established.')
            },
        }
    })().catch(() => { runtime = undefined; throw new Error('Identity service is unavailable.') })
    return runtime
}

export const newBrowserSecret = () => randomBytes(32).toString('base64url')

export async function syncOwnedUserStatus(userId: string, disabled: boolean) {
    if (!ownedIdentityEnabled(process.env)) return
    await (await getIdentityRuntime()).store.setDisabled(userId, disabled, new Date())
}
