import jwt, { type Secret } from 'jsonwebtoken'
import { identityLookupSignal } from './bounded-fetch'

export const GOOGLE_CERTIFICATES_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
export type GoogleIdentity = {
    projectId: string
    subject: string
    provider: 'google.com' | 'phone'
    providerSubject: string
    authenticatedAt: number
}
export type GoogleAccountStatus = { disabled: boolean; validSince: number }
type Fetch = typeof globalThis.fetch

function validProject(projectId: string): boolean {
    return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidIdentity(): never {
    throw new Error('Invalid Google identity.')
}

/** Fixed Google endpoint, bounded cache, no fallback to stale keys after failure. */
export function createGoogleSigningKeyResolver(fetcher: Fetch = globalThis.fetch, clock = Date.now) {
    let certificates: Record<string, string> = {}
    let expiresAt = 0
    let pending: Promise<void> | undefined
    return async (kid: string, caller?: AbortSignal): Promise<Secret> => {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(kid)) invalidIdentity()
        if (clock() >= expiresAt || !Object.prototype.hasOwnProperty.call(certificates, kid)) {
            pending ??= (async () => {
                try {
                    const response = await fetcher(GOOGLE_CERTIFICATES_URL, {
                        redirect: 'error', signal: identityLookupSignal(caller),
                    })
                    if (!response.ok) invalidIdentity()
                    const body: unknown = await response.json()
                    if (!record(body) || !Object.keys(body).length || Object.keys(body).length > 20
                        || Object.entries(body).some(([key, value]) => !/^[a-zA-Z0-9_-]{1,128}$/.test(key)
                            || typeof value !== 'string' || value.length > 16_384)) invalidIdentity()
                    certificates = body as Record<string, string>
                    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '')
                    expiresAt = clock() + Math.min(Number(maxAge?.[1] ?? 300), 3600) * 1000
                } catch {
                    expiresAt = 0
                    throw new Error('Google signing keys are unavailable.')
                }
            })()
            try { await pending } finally { pending = undefined }
        }
        if (!Object.prototype.hasOwnProperty.call(certificates, kid)) invalidIdentity()
        return certificates[kid]
    }
}

/** Cryptographic verification uses the installed JWT library, not decoded profile fields. */
export function createGoogleIdentityVerifier(
    projectId: string,
    resolveKey: (kid: string, signal?: AbortSignal) => Promise<Secret> = createGoogleSigningKeyResolver(),
    clock = Date.now,
) {
    if (!validProject(projectId)) throw new Error('Invalid Google identity project.')
    return async (token: string, signal?: AbortSignal): Promise<GoogleIdentity> => {
        try {
            if (typeof token !== 'string' || !token || token.length > 16_384) invalidIdentity()
            const decoded = jwt.decode(token, { complete: true })
            if (!decoded || decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string'
                || !/^[a-zA-Z0-9_-]{1,128}$/.test(decoded.header.kid)
                || decoded.header.crit !== undefined) invalidIdentity()
            const now = Math.floor(clock() / 1000)
            const payload = jwt.verify(token, await resolveKey(decoded.header.kid, signal), {
                algorithms: ['RS256'], audience: projectId, issuer: `https://securetoken.google.com/${projectId}`,
                clockTimestamp: now, clockTolerance: 5, maxAge: '65m',
            })
            if (!record(payload) || typeof payload.sub !== 'string' || !payload.sub
                || payload.sub.length > 128 || payload.sub.trim() !== payload.sub || payload.aud !== projectId
                || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
                || !Number.isSafeInteger(payload.auth_time)) invalidIdentity()
            const issuedAt = payload.iat as number, expires = payload.exp as number, authTime = payload.auth_time as number
            if (issuedAt <= 0 || issuedAt > now + 5 || authTime <= 0 || authTime > now + 5
                || authTime > issuedAt + 5 || expires <= issuedAt || expires - issuedAt > 3900) invalidIdentity()
            const firebase = payload.firebase
            if (!record(firebase) || firebase.tenant !== undefined) invalidIdentity()
            const provider = firebase.sign_in_provider
            let providerSubject: string
            if (provider === 'phone') {
                if (typeof payload.phone_number !== 'string' || !/^\+[1-9]\d{7,14}$/.test(payload.phone_number)) invalidIdentity()
                providerSubject = payload.phone_number
            } else if (provider === 'google.com') {
                const ids = record(firebase.identities) ? firebase.identities['google.com'] : undefined
                if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || !ids[0]
                    || ids[0].length > 255 || ids[0].trim() !== ids[0]) invalidIdentity()
                providerSubject = ids[0]
            } else invalidIdentity()
            return { projectId, subject: payload.sub, provider, providerSubject, authenticatedAt: authTime }
        } catch {
            invalidIdentity()
        }
    }
}

/** The caller supplies a short-lived scoped ADC/federation token; no JSON key or env token fallback. */
export function createGoogleAccountStatusReader(
    projectId: string,
    getAccessToken: (signal?: AbortSignal) => Promise<string>,
    fetcher: Fetch = globalThis.fetch,
) {
    if (!validProject(projectId)) throw new Error('Invalid Google identity project.')
    return async (identity: Pick<GoogleIdentity, 'projectId' | 'subject'>, signal?: AbortSignal): Promise<GoogleAccountStatus> => {
        try {
            if (identity.projectId !== projectId || !identity.subject || identity.subject.length > 128) invalidIdentity()
            const accessToken = await getAccessToken(signal)
            if (!accessToken || /[\r\n]/.test(accessToken)) invalidIdentity()
            const response = await fetcher(`https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`, {
                method: 'POST', redirect: 'error', signal: identityLookupSignal(signal),
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ localId: [identity.subject] }),
            })
            if (!response.ok) invalidIdentity()
            const body: unknown = await response.json()
            if (!record(body) || !Array.isArray(body.users) || body.users.length !== 1) invalidIdentity()
            const account: unknown = body.users[0]
            if (!record(account) || account.localId !== identity.subject || account.tenantId !== undefined
                || (account.disabled !== undefined && typeof account.disabled !== 'boolean')
                || (account.validSince !== undefined && (typeof account.validSince !== 'string' || !/^\d+$/.test(account.validSince)))) invalidIdentity()
            const validSince = account.validSince === undefined ? 0 : Number(account.validSince)
            if (!Number.isSafeInteger(validSince) || validSince < 0) invalidIdentity()
            return { disabled: account.disabled === true, validSince }
        } catch {
            throw new Error('Google account status is unavailable.')
        }
    }
}

export function requireActiveGoogleAccount(identity: Pick<GoogleIdentity, 'authenticatedAt'>, status: GoogleAccountStatus): void {
    if (status.disabled || !Number.isSafeInteger(status.validSince) || status.validSince < 0
        || identity.authenticatedAt < status.validSince) invalidIdentity()
}
