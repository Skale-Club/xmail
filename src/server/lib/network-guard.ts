// SEC-01 — see .planning/debug/system-wide-audit-2026-05-16.md H1/H3/H6
// Centralized SSRF guard. Replaces scattered isPrivateHost copies in:
//   - src/server/routes/track.ts (click handler)
//   - src/server/routes/mail/mailboxes.ts (test-connection)
// Used by:
//   - src/server/routes/webhooks.ts (POST / and PATCH /:id — uses async DNS variant)
import { promises as dns } from 'node:dns'
import net from 'node:net'

const METADATA_HOSTS = new Set([
    'localhost',
    'metadata.google.internal',
    'metadata',
    'instance-data',
    'instance-data.ec2.internal',
])

export const PRIVATE_HOST_REASONS = {
    loopback: 'loopback address',
    private: 'private network address (RFC1918)',
    linkLocal: 'link-local address',
    cgnat: 'carrier-grade NAT address',
    multicast: 'multicast address',
    unspecified: 'unspecified address',
    ula: 'IPv6 unique local address',
    ipv6LinkLocal: 'IPv6 link-local address',
    metadata: 'cloud metadata host',
    dnsFailed: 'host could not be resolved',
    timeout: 'DNS resolution timed out',
} as const

// SEC-01 — IPv4 RFC1918, loopback, 169.254/16, 100.64/10, 224/4, 0/8
function ipv4IsPrivate(ip: string): boolean {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
    const [a, b] = parts
    if (a === 0) return true                                     // 0.0.0.0/8 (incl. 0.0.0.0)
    if (a === 127) return true                                   // 127.0.0.0/8 loopback
    if (a === 10) return true                                    // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true             // 172.16.0.0/12
    if (a === 192 && b === 168) return true                      // 192.168.0.0/16
    if (a === 169 && b === 254) return true                      // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true            // 100.64.0.0/10 CGNAT
    if (a >= 224 && a <= 239) return true                        // 224.0.0.0/4 multicast
    if (a >= 240) return true                                    // 240.0.0.0/4 reserved
    return false
}

// Normalize IPv6 (or "::ffff:1.2.3.4" hybrid) into a flat 32-hex-char string.
// Returns null when the input cannot be parsed.
function expandIPv6(ip: string): string | null {
    let s = ip.toLowerCase()
    // Strip surrounding brackets (caller may pass URL hostname which is already unbracketed,
    // but be defensive).
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)

    // Detect embedded IPv4 (e.g. ::ffff:1.2.3.4) — convert tail to two hex groups.
    const lastColon = s.lastIndexOf(':')
    if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
        const v4 = s.slice(lastColon + 1)
        const v4Parts = v4.split('.').map(Number)
        if (v4Parts.length !== 4 || v4Parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
        const hi = ((v4Parts[0] << 8) | v4Parts[1]).toString(16)
        const lo = ((v4Parts[2] << 8) | v4Parts[3]).toString(16)
        s = s.slice(0, lastColon + 1) + hi + ':' + lo
    }

    // Expand "::" — split into head and tail, pad missing groups with zeros.
    let head: string[]
    let tail: string[]
    if (s.includes('::')) {
        const [h, t] = s.split('::')
        head = h ? h.split(':') : []
        tail = t ? t.split(':') : []
        const missing = 8 - head.length - tail.length
        if (missing < 0) return null
        const zeros = Array(missing).fill('0')
        head = [...head, ...zeros, ...tail]
    } else {
        head = s.split(':')
    }

    if (head.length !== 8) return null
    const padded = head.map((g) => {
        if (g.length > 4 || !/^[0-9a-f]*$/.test(g)) return null
        return g.padStart(4, '0')
    })
    if (padded.some((g) => g === null)) return null
    return padded.join('')
}

// SEC-01 — IPv6 ::1, ::, fc00::/7 (ULA), fe80::/10 (link-local), IPv4-mapped delegates to v4.
function ipv6IsPrivate(ip: string): boolean {
    const expanded = expandIPv6(ip)
    if (!expanded) return false

    // ::ffff:0:0/96  — IPv4-mapped → check embedded IPv4 against ipv4IsPrivate.
    if (expanded.startsWith('0'.repeat(20) + 'ffff')) {
        const v4Hi = parseInt(expanded.slice(24, 28), 16)
        const v4Lo = parseInt(expanded.slice(28, 32), 16)
        const v4 = `${(v4Hi >> 8) & 0xff}.${v4Hi & 0xff}.${(v4Lo >> 8) & 0xff}.${v4Lo & 0xff}`
        return ipv4IsPrivate(v4)
    }

    // ::1 loopback
    if (expanded === '0'.repeat(31) + '1') return true
    // :: unspecified
    if (expanded === '0'.repeat(32)) return true

    // fc00::/7 — first 7 bits = 1111 110x → first byte 0xfc or 0xfd
    const firstByte = parseInt(expanded.slice(0, 2), 16)
    if ((firstByte & 0xfe) === 0xfc) return true

    // fe80::/10 — first 10 bits = 1111 1110 10 → first byte 0xfe AND second nibble of byte 2 high-bit 10xx
    // first 16 bits must satisfy: 0xfe80..0xfebf
    const first16 = parseInt(expanded.slice(0, 4), 16)
    if (first16 >= 0xfe80 && first16 <= 0xfebf) return true

    return false
}

/**
 * Sync check: returns true if `host` is a known private/internal IP literal or metadata hostname.
 *
 * NOTE: bare hostnames (non-IP) return false here — caller must use isPrivateHostWithDns
 * for SSRF-critical paths to avoid DNS rebinding bypass.
 */
export function isPrivateHost(host: string): boolean {
    if (!host) return false
    const h = host.toLowerCase().trim()
    if (METADATA_HOSTS.has(h)) return true
    const kind = net.isIP(h)
    if (kind === 4) return ipv4IsPrivate(h)
    if (kind === 6) return ipv6IsPrivate(h)
    return false
}

/**
 * Async, DNS-resolving variant: rebinding-safe.
 *
 * - If `host` is already an IP literal → delegates to isPrivateHost (no DNS).
 * - Otherwise resolves both A and AAAA records and rejects if ANY resolved IP is private.
 * - If neither resolution returns any IP → returns true (fail-closed: unresolvable hosts
 *   cannot be safely used in SSRF-sensitive write paths).
 * - 2s wall-clock timeout via Promise.race; timeout → returns true (fail-closed).
 */
export async function isPrivateHostWithDns(host: string): Promise<boolean> {
    if (!host) return true
    const h = host.toLowerCase().trim()
    if (METADATA_HOSTS.has(h)) return true
    const kind = net.isIP(h)
    if (kind) return isPrivateHost(h)

    const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 2000)
    })

    const dnsPromise = (async () => {
        const results = await Promise.allSettled([dns.resolve4(h), dns.resolve6(h)])
        const ips: string[] = []
        for (const r of results) {
            if (r.status === 'fulfilled') ips.push(...r.value)
        }
        if (ips.length === 0) return true  // fail-closed — unresolvable
        return ips.some((ip) => isPrivateHost(ip))
    })().catch(() => true)

    return Promise.race([dnsPromise, timeoutPromise])
}
