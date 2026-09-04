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

// ─── Own-host exemption for the connect-rate limit ───────────────────────────
//
// 2026-09 incident: 840 "Invalid greeting ... 421 4.7.0 Too many connections from your IP" over
// 7 days, 838 of them in one post-restart burst on 2026-09-02. Every one of those 421s was our
// OWN `checkConnectRate` below, rejecting our OWN warm-up mesh: mesh sends route between our own
// inboxes, every platform domain's MX points at this same server, and a drained post-restart
// backlog opens connections faster than CONN_MAX/CONN_WINDOW_MS allows. Nothing was permanently
// lost (the 4xx retry always won eventually) but the mesh was fighting itself.
//
// This is the connect-time sibling of `isOwnMeshSender` below, which exempts the same mesh from
// greylisting at RCPT TO. It can't be reused here: RCPT TO knows the envelope sender, so it can
// check an exact `email_accounts` match; `onConnect` fires before any sender is known, so the
// only signal available is the source IP. Hence a distinct exemption, keyed on IP instead.
//
// "Our own host" is three non-overlapping signals, all derived from configuration/DNS rather
// than a hardcoded literal:
//   - loopback (127.0.0.0/8, ::1) — a same-container process connecting via the loopback route.
//   - the Docker bridge range (172.16.0.0/12, where Docker allocates the default `bridge`
//     network and every user-defined network including `coolify`) — a container-to-container
//     hop that never leaves the host's internal networking.
//   - MAIL_HOST's currently-resolved public IP(s) — MAIL_HOST is the name our own MX/PTR records
//     point at (see CLAUDE.md "Mail identity"); this covers self-connections that hairpin back in
//     over the public interface rather than staying on loopback. Re-resolved periodically (see
//     `refreshOwnHostIpCache`) rather than resolved once at startup, so a host migration that
//     changes the A record doesn't leave a stale exemption (or a stale miss) in place forever.
//     Deliberately reuses the existing `MAIL_HOST` env var already wired into the container
//     (see build-deploy.yml's `run_app_container`) instead of introducing a new one.
//
// TRADE-OFF (be conservative reading this): this removes a DoS guard — the very thing this
// function exists for — for any traffic that *appears* to originate from our own IP. What still
// stands guard for everyone else: Spamhaus DNSBL (`isSpamhausListed`, right below, unaffected),
// greylisting for any sender that isn't an exact, currently-verified mesh account
// (`isOwnMeshSender`/`shouldGreylist`), and SPF/DKIM/DMARC alignment checked at DATA
// (`verifyInbound`, in mx-server.ts's `onData`) once the full message is available. An attacker
// cannot simply claim to be one of these IPs to ride this exemption: `session.remoteAddress` is
// populated from the actual TCP connection's source address at the kernel level, not from
// anything the client sends over the wire — to make the accepted connection's packets carry a
// forged source IP the attacker would need to complete the full TCP three-way handshake (SYN,
// SYN-ACK, ACK) as that forged address, which requires seeing the SYN-ACK (and its
// server-generated sequence number) in order to ACK it; that traffic is routed back toward the
// real owner of the claimed IP, not to the attacker. Blind (off-path) TCP sequence-number
// prediction to forge a fully-established connection this way is a known but now-impractical
// attack against modern OSes' randomized initial sequence numbers, and is a wholly different
// (and far harder) threat than the source-IP spoofing that works fine for connectionless UDP.

const DOCKER_BRIDGE_MIN_OCTET = 16 // Docker allocates bridge networks from 172.16.0.0/12
const DOCKER_BRIDGE_MAX_OCTET = 31

/** Strips an IPv4-mapped-IPv6 prefix ("::ffff:127.0.0.1" → "127.0.0.1") some Node dual-stack
 * sockets report; a no-op for anything else. */
function normalizeIp(ip: string): string {
    const lower = ip.toLowerCase()
    return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower
}

function isLoopbackIp(ip: string): boolean {
    return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')
}

function isDockerBridgeIp(ip: string): boolean {
    const match = /^172\.(\d{1,3})\./.exec(ip)
    if (!match) return false
    const second = Number(match[1])
    return second >= DOCKER_BRIDGE_MIN_OCTET && second <= DOCKER_BRIDGE_MAX_OCTET
}

/** Background-refreshed cache of MAIL_HOST's currently-resolved IPv4 address(es), read
 * synchronously by `isOwnHostIp` — connect-time checks must stay non-blocking, so this is never
 * looked up inline. Starts empty (so a slow/failed first resolution just means the public-IP
 * signal is unavailable yet; loopback/bridge checks are unaffected) and is populated by
 * `refreshOwnHostIpCache`. */
let ownHostIps = new Set<string>()

const OWN_HOST_REFRESH_MS = 5 * 60 * 1000

/** Re-resolves MAIL_HOST and replaces the cache. Exported so tests can await one resolution
 * deterministically instead of racing a background timer. On failure the PREVIOUS cache is left
 * untouched — a transient DNS blip must not silently revoke a working exemption (or, in the
 * inverse case, fabricate one from an empty cache misread as "not our IP"). */
export async function refreshOwnHostIpCache(): Promise<void> {
    const host = process.env.MAIL_HOST
    if (!host) return
    try {
        const addrs = await dns.resolve4(host)
        ownHostIps = new Set(addrs)
    } catch (err) {
        console.error('[MX] failed to resolve MAIL_HOST for own-host-IP exemption:', (err as Error)?.message)
    }
}

void refreshOwnHostIpCache()
const ownHostRefreshTimer = setInterval(() => { void refreshOwnHostIpCache() }, OWN_HOST_REFRESH_MS)
ownHostRefreshTimer.unref()

/**
 * Is `ip` this host itself — loopback, the Docker bridge range, or MAIL_HOST's currently-resolved
 * public IP? See the block comment above for what this is for and its trade-off.
 */
export function isOwnHostIp(ip: string): boolean {
    const normalized = normalizeIp(ip)
    if (isLoopbackIp(normalized)) return true
    if (isDockerBridgeIp(normalized)) return true
    return ownHostIps.has(normalized)
}

// ─── Connection rate limit ───────────────────────────────────────────────────

const connectsByIp = new Map<string, { count: number; windowStart: number }>()
const CONN_WINDOW_MS = 60_000
const CONN_MAX = 10

/**
 * Sliding-window per-IP connection cap. Exempts our own host entirely (see `isOwnHostIp` above)
 * — the exemption is checked first and short-circuits before touching `connectsByIp`, so our own
 * mesh traffic never even occupies a slot in the map, and every other IP is rate-limited exactly
 * as before.
 */
export function checkConnectRate(ip: string): boolean {
    if (isOwnHostIp(ip)) return true
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
