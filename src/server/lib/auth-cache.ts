import { createHash } from 'node:crypto'
import { supabaseAnonClient } from './supabase'

// SEC-03 — see .planning/debug/system-wide-audit-2026-05-16.md H7
// In-process LRU+TTL cache of sha256(token) -> resolved user.
// Cuts the per-request supabaseAnonClient.auth.getUser round-trip on the
// /api auth middleware (src/server/index.ts).

const TTL_MS = 60_000        // 60s — matches Phase 11 CONTEXT decision
const MAX_ENTRIES = 5000     // CONTEXT.md decision

type CompactUser = {
    id: string
    email: string | null
    firstName: string
    lastName: string
    emailVerified: boolean
}

type Entry = {
    user: CompactUser
    expiresAt: number
}

type ResolveResult = {
    user: CompactUser | null
    error: string | null
    fromCache: boolean
}

const cache = new Map<string, Entry>()                                   // key = sha256(token) hex
const inflight = new Map<string, Promise<{ user: CompactUser | null; error: string | null }>>()

let hits = 0
let misses = 0
const isDev = process.env.NODE_ENV !== 'production'

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

function evictExpired(now: number): void {
    // Lightweight pass — only runs on miss path
    for (const [k, v] of cache) {
        if (v.expiresAt <= now) cache.delete(k)
    }
}

function evictLRUIfFull(): void {
    if (cache.size < MAX_ENTRIES) return
    // Drop oldest insertion (Map preserves insertion order — ES2015+ guarantee)
    const firstKey = cache.keys().next().value
    if (firstKey) cache.delete(firstKey)
}

export async function resolveUserFromToken(token: string): Promise<ResolveResult> {
    const key = hashToken(token)
    const now = Date.now()

    // Cache hit
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now) {
        hits++
        maybeLogStats()
        return { user: cached.user, error: null, fromCache: true }
    }

    misses++

    // In-flight dedup — share a single Supabase call for identical concurrent tokens
    const existing = inflight.get(key)
    if (existing) {
        const r = await existing
        maybeLogStats()
        return { user: r.user, error: r.error, fromCache: false }
    }

    const p = (async () => {
        const { data, error } = await supabaseAnonClient.auth.getUser(token)
        if (error || !data?.user) {
            return { user: null, error: error?.message ?? 'Invalid or expired token' }
        }
        const u = data.user
        const compact: CompactUser = {
            id: u.id,
            email: u.email ?? null,
            firstName: (u.user_metadata?.firstName as string | undefined) ?? '',
            lastName: (u.user_metadata?.lastName as string | undefined) ?? '',
            emailVerified: Boolean(u.email_confirmed_at || (u as { confirmed_at?: string | null }).confirmed_at),
        }
        // Cache successes only — never cache 401s (token could be revoked / rotated rapidly)
        evictExpired(now)
        evictLRUIfFull()
        cache.set(key, { user: compact, expiresAt: now + TTL_MS })
        return { user: compact, error: null }
    })()

    inflight.set(key, p)
    try {
        const r = await p
        maybeLogStats()
        return { ...r, fromCache: false }
    } finally {
        inflight.delete(key)
    }
}

function maybeLogStats(): void {
    if (!isDev) return
    const total = hits + misses
    if (total > 0 && total % 100 === 0) {
        const hitRate = ((hits / total) * 100).toFixed(1)
        console.log(`[auth-cache] ${total} lookups, hit-rate=${hitRate}% (hits=${hits} misses=${misses}, size=${cache.size})`)
    }
}

export function getAuthCacheStats(): { hits: number; misses: number; size: number; ttlMs: number } {
    return { hits, misses, size: cache.size, ttlMs: TTL_MS }
}
