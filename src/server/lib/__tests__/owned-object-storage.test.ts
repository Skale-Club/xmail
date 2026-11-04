import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), construct: vi.fn(), hosted: vi.fn() }))
vi.mock('@aws-sdk/client-s3', () => ({
    S3Client: class { constructor(options: unknown) { sdk.construct(options) } send = sdk.send; destroy = sdk.destroy },
    HeadBucketCommand: class { kind = 'head-bucket'; constructor(public input: unknown) {} },
    GetObjectCommand: class { kind = 'get-object'; constructor(public input: unknown) {} },
}))
vi.mock('../supabase', () => ({ supabaseAdminClient: { storage: { from: sdk.hosted } } }))

import { checkSelectedStorageHealth, createObjectStorage, ownedR2Configuration, publicObjectUrl } from '../object-storage'

const account = 'a'.repeat(32)
function owned() {
    vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'owned'); vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'true')
    vi.stubEnv('XMAIL_USER_ADMIN_AUTHORITY', 'owned'); vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '')
    vi.stubEnv('R2_ACCESS_KEY_ID', 'fixture-access'); vi.stubEnv('R2_SECRET_ACCESS_KEY', 'fixture-secret')
    vi.stubEnv('R2_ACCOUNT_ID', account); vi.stubEnv('R2_ENDPOINT', '')
    vi.stubEnv('R2_PUBLIC_BASE_URL', 'https://cdn.xmail.skale.club')
}
beforeEach(() => { vi.clearAllMocks(); owned(); sdk.send.mockResolvedValue({}) })
afterEach(() => vi.unstubAllEnvs())

describe('owned storage authority', () => {
    it('refuses missing credentials before constructing or contacting either SDK', () => {
        vi.stubEnv('R2_SECRET_ACCESS_KEY', '')
        expect(() => createObjectStorage()).toThrow('Selected object storage is unavailable.')
        expect(sdk.construct).not.toHaveBeenCalled(); expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it('does not treat incomplete owned identity configuration as legacy Storage authority', () => {
        vi.stubEnv('XMAIL_GOOGLE_AUTH_ENABLED', 'false')
        expect(() => createObjectStorage()).toThrow('Browser identity authority is unavailable.')
        expect(sdk.construct).not.toHaveBeenCalled(); expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it.each([
        'https://other.example.com', `http://${account}.r2.cloudflarestorage.com`,
        `https://proof@${account}.r2.cloudflarestorage.com`, `https://${account}.r2.cloudflarestorage.com/path`,
        `https://${account}.r2.cloudflarestorage.com?proof=private`, `https://${account}.r2.cloudflarestorage.com#private`,
        `https://${'b'.repeat(32)}.r2.cloudflarestorage.com`,
    ])('rejects an unsafe or inconsistent credential destination without leaking it', async endpoint => {
        vi.stubEnv('R2_ENDPOINT', endpoint)
        await expect(checkSelectedStorageHealth(new AbortController().signal)).rejects.toThrow(/^Selected object storage is unavailable\.$/)
        expect(sdk.construct).not.toHaveBeenCalled(); expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it('accepts the supported jurisdiction endpoint with matching account and explicit credentials', () => {
        const env = { R2_ACCESS_KEY_ID: 'fixture-access', R2_SECRET_ACCESS_KEY: 'fixture-secret', R2_ACCOUNT_ID: account,
            R2_ENDPOINT: `https://${account}.eu.r2.cloudflarestorage.com` }
        expect(ownedR2Configuration(env)).toEqual({ endpoint: env.R2_ENDPOINT + '/',
            credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' } })
    })
    it('never revives hosted Storage through a legacy object retained before an authority change', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy'); vi.stubEnv('R2_ACCESS_KEY_ID', '')
        const previous = createObjectStorage()
        owned()
        await expect(previous.download('inbox-attachments', 'fixture')).rejects.toThrow('Selected object storage is unavailable.')
        expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it('does not construct hosted public URLs when the owned public base is absent or unsafe', () => {
        vi.stubEnv('R2_PUBLIC_BASE_URL', '')
        expect(() => publicObjectUrl('fixture.svg')).toThrow('Selected object storage is unavailable.')
        vi.stubEnv('R2_PUBLIC_BASE_URL', 'http://unsafe.example.com')
        expect(() => publicObjectUrl('fixture.svg')).toThrow('Selected object storage is unavailable.')
    })
    it('keeps valid public paths on the configured public origin', () => {
        expect(publicObjectUrl('/brand.svg')).toBe('https://cdn.xmail.skale.club/brand.svg')
    })
    it('reads existing attachments through R2 and does not retry hosted Storage after an R2 failure', async () => {
        sdk.send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2]) } })
        const storage = createObjectStorage()
        expect(await storage.download('xmail-inbox-attachments', 'fixture')).toEqual(Buffer.from([1, 2]))
        expect(sdk.send.mock.calls[0][0].kind).toBe('get-object')
        sdk.send.mockRejectedValueOnce(new Error('R2 operation failed'))
        await expect(storage.download('xmail-inbox-attachments', 'fixture')).rejects.toThrow('R2 operation failed')
        expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it('keeps legacy selection and readiness independent of R2 credentials and network', async () => {
        vi.stubEnv('XMAIL_BROWSER_AUTH_AUTHORITY', 'legacy'); vi.stubEnv('R2_SECRET_ACCESS_KEY', '')
        expect(createObjectStorage()).toBeDefined()
        expect(await checkSelectedStorageHealth(new AbortController().signal)).toEqual({ ok: true })
        expect(sdk.send).not.toHaveBeenCalled(); expect(sdk.construct).not.toHaveBeenCalled()
    })
})

describe('owned metadata readiness', () => {
    it('uses only authenticated HeadBucket for the two existing buckets, with bounded retries and cleanup', async () => {
        const signal = new AbortController().signal
        expect(await checkSelectedStorageHealth(signal)).toEqual({ ok: true })
        expect(sdk.send.mock.calls.map(([command]) => ({ kind: command.kind, input: command.input }))).toEqual([
            { kind: 'head-bucket', input: { Bucket: 'xmail-inbox-attachments' } },
            { kind: 'head-bucket', input: { Bucket: 'xmail-branding-assets' } },
        ])
        expect(sdk.send.mock.calls.every(([, options]) => options.abortSignal === signal)).toBe(true)
        expect(sdk.construct).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1, region: 'auto',
            requestHandler: { connectionTimeout: 1500, requestTimeout: 2500 } }))
        expect(sdk.destroy).toHaveBeenCalledOnce(); expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it('sanitizes an authenticated bucket failure and never retries hosted Storage', async () => {
        sdk.send.mockRejectedValue(new Error('credential-bearing request endpoint private-proof'))
        await expect(checkSelectedStorageHealth(new AbortController().signal)).rejects.toThrow(/^Selected object storage is unavailable\.$/)
        expect(sdk.destroy).toHaveBeenCalledOnce(); expect(sdk.hosted).not.toHaveBeenCalled()
    })
    it('destroys an in-flight client when the readiness deadline aborts its signal', async () => {
        sdk.send.mockImplementation((_command, { abortSignal }) => new Promise((_resolve, reject) => {
            abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }))
        const controller = new AbortController()
        const pending = checkSelectedStorageHealth(controller.signal)
        await vi.waitFor(() => expect(sdk.send).toHaveBeenCalledTimes(2))
        controller.abort()
        await expect(pending).rejects.toThrow(/^Selected object storage is unavailable\.$/)
        expect(sdk.destroy).toHaveBeenCalled(); expect(sdk.hosted).not.toHaveBeenCalled()
    })
})
