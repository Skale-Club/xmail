import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { loadValidatedGoogleAdc } from './google-adc-config'
import type { IdentityConfig } from './config'

const fixture = vi.hoisted(() => ({ files: new Map<string, Buffer>(), descriptors: new Map<number, string>(), symlink: '', mode: 0o600,
    regular: true, size: 0, keyMatches: true, san: 'URI:spiffe://skale.club/apps/xmail/production', ca: false, expired: false,
    eku: ['1.3.6.1.5.5.7.3.2'] as string[] | undefined }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
    realpathSync: (path: string) => path === fixture.symlink ? '/unapproved/elsewhere' : path,
    openSync: (path: string) => { if (!fixture.files.has(path)) throw Error('private-path-diagnostic'); const fd = fixture.descriptors.size + 1; fixture.descriptors.set(fd, path); return fd },
    closeSync: (fd: number) => fixture.descriptors.delete(fd),
    fstatSync: (fd: number) => ({ isFile: () => fixture.regular, size: fixture.size || fixture.files.get(fixture.descriptors.get(fd)!)!.length, mode: fixture.mode }),
    readSync: (fd: number, output: Buffer, offset: number, length: number) => {
        const input = fixture.files.get(fixture.descriptors.get(fd)!)!
        return input.copy(output, offset, offset, Math.min(input.length, offset + length))
    },
}))
vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(),
    createPrivateKey: () => 'offline-mocked-key',
    X509Certificate: class {
        constructor(private pem: string) {}
        get raw() { return Buffer.from(this.pem) }
        get ca() { return fixture.ca }
        get subjectAltName() { return fixture.san }
        get keyUsage() { return fixture.eku }
        get validFrom() { return 'Jan 1 2020 GMT' }
        get validTo() { return fixture.expired ? 'Jan 1 2021 GMT' : 'Jan 1 2090 GMT' }
        checkPrivateKey() { return fixture.keyMatches }
    },
}))
const root = '/run/secrets/xmail-google-identity'
const config: IdentityConfig = {
    projectId: 'skaleclub', projectNumber: '937861185231', apiKey: 'offline-public-key', authDomain: 'skaleclub.firebaseapp.com', origin: 'https://mail.skale.club', secure: true,
    sessionCookie: '__Host-xmail_identity', browserCookie: '__Host-xmail_identity_browser', adcMode: 'external_account', adcFile: `${root}/adc.json`,
    adcAudience: '//iam.googleapis.com/projects/937861185231/locations/global/workloadIdentityPools/hetzner-xmail/providers/x509',
    adcServiceAccount: 'xmail-firebase-auth-reader@skaleclub.iam.gserviceaccount.com',
}
const adc = () => ({ type: 'external_account', audience: config.adcAudience, subject_token_type: 'urn:ietf:params:oauth:token-type:mtls',
    token_url: 'https://sts.mtls.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.adcServiceAccount}:generateAccessToken`,
    credential_source: { certificate: { certificate_config_location: `${root}/certificate-config.json` } },
})
const put = (path: string, body: unknown) => fixture.files.set(path, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
const updateAdc = (patch: Record<string, unknown>) => put(config.adcFile!, { ...adc(), ...patch })

beforeEach(() => {
    fixture.files.clear(); fixture.descriptors.clear()
    Object.assign(fixture, { symlink: '', mode: 0o600, regular: true, size: 0, keyMatches: true, san: 'URI:spiffe://skale.club/apps/xmail/production', ca: false, expired: false, eku: ['1.3.6.1.5.5.7.3.2'] })
    put(config.adcFile!, adc())
    put(`${root}/certificate-config.json`, { version: 1, cert_configs: { workload: { cert_path: `${root}/client.crt`, key_path: `${root}/client.key` } } })
    put(`${root}/client.crt`, '-----BEGIN CERTIFICATE-----\nYQ==\n-----END CERTIFICATE-----')
    put(`${root}/client.key`, 'offline-placeholder-not-a-private-key')
})

describe('strict Xmail ADC local configuration', () => {
    it('returns only the validated portable DTO; no Google request, real certificate or key is used', () => {
        const result = loadValidatedGoogleAdc(config)
        expect(result.kind).toBe('x509')
        if (result.kind !== 'x509') throw Error('wrong branch')
        expect(result.credential).toMatchObject({ audience: config.adcAudience, serviceAccountEmail: config.adcServiceAccount })
        expect(JSON.parse(result.credential.subjectToken)).toHaveLength(1)
        expect(fixture.descriptors.size).toBe(0)
    })
    it.each([
        { type: 'service_account' }, { private_key: 'offline-placeholder' }, { refresh_token: 'offline-placeholder' },
        { client_secret: 'offline-placeholder' }, { subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' },
        { token_url: 'https://sts.mtls.googleapis.com.attacker.invalid/v1/token' }, { token_url: 'https://sts.mtls.googleapis.com/v1/token?override=1' },
        { audience: '//iam.googleapis.com/projects/937861185231/locations/global/workloadIdentityPools/codex/providers/oai' },
        { audience: config.adcAudience!.replace('937861185231', '111111111111') }, { universe_domain: 'other.invalid' },
        { service_account_impersonation_url: 'https://attacker.invalid' }, { service_account_impersonation: { token_lifetime_seconds: 3600 } },
        { credentialSource: { url: 'https://attacker.invalid' } }, { subjectTokenSupplier: {} },
    ])('rejects alternate authority, credentials or override fields %#', patch => {
        updateAdc(patch)
        expect(() => loadValidatedGoogleAdc(config)).toThrow(/^Keyless Google credentials are not configured\.$/)
    })
    it.each([
        { file: '/tmp/token', certificate: adc().credential_source.certificate },
        { url: 'https://attacker.invalid' }, { executable: { command: 'not-run' } },
        { certificate: { use_default_certificate_config: true } },
        { certificate: { certificate_config_location: `${root}/../other.json` } },
        { certificate: { certificate_config_location: 'https://attacker.invalid/config' } },
        { certificate: { certificate_config_location: `${root}/certificate-config.json`, trust_chain_path: '/other/chain.pem' } },
    ])('rejects ambient, URL, executable and mixed sources %#', credential_source => {
        updateAdc({ credential_source })
        expect(() => loadValidatedGoogleAdc(config)).toThrow('Keyless Google credentials are not configured.')
    })
    it('requires explicit audience and service-account expectations, with no production defaults', () => {
        for (const patch of [{ adcAudience: undefined }, { adcServiceAccount: undefined }, { adcServiceAccount: 'other@skaleclub.iam.gserviceaccount.com' }]) {
            expect(() => loadValidatedGoogleAdc({ ...config, ...patch })).toThrow()
        }
    })
    it('rejects symlink escape, nonregular or oversized files, SAN ambiguity, expired/CA certs and a mismatched key', () => {
        const failures = [{ symlink: `${root}/client.key` }, { regular: false }, { size: 65_537 },
            { san: 'URI:spiffe://skale.club/apps/xkedule/production' }, { san: fixture.san + ', DNS:extra.invalid' },
            { expired: true }, { ca: true }, { keyMatches: false }, { eku: undefined }, { eku: ['1.3.6.1.5.5.7.3.1'] }]
        for (const failure of failures) {
            const before = { ...fixture }
            Object.assign(fixture, failure)
            expect(() => loadValidatedGoogleAdc(config)).toThrow('Keyless Google credentials are not configured.')
            Object.assign(fixture, before)
        }
    })
    it('preserves file OIDC with normal STS while rejecting Codex audiences, URL/executable and mixed certificate sources', () => {
        const oidcConfig = { ...config, adcAudience: config.adcAudience!.replace('/x509', '/renewable-oidc') }
        const oidc = { ...adc(), token_url: 'https://sts.googleapis.com/v1/token',
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', audience: oidcConfig.adcAudience, credential_source: { file: `${root}/subject-token.jwt` } }
        put(`${root}/subject-token.jwt`, 'offline.header.signature')
        put(config.adcFile!, oidc)
        expect(loadValidatedGoogleAdc(oidcConfig)).toMatchObject({ kind: 'oidc', credentials: { ...oidc, service_account_impersonation: { token_lifetime_seconds: 600 } } })
        expect(() => loadValidatedGoogleAdc({ ...oidcConfig, adcAudience: undefined })).toThrow()
        expect(() => loadValidatedGoogleAdc({ ...oidcConfig, adcServiceAccount: undefined })).toThrow()
        for (const patch of [{ audience: 'pool/codex/provider/oai' }, { credential_source: { file: '/token', url: 'https://attacker.invalid' } },
            { credential_source: { file: '/token', executable: {} } }, { credential_source: { file: '/token', certificate: {} } },
            { service_account_impersonation_url: 'https://attacker.invalid/collect-sts-bearer' },
            { service_account_impersonation_url: oidc.service_account_impersonation_url.replace('skaleclub', 'different-project') },
            { audience: oidc.audience.replace('937861185231', '111111111111') }, { serviceAccountImpersonationUrl: 'https://attacker.invalid' },
            { token_info_url: 'https://attacker.invalid' }, { credential_source: { file: '/token', format: { type: 'json', subjectTokenFieldName: 'bypass-alias' } } }]) {
            put(config.adcFile!, { ...oidc, ...patch })
            expect(() => loadValidatedGoogleAdc(oidcConfig)).toThrow()
        }
    })
    it('confines OIDC token reads to bounded regular canonical profile files and refuses key material', () => {
        const oidcConfig = { ...config, adcAudience: config.adcAudience!.replace('/x509', '/renewable-oidc') }
        const oidc = { ...adc(), audience: oidcConfig.adcAudience, token_url: 'https://sts.googleapis.com/v1/token',
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', credential_source: { file: `${root}/subject-token.jwt` } }
        put(config.adcFile!, oidc)
        put(`${root}/subject-token.jwt`, 'offline.header.signature')
        expect(loadValidatedGoogleAdc(oidcConfig).kind).toBe('oidc')
        for (const failure of [{ regular: false }, { size: 65_537 }, { symlink: `${root}/subject-token.jwt` }]) {
            const before = { ...fixture }; Object.assign(fixture, failure)
            expect(() => loadValidatedGoogleAdc(oidcConfig)).toThrow()
            Object.assign(fixture, before)
        }
        for (const file of ['/production/subject-token.jwt', `${root}/client.key`, `${root}/service-account.json`, `${root}/../subject-token.jwt`]) {
            put(config.adcFile!, { ...oidc, credential_source: { file } })
            expect(() => loadValidatedGoogleAdc(oidcConfig)).toThrow()
        }
        const jsonSource = { file: `${root}/subject-token.json`, format: { type: 'json', subject_token_field_name: 'token' } }
        put(config.adcFile!, { ...oidc, credential_source: jsonSource })
        put(jsonSource.file, { token: 'offline.header.signature' })
        expect(loadValidatedGoogleAdc(oidcConfig).kind).toBe('oidc')
        put(jsonSource.file, { type: 'service_account', token: 'offline.header.signature', private_key: 'offline-placeholder' })
        expect(() => loadValidatedGoogleAdc(oidcConfig)).toThrow()
        put(config.adcFile!, oidc); put(`${root}/subject-token.jwt`, 'offline-placeholder-not-a-jwt')
        expect(() => loadValidatedGoogleAdc(oidcConfig)).toThrow()
    })
    it('limits the entire X509 subject chain to five certificates including the leaf', () => {
        const cert = (letter: string) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(letter).toString('base64')}\n-----END CERTIFICATE-----`
        updateAdc({ credential_source: { certificate: { ...adc().credential_source.certificate, trust_chain_path: `${root}/trust-chain.pem` } } })
        put(`${root}/trust-chain.pem`, ['a', 'b', 'c', 'd', 'e'].map(cert).join('\n'))
        const accepted = loadValidatedGoogleAdc(config)
        expect(accepted.kind === 'x509' && JSON.parse(accepted.credential.subjectToken).length).toBe(5)
        put(`${root}/trust-chain.pem`, ['b', 'c', 'd', 'e', 'f'].map(cert).join('\n'))
        expect(() => loadValidatedGoogleAdc(config)).toThrow()
        put(`${root}/trust-chain.pem`, ['a', 'b', 'c', 'd', 'e', 'f'].map(cert).join('\n'))
        expect(() => loadValidatedGoogleAdc(config)).toThrow()
    })
    it('accepts only an explicit native development namespace with exact DEV project, SAN and paths', () => {
        const projectId = 'xmail-isolated-dev', projectNumber = '123456789012'
        const devRoot = resolve('offline', 'xmail-google-identity', 'development', projectId)
        const devConfig = { ...config, projectId, projectNumber, sessionCookie: 'xmail_identity_dev', adcRoot: devRoot,
            adcFile: join(devRoot, 'adc.json'), adcAudience: config.adcAudience!.replace(config.projectNumber, projectNumber),
            adcServiceAccount: `xmail-firebase-auth-reader@${projectId}.iam.gserviceaccount.com` }
        const devAdc = { ...adc(), audience: devConfig.adcAudience,
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${devConfig.adcServiceAccount}:generateAccessToken`,
            credential_source: { certificate: { certificate_config_location: join(devRoot, 'certificate-config.json') } } }
        put(devConfig.adcFile, devAdc)
        put(join(devRoot, 'certificate-config.json'), { cert_configs: { workload: { cert_path: join(devRoot, 'client.crt'), key_path: join(devRoot, 'client.key') } } })
        fixture.files.set(join(devRoot, 'client.crt'), fixture.files.get(`${root}/client.crt`)!)
        fixture.files.set(join(devRoot, 'client.key'), fixture.files.get(`${root}/client.key`)!)
        fixture.san = `URI:spiffe://skale.club/apps/xmail/development/${projectId}`
        expect(loadValidatedGoogleAdc(devConfig).kind).toBe('x509')
        expect(() => loadValidatedGoogleAdc({ ...devConfig, adcRoot: undefined })).toThrow()
        expect(() => loadValidatedGoogleAdc({ ...devConfig, adcFile: config.adcFile })).toThrow()
        expect(() => loadValidatedGoogleAdc({ ...devConfig, adcRoot: root })).toThrow()
        const devOidc = { ...devConfig, adcAudience: devConfig.adcAudience.replace('/x509', '/renewable-oidc') }
        const source = { ...devAdc, audience: devOidc.adcAudience, token_url: 'https://sts.googleapis.com/v1/token',
            subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', credential_source: { file: `${root}/subject-token.jwt` } }
        put(`${root}/subject-token.jwt`, 'offline.header.signature')
        put(devConfig.adcFile, source)
        expect(() => loadValidatedGoogleAdc(devOidc)).toThrow()
        put(join(devRoot, 'subject-token.jwt'), 'offline.header.signature')
        put(devConfig.adcFile, { ...source, credential_source: { file: join(devRoot, 'subject-token.jwt') } })
        expect(loadValidatedGoogleAdc(devOidc).kind).toBe('oidc')
    })
})
