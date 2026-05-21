/**
 * MX receiver hardening guards for port 25.
 *
 *   • Per-IP connection rate-limit (sliding window)
 *   • Spamhaus DNSBL lookup with cache
 *   • Greylisting of (IP, from, to) triples
 *   • Header-level validation helpers
 *
 * All state is in-memory; acceptable for a single-container deploy.
 * Scale out later with Redis-backed storage if horizontal scaling is needed.
 */

import { promises as dns } from 'dns'

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
        await dns.resolve4(`${reversed}.zen.spamhaus.org`)
        dnsblCache.set(ip, { listed: true, at: Date.now() })
        return true
    } catch {
        dnsblCache.set(ip, { listed: false, at: Date.now() })
        return false
    }
}

// ─── Greylisting ─────────────────────────────────────────────────────────────

const greylist = new Map<string, number>()
const GREY_HOLD_MS = 5 * 60 * 1000
const GREY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Returns true if the triple should be greylisted (reject with 451 now).
 * Returns false if sufficient time has elapsed since first contact — accept.
 */
export function shouldGreylist(ip: string, from: string, to: string): boolean {
    const key = `${ip}|${from.toLowerCase()}|${to.toLowerCase()}`
    const first = greylist.get(key)
    const now = Date.now()
    if (!first) {
        greylist.set(key, now)
        return true
    }
    return now - first < GREY_HOLD_MS
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
    for (const [k, t] of greylist) {
        if (now - t > GREY_TTL_MS) greylist.delete(k)
    }
    for (const [ip, e] of dnsblCache) {
        if (now - e.at > DNSBL_TTL_MS) dnsblCache.delete(ip)
    }
}, 60 * 60 * 1000)
cleanup.unref()
