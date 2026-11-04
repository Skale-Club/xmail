import { resolveDevelopmentAuth } from '../../../lib/development-auth'

const SOURCE_PROJECT = 'zzbudkfkcmqkavgwselc'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_BODY = 65_536

/** Public Auth credentials only; never an administrative SDK or production dev fallback. */
export function legacyAccountProofConfig(env: NodeJS.ProcessEnv = process.env) {
    if (!['production', 'development'].includes(env.NODE_ENV || '')) throw new Error('Existing account proof is unavailable.')
    const development = env.NODE_ENV === 'development'
    const configured = development ? resolveDevelopmentAuth(env) : {
        url: env.SUPABASE_URL || '', anonKey: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '',
    }
    const url = new URL(configured.url)
    const ref = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname)?.[1]
    if (!ref || (!development && ref !== SOURCE_PROJECT) || url.protocol !== 'https:' || url.port
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Existing account proof is unavailable.')
    const key = configured.anonKey
    if (!key || key.length > 8192 || /\s/.test(key)) throw new Error('Existing account proof is unavailable.')
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) throw new Error('Existing account proof is unavailable.')
        const claims: unknown = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))
        if (!claims || typeof claims !== 'object' || (claims as Record<string, unknown>).role !== 'anon'
            || (claims as Record<string, unknown>).ref !== ref) throw new Error('Existing account proof is unavailable.')
    }
    return { origin: url.origin, key }
}

async function boundedBody(response: Response): Promise<Record<string, unknown> | null> {
    if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); return null }
    const length = Number(response.headers.get('content-length') ?? 0)
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY) { void response.body?.cancel().catch(() => {}); return null }
    const reader = response.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_BODY) { void reader.cancel().catch(() => {}); return null }
            chunks.push(part.value)
        }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Explicit old-account possession proof only. No application session, contact
 * matching, password update or persistence of provider access/refresh tokens. */
export async function readLegacyPasswordProof(email: unknown, password: unknown, options: {
    env?: NodeJS.ProcessEnv; request?: typeof fetch; signal?: AbortSignal; timeoutMs?: number
} = {}): Promise<{ id: string } | null> {
    if (typeof email !== 'string' || !email.trim() || email.length > 320
        || typeof password !== 'string' || !password || password.length > 4096) return null
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel: (() => void) | undefined
    try {
        signal.throwIfAborted()
        const config = legacyAccountProofConfig(options.env)
        const requested = options.timeoutMs ?? 8000
        const timeout = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 8000) : 8000
        const deadline = new Promise<never>((_, reject) => {
            cancel = () => reject(new Error('Existing account proof is unavailable.'))
            signal.addEventListener('abort', cancel, { once: true })
            timer = setTimeout(() => { controller.abort(); reject(new Error('Existing account proof is unavailable.')) }, timeout)
        })
        const prove = async () => {
            const request = options.request ?? fetch
            const response = await request(`${config.origin}/auth/v1/token?grant_type=password`, {
                method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim(), password }), redirect: 'error', cache: 'no-store', signal,
            })
            const issued = await boundedBody(response), token = issued?.access_token
            if (typeof token !== 'string' || token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null
            const user = await boundedBody(await request(`${config.origin}/auth/v1/user`, {
                method: 'GET', headers: { apikey: config.key, Authorization: `Bearer ${token}` },
                redirect: 'error', cache: 'no-store', signal,
            }))
            if (!user || typeof user.id !== 'string' || !UUID.test(user.id) || user.deleted_at != null) return null
            const metadata = user.app_metadata
            if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) return null
            const disabled = (metadata as Record<string, unknown> | null)?.xmail_disabled
            if (disabled != null && disabled !== false) return null
            if (user.banned_until != null && (typeof user.banned_until !== 'string'
                || !Number.isFinite(Date.parse(user.banned_until)) || Date.parse(user.banned_until) > Date.now())) return null
            return { id: user.id.toLowerCase() }
        }
        return await Promise.race([prove(), deadline])
    } catch { return null }
    finally { clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); controller.abort() }
}
