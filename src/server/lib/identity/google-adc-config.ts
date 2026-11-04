import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, posix, join, basename, dirname, normalize } from 'node:path'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import type { IdentityConfig } from './config'
import type { GoogleX509Credential } from './google-x509-access-token'

function invalid(): never { throw new Error('Keyless Google credentials are not configured.') }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

/** Read a bounded regular file; never follow a final symlink or read a device/FIFO. */
function file(path: string, privateKey = false): Buffer {
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
    try {
        const stat = fstatSync(descriptor)
        if (!stat.isFile() || stat.size < 1 || stat.size > 65_536
            || (privateKey && process.platform !== 'win32' && (stat.mode & 0o077))) invalid()
        const buffer = Buffer.alloc(65_537)
        let offset = 0, count: number
        do { count = readSync(descriptor, buffer, offset, buffer.length - offset, null); offset += count } while (count && offset < buffer.length)
        if (!offset || offset > 65_536) invalid()
        return buffer.subarray(0, offset)
    } finally { closeSync(descriptor) }
}

function fixedFile(value: unknown, expected: string, key = false): Buffer {
    if (typeof value !== 'string' || value !== expected || !isAbsolute(value)
        || (value.startsWith('/') ? posix.normalize(value) : normalize(value)) !== value || realpathSync(value) !== value) invalid()
    return file(value, key)
}

function certificates(buffer: Buffer): X509Certificate[] {
    const pem = buffer.toString('ascii'), blocks = pem.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g) || []
    if (!blocks.length || blocks.length > 5 || blocks.reduce((text, block) => text.replace(block, ''), pem).trim()) invalid()
    return blocks.map(block => {
        const cert = new X509Certificate(block)
        if (Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) invalid()
        return cert
    })
}

export type ValidatedGoogleAdc = { kind: 'oidc'; credentials: Record<string, any> }
    | { kind: 'x509'; credential: GoogleX509Credential }

