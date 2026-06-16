/**
 * MX receiver hardening guards for port 25.
 *
 *   • Per-IP connection rate-limit (sliding window)
 *   • Spamhaus DNSBL lookup with cache
 *   • Greylisting of envelope sender/recipient pairs
 *   • Header-level validation helpers
 *
 * All state is in-memory; acceptable for a single-container deploy.
 * Scale out later with Redis-backed storage if horizontal scaling is needed.
 */

import { promises as dns } from 'dns'
import { queryClient } from '../../db'

// ─── Connection rate limit ───────────────────────────────────────────────────

const connectsByIp = new Map<string, { count: number; windowStart: number }>()
const CONN_WINDOW_MS = 60_000
const CONN_MAX = 10

export function checkConnectRate(ip: string): boolean {
    const now = Date.now()
    const entry = connectsByIp.get(ip)
    if (!entry || now - entry.windowStart > CONN_WINDOW_MS) {
        connectsByIp.set(ip, { count: 1, windowStart: now })
        return true
    }
    if (entry.count >= CONN_MAX) return false
    entry.count += 1
    return true
}

// ─── Spamhaus DNSBL with cache ───────────────────────────────────────────────

const dnsblCache = new Map<string, { listed: boolean; at: number }>()
const DNSBL_TTL_MS = 60 * 60 * 1000

export async function isSpamhausListed(ip: string): Promise<boolean> {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false
    // Skip private ranges
    if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return false
    const p2 = parseInt(ip.split('.')[1] || '0')
    if (ip.startsWith('172.') && p2 >= 16 && p2 <= 31) return false

    const cached = dnsblCache.get(ip)
    if (cached && Date.now() - cached.at < DNSBL_TTL_MS) return cached.listed

    const reversed = ip.split('.').reverse().join('.')
    try {
        const answers = await dns.resolve4(`${reversed}.zen.spamhaus.org`)
        const listed = answers.some((answer) => /^127\.0\.0\.(2|3|4|5|6|7|10|11)$/.test(answer))
        dnsblCache.set(ip, { listed, at: Date.now() })
        return listed
    } catch {
        dnsblCache.set(ip, { listed: false, at: Date.now() })
        return false
    }
}

// ─── Greylisting ─────────────────────────────────────────────────────────────

const GREY_HOLD_MINUTES = 5
const GREY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Returns true if the sender/recipient pair should be greylisted (reject with 451 now).
 * Returns false if sufficient time has elapsed since first contact — accept.
 *
 * State is persisted in the `greylist` table so it survives container restarts.
 * Previously this lived in an in-memory Map that was wiped on every redeploy,
 * which meant a legit MTA's retry was treated as a fresh first contact and
 * greylisted forever (the message could never get through). The whole thing is
 * resolved in a single atomic UPSERT:
 *   - first contact          → row inserted with passed=false → greylist (451)
 *   - retry within hold       → passed stays false            → greylist (451)
 *   - retry after hold window → passed flips to true          → accept
 *
 * Fail-open: if the DB is unreachable we accept rather than block legit mail.
 */
export async function shouldGreylist(ip: string, from: string, to: string): Promise<boolean> {
    const sender = from.trim().toLowerCase() || ip
    const key = `${sender}|${to.trim().toLowerCase()}`
    try {
        const rows = await queryClient<{ passed: boolean }[]>`
            INSERT INTO greylist (key) VALUES (${key})
            ON CONFLICT (key) DO UPDATE
                SET last_seen = now(),
                    passed = greylist.passed
                        OR (now() - greylist.first_seen) >= (${GREY_HOLD_MINUTES} * interval '1 minute')
            RETURNING passed
        `
        // passed === true → enough time elapsed (or already cleared) → accept.
        return !(rows[0]?.passed ?? false)
    } catch (err) {
        console.error('[MX] greylist DB error, failing open:', (err as Error)?.message)
        return false
    }
}

// ─── Header validation ───────────────────────────────────────────────────────

export function hasValidFromHeader(parsed: { from: { address?: string | null } | null }): boolean {
    return !!parsed.from?.address && parsed.from.address.includes('@')
}

export function isDateTooOld(parsed: { date: Date | null }, maxAgeMs = 30 * 24 * 60 * 60 * 1000): boolean {
    if (!parsed.date) return false
    return Date.now() - parsed.date.getTime() > maxAgeMs
}

// ─── Periodic cleanup ────────────────────────────────────────────────────────

const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [ip, e] of connectsByIp) {
        if (now - e.windowStart > CONN_WINDOW_MS * 2) connectsByIp.delete(ip)
    }
    for (const [ip, e] of dnsblCache) {
        if (now - e.at > DNSBL_TTL_MS) dnsblCache.delete(ip)
    }
    // Evict stale greylist rows so the table doesn't grow unbounded. An expired
    // pair simply gets greylisted once more on its next contact — harmless.
    const ttlMinutes = Math.round(GREY_TTL_MS / 60_000)
    queryClient`
        DELETE FROM greylist WHERE last_seen < now() - (${ttlMinutes} * interval '1 minute')
    `.catch((err) => console.error('[MX] greylist cleanup error:', (err as Error)?.message))
}, 60 * 60 * 1000)
cleanup.unref()
