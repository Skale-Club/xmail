import type { Request, Response } from 'express'
import type { OwnedStreamLease } from './owned-stream-access'

export const OWNED_STREAM_REVIEW_MS = 5000
export const OWNED_STREAM_AUTH_TIMEOUT_MS = 8000
export const OWNED_STREAM_MAX_QUEUE = 32
export const OWNED_STREAM_MAX_PER_USER = 6
export const OWNED_STREAM_MAX_TOTAL = 2000
const MAX_PARALLEL_VALIDATIONS = 8
const users = new Map<string, number>()
let total = 0, validating = 0
export function ownedStreamCount(userId?: string) { return userId === undefined ? total : users.get(userId) ?? 0 }

/** Owned streams have no bearer fallback, no persisted tokens and no SQL lease
 * during provider requests. An admission covers only the synchronous next batch. */
export async function serveOwnedStream<T>(req: Request, res: Response, dependencies: {
    userId: string
    authorize: (signal: AbortSignal) => Promise<OwnedStreamLease | null>
    subscribe: (listener: (event: T) => void) => () => void
    frame: (event: T) => string
    headers: Record<string, string>
    connected: string
    heartbeat: string
    heartbeatMs: number
    maxLifetimeMs?: number
    subscriptionErrorStatus?: (error: unknown) => number
}) {
    if (req.aborted || req.socket?.destroyed || res.destroyed || res.writableEnded) return
    if (typeof dependencies.userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(dependencies.userId)) return void res.status(401).json({ error: 'owned_stream_unavailable' })
    if ((users.get(dependencies.userId) ?? 0) >= OWNED_STREAM_MAX_PER_USER) return void res.status(429).json({ error: 'owned_stream_capacity' })
    if (total >= OWNED_STREAM_MAX_TOTAL) return void res.status(503).json({ error: 'owned_stream_capacity' })
    users.set(dependencies.userId, (users.get(dependencies.userId) ?? 0) + 1); total++
    const controller = new AbortController()
    let closed = false, opened = false, checking = false, ping = false
    let unsubscribe: (() => void) | undefined
    let review: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let expiresAt = Infinity
    const lifetimeEnd = Date.now() + (dependencies.maxLifetimeMs && Number.isFinite(dependencies.maxLifetimeMs) && dependencies.maxLifetimeMs > 0 ? dependencies.maxLifetimeMs : 30 * 60 * 1000)
    const queued: T[] = []
    const close = (status?: number) => {
        if (closed) return
        closed = true; controller.abort()
        clearTimeout(review); clearTimeout(expiry); clearInterval(heartbeat)
        queued.length = 0
        try { unsubscribe?.() } catch { /* Capacity is still released below. */ }
        const remaining = (users.get(dependencies.userId) ?? 1) - 1
        if (remaining > 0) users.set(dependencies.userId, remaining); else users.delete(dependencies.userId)
        total--
        req.off('close', disconnected); req.off('aborted', disconnected)
        res.off('close', disconnected); res.off('error', disconnected)
        try {
            if (!res.headersSent && status) res.status(status).json({ error: 'owned_stream_unavailable' })
            else res.end()
        } catch { /* Socket teardown never exposes provider errors. */ }
    }
    const disconnected = () => close()
    req.on('close', disconnected); req.on('aborted', disconnected)
    res.on('close', disconnected); res.on('error', disconnected)
    async function authorize() {
        if (closed || controller.signal.aborted || validating >= MAX_PARALLEL_VALIDATIONS) throw new Error('Owned stream admission unavailable.')
        const step = new AbortController()
        const signal = AbortSignal.any([controller.signal, step.signal])
        let timer: ReturnType<typeof setTimeout> | undefined
        let abort: (() => void) | undefined
        validating++
        // A noncooperative dependency keeps its slot until it actually finishes;
        // reconnects therefore cannot accumulate unlimited abandoned operations.
        const operation = (async () => {
            try { return await dependencies.authorize(signal) } finally { validating-- }
        })()
        try {
            const deadline = new Promise<never>((_, reject) => {
                abort = () => reject(new Error('Owned stream admission unavailable.'))
                if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
                timer = setTimeout(() => step.abort(), OWNED_STREAM_AUTH_TIMEOUT_MS)
            })
            const lease = await Promise.race([operation, deadline])
            if (closed || signal.aborted || !lease || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now()
                || lease.expiresAt > Date.now() + 12 * 60 * 60 * 1000 + 5000) return false
            expiresAt = Math.min(expiresAt, lease.expiresAt, lifetimeEnd)
            if (expiresAt <= Date.now()) return false
            clearTimeout(expiry)
            expiry = setTimeout(() => close(), Math.max(1, expiresAt - Date.now()))
            expiry.unref?.()
            return true
        } finally {
            clearTimeout(timer)
            if (abort) signal.removeEventListener('abort', abort)
            step.abort()
        }
    }
    function write(frame: string) {
        if (closed || controller.signal.aborted || Date.now() >= expiresAt) { close(); return false }
        // The only accepted wire data is the existing redacted signal format.
        // A slow reader never builds an unbounded queue of authorized frames.
        if (Buffer.byteLength(frame, 'utf8') > 4096 || !res.write(frame)) { close(); return false }
        return true
    }
    function scheduleReview() {
        clearTimeout(review)
        review = setTimeout(() => { void pump() }, OWNED_STREAM_REVIEW_MS)
        review.unref?.()
    }
    async function pump() {
        if (closed || checking || !opened) return
        checking = true
        try {
            if (!await authorize()) { close(); return }
            const frames = queued.splice(0)
            for (const event of frames) if (!write(dependencies.frame(event))) return
            if (ping) { ping = false; if (!write(dependencies.heartbeat)) return }
            scheduleReview()
        } catch { close() }
        finally {
            checking = false
            if (!closed && (queued.length || ping)) void pump()
        }
    }
    try {
        if (!await authorize()) { close(401); return }
        if (closed || req.aborted || req.socket?.destroyed || res.destroyed || res.writableEnded) { close(); return }
        let release: () => void
        try {
            release = dependencies.subscribe(event => {
                if (closed) return
                if (queued.length >= OWNED_STREAM_MAX_QUEUE) { close(); return }
                queued.push(event); void pump()
            })
        } catch (error) { close(dependencies.subscriptionErrorStatus?.(error) === 429 ? 429 : 503); return }
        unsubscribe = release
        if (closed) { release(); return }
        res.status(200)
        for (const [key, value] of Object.entries(dependencies.headers)) res.setHeader(key, value)
        res.flushHeaders?.(); opened = true
        if (!write(dependencies.connected)) return
        heartbeat = setInterval(() => { ping = true; void pump() }, dependencies.heartbeatMs)
        heartbeat.unref?.()
        scheduleReview()
        if (queued.length) void pump()
    } catch { close(503) }
}
