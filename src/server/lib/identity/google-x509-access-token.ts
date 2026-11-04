import { request } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'

/** Produced only by an application's reviewed local-file/project/SAN validator. */
export interface GoogleX509Credential {
    audience: string
    serviceAccountEmail: string
    certificate: Buffer
    privateKey: Buffer
    subjectToken: string
}

const unavailable = () => new Error('Keyless Google credentials are unavailable.')
const token = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** No redirects, proxy/custom endpoints, shared agent, unbounded body or detached socket. */
function postJson(url: string, body: unknown, signal: AbortSignal, mtls?: GoogleX509Credential, bearer?: string): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        let req: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false
        const finish = (error?: Error, value?: Record<string, unknown>) => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', abort)
            if (error) { response?.destroy(); req?.destroy(); reject(unavailable()) }
            else resolve(value!)
        }
        const abort = () => finish(unavailable())
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { abort(); return }
        try {
            const data = JSON.stringify(body)
            req = request(url, {
                method: 'POST', agent: false, signal, rejectUnauthorized: true, minVersion: 'TLSv1.2',
                ...(mtls ? { cert: mtls.certificate, key: mtls.privateKey } : {}),
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
            }, res => {
                response = res
                if (settled) { res.destroy(); return }
                if (res.statusCode !== 200) { finish(unavailable()); return }
                const chunks: Buffer[] = []
                let length = 0
                res.on('data', (chunk: Buffer) => {
                    length += chunk.length
                    if (length > 65_536) { finish(unavailable()); return }
                    chunks.push(chunk)
                })
                res.on('error', () => finish(unavailable()))
                res.on('aborted', () => finish(unavailable()))
                res.on('end', () => {
                    if (settled) return
                    try {
                        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                        if (!record(value)) throw unavailable()
                        finish(undefined, value)
                    } catch { finish(unavailable()) }
                })
            })
            req.on('error', () => finish(unavailable()))
            req.setTimeout(8_000, abort)
            req.end(data)
        } catch { finish(unavailable()) }
    })
}

/** Portable X.509 STS + SA impersonation. Caller also shares its deadline with users:lookup. */
export async function getGoogleX509AccessToken(credential: GoogleX509Credential, signal: AbortSignal): Promise<string> {
    try {
        if (!/^\/\/iam\.googleapis\.com\/projects\/\d{6,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(credential.audience)
            || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(credential.serviceAccountEmail)
            || !Buffer.isBuffer(credential.certificate) || !credential.certificate.length || credential.certificate.length > 65_536
            || !Buffer.isBuffer(credential.privateKey) || !credential.privateKey.length || credential.privateKey.length > 65_536
            || typeof credential.subjectToken !== 'string' || credential.subjectToken.length > 131_072) throw unavailable()
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        const exchanged = await postJson('https://sts.mtls.googleapis.com/v1/token', {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            subject_token_type: 'urn:ietf:params:oauth:token-type:mtls',
            audience: credential.audience, subject_token: credential.subjectToken,
            scope: 'https://www.googleapis.com/auth/cloud-platform',
        }, deadline, credential)
        if (!token(exchanged.access_token) || exchanged.token_type !== 'Bearer'
            || !Number.isFinite(exchanged.expires_in) || Number(exchanged.expires_in) <= 0 || Number(exchanged.expires_in) > 3600) throw unavailable()
        // The STS token is never sent to a configurable URL. This one-use request
        // carries it only to Google's canonical service-account endpoint.
        const impersonated = await postJson(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${credential.serviceAccountEmail}:generateAccessToken`, {
            scope: ['https://www.googleapis.com/auth/identitytoolkit'], lifetime: '600s',
        }, deadline, undefined, exchanged.access_token)
        if (!token(impersonated.accessToken) || typeof impersonated.expireTime !== 'string'
            || !Number.isFinite(Date.parse(impersonated.expireTime)) || Date.parse(impersonated.expireTime) <= Date.now()
            || Date.parse(impersonated.expireTime) > Date.now() + 610_000) throw unavailable()
        return impersonated.accessToken
    } catch { throw unavailable() }
}
