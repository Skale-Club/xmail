/**
 * Object storage behind one interface: Cloudflare R2 (S3-compatible) when the R2_*
 * secrets are configured, with hosted fallback restricted to legacy authority.
 *
 * Legacy authority retains its configuration-based selection. Owned authority
 * requires the existing R2 backend and never selects hosted Storage on failure.
 *
 * Current R2 buckets are 'xmail-inbox-attachments' and 'xmail-branding-assets'.
 * Public URLs come from R2_PUBLIC_BASE_URL — the custom domain (or r2.dev host)
 * bound to the PUBLIC branding bucket; R2 has no path-style public endpoint like
 * Supabase's /storage/v1/object/public/.
 */
import { Buffer } from 'node:buffer'
import { browserAuthAuthority } from './identity/browser-auth-authority'

const STORAGE_UNAVAILABLE = 'Selected object storage is unavailable.'
const R2_BUCKETS = ['xmail-inbox-attachments', 'xmail-branding-assets'] as const

interface R2Configuration {
    endpoint: string
    credentials: { accessKeyId: string; secretAccessKey: string }
}

/** Validate destinations before an owned request can attach R2 credentials. */
export function ownedR2Configuration(env: Record<string, string | undefined>): R2Configuration {
    try {
        const accessKeyId = env.R2_ACCESS_KEY_ID
        const secretAccessKey = env.R2_SECRET_ACCESS_KEY
        if (![accessKeyId, secretAccessKey].every(value => typeof value === 'string'
            && value.length > 0 && value.length <= 512 && !/\s/.test(value)
            && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw Error()
        const endpoint = new URL(env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
        const match = /^([a-f0-9]{32})(?:\.(eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.exec(endpoint.hostname)
        if (!match || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port
            || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
            || (env.R2_ACCOUNT_ID && env.R2_ACCOUNT_ID !== match[1])) throw Error()
        if (env.R2_PUBLIC_BASE_URL) publicBase(env.R2_PUBLIC_BASE_URL)
        return { endpoint: endpoint.href, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! } }
    } catch { throw new Error(STORAGE_UNAVAILABLE) }
}

function publicBase(value: string): string {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || url.pathname !== '/') throw new Error(STORAGE_UNAVAILABLE)
    return url.origin
}

export interface ObjectStorage {
    upload(
        bucket: string,
        path: string,
        bytes: Buffer,
        contentType: string,
        opts?: { upsert?: boolean },
    ): Promise<void>
    download(bucket: string, path: string): Promise<Buffer>
    createSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>
    remove(bucket: string, paths: string[]): Promise<void>
}

export function isR2Configured(): boolean {
    return Boolean(
        process.env.R2_ACCESS_KEY_ID
        && process.env.R2_SECRET_ACCESS_KEY
        && (process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID),
    )
}

/**
 * Public URL for an object in the public bucket, or null when R2 is not serving
 * public assets yet (caller falls back to the Supabase public URL).
 */
export function publicObjectUrl(path: string): string | null {
    if (browserAuthAuthority(process.env) === 'owned') {
        ownedR2Configuration(process.env)
        // The caller's historical null branch constructs a Supabase public URL.
        // Missing owned public configuration must never enter that branch.
        if (!process.env.R2_PUBLIC_BASE_URL) throw new Error(STORAGE_UNAVAILABLE)
        try { return `${publicBase(process.env.R2_PUBLIC_BASE_URL)}/${path.replace(/^\/+/, '')}` }
        catch { throw new Error(STORAGE_UNAVAILABLE) }
    }
    const base = process.env.R2_PUBLIC_BASE_URL
    if (!base) return null
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

// Lazy singleton: the SDK client is only constructed on first use, so importing this
// module (unit tests, tooling) never requires credentials.
let r2Client: import('@aws-sdk/client-s3').S3Client | null = null
let r2ClientConfiguration: string | null = null

async function getR2Client(): Promise<import('@aws-sdk/client-s3').S3Client> {
    const owned = browserAuthAuthority(process.env) === 'owned'
    const configuration = owned ? ownedR2Configuration(process.env) : {
        endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    }
    // Never reuse a client carrying different credentials/destination after a
    // process-local authority/configuration change. This value stays in memory.
    if (owned && r2Client && r2ClientConfiguration !== JSON.stringify(configuration)) throw new Error(STORAGE_UNAVAILABLE)
    if (!r2Client) {
        const { S3Client } = await import('@aws-sdk/client-s3')
        r2Client = new S3Client({
            // R2 ignores the region but the SDK requires one; 'auto' is Cloudflare's
            // documented value.
            region: 'auto',
            ...configuration,
            // A stuck request must fail, never hang. The SDK ships with no request
            // timeout and a 50-socket pool, so one socket that is never released stays
            // checked out for the life of the process; enough of them and every later
            // call queues behind them with nothing to break the wait.
            requestHandler: {
                connectionTimeout: 5_000,
                requestTimeout: 30_000,
                httpsAgent: { maxSockets: 200 },
            },
        })
        r2ClientConfiguration = JSON.stringify(configuration)
    }
    return r2Client
}

function createR2Storage(): ObjectStorage {
    return {
        // Note: S3 PutObject always overwrites, so `upsert: false` is not enforced here
        // the way Supabase enforced it. Attachment paths embed a fresh UUID, so a
        // collision would already be a bug upstream of storage.
        async upload(bucket, path, bytes, contentType) {
            const client = await getR2Client()
            const { PutObjectCommand } = await import('@aws-sdk/client-s3')
            await client.send(new PutObjectCommand({
                Bucket: bucket,
                Key: path,
                Body: bytes,
                ContentType: contentType,
            }))
        },
        async download(bucket, path) {
            const client = await getR2Client()
            const { GetObjectCommand } = await import('@aws-sdk/client-s3')
            const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: path }))
            if (!result.Body) throw new Error(`empty body for ${bucket}/${path}`)
            return Buffer.from(await result.Body.transformToByteArray())
        },
        async createSignedUrl(bucket, path, expiresInSeconds) {
            const client = await getR2Client()
            const { GetObjectCommand } = await import('@aws-sdk/client-s3')
            const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
            return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: path }), {
                expiresIn: expiresInSeconds,
            })
        },
        async remove(bucket, paths) {
            if (paths.length === 0) return
            const client = await getR2Client()
            const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
            await client.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: paths.map((key) => ({ Key: key })), Quiet: true },
            }))
        },
    }
}

