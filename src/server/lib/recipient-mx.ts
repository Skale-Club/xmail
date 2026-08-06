import { resolver } from './dns-resolver'

// Free recipient-domain MX pre-filter (step 4, verification-gates). Distinct from
// dns-resolver.ts's resolveMx: that helper swallows every error into `[]`, which conflates
// "domain definitively has no MX" with "DNS lookup failed/timed out" — a distinction this module
// must preserve so a transient resolver failure never marks a lead invalid (fail open).

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour — recipient domains repeat constantly across leads.
const CACHE_MAX_ENTRIES = 5_000

interface CacheEntry {
    value: boolean | null
    expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function normalizeDomain(domain: string): string {
    return domain.trim().toLowerCase()
}

function isDefinitiveNoRecordError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    // ENOTFOUND / ENODATA are Node's answer for "this name has no records of the requested
    // type" (NXDOMAIN / NODATA) — a real, authoritative negative. Anything else (ETIMEOUT,
    // ESERVFAIL, ECONNREFUSED, ...) is an inconclusive lookup failure, not a verdict.
    return code === 'ENOTFOUND' || code === 'ENODATA'
}

async function lookupMx(domain: string): Promise<boolean | null> {
    try {
        const records = await resolver.resolveMx(domain)
        return records.length > 0
    } catch (error) {
        if (isDefinitiveNoRecordError(error)) return false
        return null
    }
}

function rememberInCache(key: string, value: boolean | null): void {
    if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
        const oldestKey = cache.keys().next().value
        if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

/**
 * Whether `domain` has at least one MX record.
 *
 * - `true`  — the domain resolves at least one MX record.
 * - `false` — the domain has a definitive "no MX record" DNS answer (NXDOMAIN/NODATA).
 * - `null`  — the lookup failed or timed out; callers MUST treat this as "unknown" and never
 *   downgrade a lead's verification status on it. Never let a DNS failure mark something invalid.
 *
 * Results are cached in-memory for ~1 hour, capped at CACHE_MAX_ENTRIES entries.
 */
export async function hasMxRecord(domain: string): Promise<boolean | null> {
    const key = normalizeDomain(domain)
    if (!key) return null

    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const value = await lookupMx(key)
    rememberInCache(key, value)
    return value
}
