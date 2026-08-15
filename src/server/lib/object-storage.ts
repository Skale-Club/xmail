/**
 * Object storage behind one interface: Cloudflare R2 (S3-compatible) when the R2_*
 * secrets are configured, Supabase Storage otherwise.
 *
 * The fallback is deliberate migration order, not indecision: the R2 driver ships first,
 * the buckets/secrets are provisioned in production, and only then does traffic move —
 * so a deploy without the secrets keeps working against Supabase instead of failing
 * closed on every attachment.
 *
 * Buckets map 1:1 to R2 buckets by name ('inbox-attachments' private, 'branding-assets'
 * public). Public URLs come from R2_PUBLIC_BASE_URL — the custom domain (or r2.dev host)
 * bound to the PUBLIC branding bucket; R2 has no path-style public endpoint like
 * Supabase's /storage/v1/object/public/.
 */
import { Buffer } from 'node:buffer'

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
    const base = process.env.R2_PUBLIC_BASE_URL
    if (!base) return null
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

// Lazy singleton: the SDK client is only constructed on first use, so importing this
// module (unit tests, tooling) never requires credentials.
let r2Client: import('@aws-sdk/client-s3').S3Client | null = null

async function getR2Client(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (!r2Client) {
        const { S3Client } = await import('@aws-sdk/client-s3')
        const endpoint = process.env.R2_ENDPOINT
            || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        r2Client = new S3Client({
            // R2 ignores the region but the SDK requires one; 'auto' is Cloudflare's
            // documented value.
            region: 'auto',
            endpoint,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID!,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
            },
        })
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

// Supabase driver — kept until the R2 cutover is complete everywhere, then deletable.
// Lazy imports so this module never drags the Supabase client into unit tests.
function createSupabaseStorage(): ObjectStorage {
    return {
        async upload(bucket, path, bytes, contentType, opts) {
            const { supabaseAdminClient } = await import('./supabase')
            const { error } = await supabaseAdminClient.storage.from(bucket).upload(path, bytes, {
                contentType,
                upsert: opts?.upsert ?? false,
            })
            if (error) throw new Error(error.message)
        },
        async download(bucket, path) {
            const { supabaseAdminClient } = await import('./supabase')
            const { data, error } = await supabaseAdminClient.storage.from(bucket).download(path)
            if (error || !data) throw new Error(error?.message ?? `empty body for ${bucket}/${path}`)
            return Buffer.from(await data.arrayBuffer())
        },
        async createSignedUrl(bucket, path, expiresInSeconds) {
            const { supabaseAdminClient } = await import('./supabase')
            const { data, error } = await supabaseAdminClient.storage.from(bucket).createSignedUrl(path, expiresInSeconds)
            if (error || !data?.signedUrl) throw new Error(error?.message ?? 'signed URL unavailable')
            return data.signedUrl
        },
        async remove(bucket, paths) {
            if (paths.length === 0) return
            const { supabaseAdminClient } = await import('./supabase')
            await supabaseAdminClient.storage.from(bucket).remove(paths)
        },
    }
}

/** The storage backend for this process: R2 when configured, Supabase otherwise. */
export function createObjectStorage(): ObjectStorage {
    return isR2Configured() ? createR2Storage() : createSupabaseStorage()
}
