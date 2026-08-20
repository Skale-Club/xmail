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

// ─── Own-mesh sender exemption ────────────────────────────────────────────────

/**
 * Is `from` one of the platform's own, currently-verified mailboxes?
 *
 * The warm-up mesh (processWarmup.ts) sends between accounts we provision and verify, and every
 * platform domain's MX record points at this same server (mx.skale.club) — so the mesh greylists
 * itself on every new sender/recipient pair (see `shouldGreylist` below). This predicate is the
 * exemption gate; the call site is `mx-server.ts`'s `onRcptTo`, kept next to the pre-existing
 * `hasDeliveredFromSender` exemption rather than folded into `shouldGreylist` itself, so
 * `shouldGreylist` stays a pure "has enough time elapsed" policy and every "who gets to skip
 * this" decision lives in one place at the call site.
 *
 * "Our own" is checked against an EXACT, case-insensitive match on a currently `verified`
 * `email_accounts.email` row — not domain membership. A domain-only check (does `from`'s domain
 * appear in `domains`?) would exempt a forged `MAIL FROM` using any invented local-part under a
 * domain we own: our domains and their MX records are public DNS, and RCPT TO happens before
 * SPF/DKIM/DMARC are evaluated (`verifyInbound` only runs later, in `onData`, once the body is
 * available) — so nothing at this stage tells a genuine mesh sender apart from a stranger who
 * merely typed one of our domains after the `@`. Requiring an exact match against a real,
 * presently-verified account is a materially narrower target: the forger has to already know one
 * specific active internal address, and the exemption disappears automatically the moment that
 * mailbox is deprovisioned or falls out of `verified` status.
 *
 * The connecting IP is intentionally NOT part of this gate, even though it is available to the
 * caller. Mesh accounts originate from heterogeneous infrastructure: native accounts direct-
 * deliver from this same host (outbound-transport.ts), but SMTP-provider mesh accounts relay
 * through their own provider's servers (Gmail's, Outlook's, ...) and connect from THAT provider's
 * outbound IPs, not ours. There is no single "our IP" to pin the exemption to without either
 * rejecting legitimate mesh traffic from non-native accounts or the pin doing nothing. The caller
 * still logs the IP on exemption for observability, per the SEC review that flagged this class of
 * self-exemption as worth watching.
 *
 * Fails closed: a DB error here denies the exemption, so on error a legit mesh message just waits
 * out the normal greylist hold like any other new pair — never silently bypasses it.
 */
export async function isOwnMeshSender(from: string): Promise<boolean> {
    const address = from.trim().toLowerCase()
    if (!address || !address.includes('@')) return false
    try {
        const rows = await queryClient<{ id: string }[]>`
            SELECT id FROM email_accounts
            WHERE lower(email) = ${address} AND status = 'verified'
            LIMIT 1
        `
        return rows.length > 0
    } catch (err) {
        console.error('[MX] own-mesh-sender lookup error, failing closed (not exempt):', (err as Error)?.message)
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