// Hosted Storage remains available only for the legacy authority contract.
// Lazy imports so this module never drags the Supabase client into unit tests.
function createSupabaseStorage(): ObjectStorage {
    const requireLegacy = () => {
        if (browserAuthAuthority(process.env) !== 'legacy') throw new Error(STORAGE_UNAVAILABLE)
    }
    return {
        async upload(bucket, path, bytes, contentType, opts) {
            requireLegacy()
            const { supabaseAdminClient } = await import('./supabase')
            requireLegacy()
            const { error } = await supabaseAdminClient.storage.from(bucket).upload(path, bytes, {
                contentType,
                upsert: opts?.upsert ?? false,
            })
            if (error) throw new Error(error.message)
        },
        async download(bucket, path) {
            requireLegacy()
            const { supabaseAdminClient } = await import('./supabase')
            requireLegacy()
            const { data, error } = await supabaseAdminClient.storage.from(bucket).download(path)
            if (error || !data) throw new Error(error?.message ?? `empty body for ${bucket}/${path}`)
            return Buffer.from(await data.arrayBuffer())
        },
        async createSignedUrl(bucket, path, expiresInSeconds) {
            requireLegacy()
            const { supabaseAdminClient } = await import('./supabase')
            requireLegacy()
            const { data, error } = await supabaseAdminClient.storage.from(bucket).createSignedUrl(path, expiresInSeconds)
            if (error || !data?.signedUrl) throw new Error(error?.message ?? 'signed URL unavailable')
            return data.signedUrl
        },
        async remove(bucket, paths) {
            if (paths.length === 0) return
            requireLegacy()
            const { supabaseAdminClient } = await import('./supabase')
            requireLegacy()
            await supabaseAdminClient.storage.from(bucket).remove(paths)
        },
    }
}

/**
 * Development shares attachment objects with the copied production rows
 * (`npm run db:pull` copies metadata only), so objects are read-only there: a dev
 * upload or delete must never touch an object a real mailbox points at.
 */
export function readOnlyObjectStorage(inner: ObjectStorage): ObjectStorage {
    const refuse = (): never => {
        throw new Error('Object storage is read-only in development.')
    }
    return {
        upload: async () => refuse(),
        remove: async () => refuse(),
        download: (bucket, path) => inner.download(bucket, path),
        createSignedUrl: (bucket, path, seconds) => inner.createSignedUrl(bucket, path, seconds),
    }
}

/** Existing backend selection is preserved only for explicit/default legacy authority. */
export function createObjectStorage(): ObjectStorage {
    const storage = selectObjectStorage()
    return process.env.NODE_ENV === 'development' ? readOnlyObjectStorage(storage) : storage
}

function selectObjectStorage(): ObjectStorage {
    if (browserAuthAuthority(process.env) === 'owned') {
        ownedR2Configuration(process.env)
        return createR2Storage()
    }
    return isR2Configured() ? createR2Storage() : createSupabaseStorage()
}

/** Metadata-only availability; this does not inspect or assert bucket privacy. */
export async function checkSelectedStorageHealth(signal: AbortSignal): Promise<{ ok: true }> {
    if (browserAuthAuthority(process.env) === 'legacy') return { ok: true }
    const configuration = ownedR2Configuration(process.env)
    signal.throwIfAborted()
    const { S3Client, HeadBucketCommand } = await import('@aws-sdk/client-s3')
    signal.throwIfAborted()
    const client = new S3Client({ region: 'auto', ...configuration, maxAttempts: 1,
        requestHandler: { connectionTimeout: 1500, requestTimeout: 2500 } })
    const destroy = () => client.destroy()
    signal.addEventListener('abort', destroy, { once: true })
    try {
        signal.throwIfAborted()
        await Promise.all(R2_BUCKETS.map(Bucket => client.send(new HeadBucketCommand({ Bucket }), { abortSignal: signal })))
        signal.throwIfAborted()
        return { ok: true }
    } catch { throw new Error(STORAGE_UNAVAILABLE) }
    finally { signal.removeEventListener('abort', destroy); client.destroy() }
}