/** No ambient gcloud/Codex credential, URL, executable, key JSON or project fallback. */
export function loadValidatedGoogleAdc(config: IdentityConfig): ValidatedGoogleAdc {
    try {
        if (!config.adcFile || !isAbsolute(config.adcFile)) invalid()
        const credentials: unknown = JSON.parse(file(config.adcFile).toString('utf8'))
        if (!record(credentials) || credentials.type !== 'external_account' || credentials.private_key !== undefined
            || credentials.refresh_token !== undefined || credentials.client_secret !== undefined || !record(credentials.credential_source)) invalid()
        const source = credentials.credential_source
        if (source.url || source.executable || credentials.credentialSource || credentials.tokenUrl
            || credentials.subjectTokenSupplier || credentials.subject_token_supplier
            || /(?:codex|openai|oai[-_/])/i.test(String(credentials.audience || ''))) invalid()
        const expectedAudience = /^\/\/iam\.googleapis\.com\/projects\/(\d{6,20})\/locations\/global\/workloadIdentityPools\/hetzner-xmail\/providers\/([a-z][a-z0-9-]{2,31})$/.exec(config.adcAudience || '')
        const serviceAccountEmail = `xmail-firebase-auth-reader@${config.projectId}.iam.gserviceaccount.com`
        if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId) || !expectedAudience
            || expectedAudience[1] !== config.projectNumber || credentials.audience !== config.adcAudience
            || config.adcServiceAccount !== serviceAccountEmail
            || credentials.service_account_impersonation_url !== `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccountEmail}:generateAccessToken`
            || !only(credentials, ['type', 'audience', 'subject_token_type', 'token_url', 'service_account_impersonation_url',
                'service_account_impersonation', 'credential_source', 'universe_domain', 'quota_project_id'])
            || (credentials.universe_domain !== undefined && credentials.universe_domain !== 'googleapis.com')
            || (credentials.quota_project_id !== undefined && credentials.quota_project_id !== config.projectId)) invalid()
        if (credentials.service_account_impersonation !== undefined && (!record(credentials.service_account_impersonation)
            || !only(credentials.service_account_impersonation, ['token_lifetime_seconds'])
            || credentials.service_account_impersonation.token_lifetime_seconds !== 600)) invalid()
        const dev = config.sessionCookie === 'xmail_identity_dev'
        const root = dev ? config.adcRoot : '/run/secrets/xmail-google-identity'
        if (!root || (dev && (!isAbsolute(root) || normalize(root) !== root || basename(root) !== config.projectId
            || root.startsWith('\\') || basename(dirname(root)) !== 'development'
            || basename(dirname(dirname(root))) !== 'xmail-google-identity'))) invalid()
        const path = (name: string) => dev ? join(root, name) : posix.join(root, name)
        if (config.adcFile !== path('adc.json') || realpathSync(config.adcFile) !== config.adcFile) invalid()
        if (credentials.token_url === 'https://sts.googleapis.com/v1/token') {
            if (!isAbsolute(source.file || '') || !only(source, ['file', 'format']) || expectedAudience[2] === 'x509'
                || credentials.subject_token_type !== 'urn:ietf:params:oauth:token-type:jwt') invalid()
            if (source.format !== undefined && (!record(source.format) || !only(source.format, ['type', 'subject_token_field_name'])
                || !['text', 'json'].includes(source.format.type)
                || (source.format.type === 'text' && source.format.subject_token_field_name !== undefined)
                || (source.format.type === 'json' && (typeof source.format.subject_token_field_name !== 'string'
                    || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(source.format.subject_token_field_name))))) invalid()
            const json = source.format?.type === 'json'
            const content = fixedFile(source.file, path(json ? 'subject-token.json' : 'subject-token.jwt'), true).toString('utf8')
            let subjectToken: unknown = content.trim()
            if (json) {
                const body: unknown = JSON.parse(content)
                if (!record(body) || body.type === 'service_account' || body.private_key !== undefined) invalid()
                subjectToken = body[source.format.subject_token_field_name]
            }
            // Check only the transport shape; Google STS remains the JWT
            // signature/issuer/subject authority. Never forward a PEM/JSON key.
            if (typeof subjectToken !== 'string' || subjectToken.length > 16_384
                || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(subjectToken)) invalid()
            return { kind: 'oidc', credentials: { ...credentials, service_account_impersonation: { token_lifetime_seconds: 600 } } }
        }
        if (credentials.token_url !== 'https://sts.mtls.googleapis.com/v1/token'
            || credentials.subject_token_type !== 'urn:ietf:params:oauth:token-type:mtls'
            || !only(source, ['certificate']) || !record(source.certificate)
            || !only(source.certificate, ['certificate_config_location', 'trust_chain_path', 'use_default_certificate_config'])
            || (source.certificate.use_default_certificate_config !== undefined && source.certificate.use_default_certificate_config !== false)) invalid()
        const audience = `//iam.googleapis.com/projects/${config.projectNumber}/locations/global/workloadIdentityPools/hetzner-xmail/providers/x509`
        if (config.adcAudience !== audience) invalid()
        const certificateConfig: unknown = JSON.parse(fixedFile(source.certificate.certificate_config_location, path('certificate-config.json')).toString('utf8'))
        if (!record(certificateConfig) || !only(certificateConfig, ['cert_configs', 'version'])
            || (certificateConfig.version !== undefined && certificateConfig.version !== 1)
            || !record(certificateConfig.cert_configs) || !only(certificateConfig.cert_configs, ['workload'])
            || !record(certificateConfig.cert_configs.workload) || !only(certificateConfig.cert_configs.workload, ['cert_path', 'key_path'])) invalid()
        const workload = certificateConfig.cert_configs.workload
        const certificate = fixedFile(workload.cert_path, path('client.crt'))
        const privateKey = fixedFile(workload.key_path, path('client.key'), true)
        const leaf = certificates(certificate)
        const san = `spiffe://skale.club/apps/xmail/${dev ? `development/${config.projectId}` : 'production'}`
        if (leaf.length !== 1 || leaf[0].ca || leaf[0].subjectAltName !== `URI:${san}`
            || !leaf[0].keyUsage?.includes('1.3.6.1.5.5.7.3.2')
            || !leaf[0].checkPrivateKey(createPrivateKey(privateKey))) invalid()
        let chain = leaf
        if (source.certificate.trust_chain_path !== undefined) {
            chain = certificates(fixedFile(source.certificate.trust_chain_path, path('trust-chain.pem')))
            if (!chain[0].raw.equals(leaf[0].raw)) chain.unshift(leaf[0])
            if (chain.length > 5 || new Set(chain.map(cert => cert.raw.toString('base64'))).size !== chain.length) invalid()
        }
        return { kind: 'x509', credential: { audience, serviceAccountEmail, certificate, privateKey,
            subjectToken: JSON.stringify(chain.map(cert => cert.raw.toString('base64'))) } }
    } catch { return invalid() }
}
