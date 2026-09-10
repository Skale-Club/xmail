import { readFileSync, existsSync, statSync } from 'fs'
import * as tls from 'node:tls'

/**
 * How often a cached cert's mtime is re-checked. `getMailTLSOptions()`/`hasMailTLS()` are
 * called on hot paths (IMAP STARTTLS negotiation, IMAP CAPABILITY listing, a periodic
 * rotation-check interval in each mail server), so a stat() syscall on every single call
 * would be wasteful. Kept coarse enough that a renewed certificate (e.g. Let's Encrypt
 * renewal) is picked up well inside a typical cert's validity window, without a restart.
 */
const RECHECK_INTERVAL_MS = 60_000

interface LoadedCert {
    key: Buffer
    cert: Buffer
    certPath: string
    keyPath: string
    certMtimeMs: number
    keyMtimeMs: number
}

let cached: LoadedCert | null = null
// 0 means "never checked" — distinct from a real timestamp so the very first call (and any
// call right after resetMailTLSCache()) always does a full scan regardless of the interval.
let lastCheckedAt = 0
let secureContextCache: { ctx: tls.SecureContext; certMtimeMs: number; keyMtimeMs: number } | null = null

/**
 * Candidate TLS certificate locations in priority order.
 *
 * 1. Explicitly configured via MAIL_TLS_CERT_PATH / MAIL_TLS_KEY_PATH env vars.
 * 2. Coolify / Traefik stores ACME certs dumped as PEM files under
 *    /data/coolify/proxy/certs/ (common path when using traefik-certs-dumper
 *    or Coolify's own cert-dump sidecar).
 * 3. Standard certbot / Let's Encrypt paths for the MAIL_HOST domain.
 * 4. Standard certbot path for the MAIL_DOMAIN apex domain.
 *
 * Add more entries below if your environment stores certs elsewhere.
 */
function candidatePaths(): Array<{ cert: string; key: string; label: string }> {
    const mailHost = process.env.MAIL_HOST || 'mx.skale.club'
    const mailDomain = process.env.MAIL_DOMAIN || 'skale.club'

    const candidates: Array<{ cert: string; key: string; label: string }> = []

    // --- Explicitly configured (highest priority) ---
    const cfgCert = process.env.MAIL_TLS_CERT_PATH
    const cfgKey = process.env.MAIL_TLS_KEY_PATH
    if (cfgCert && cfgKey) {
        candidates.push({ cert: cfgCert, key: cfgKey, label: 'configured env' })
    }

    // --- Coolify / Traefik dumped PEM certs ---
    // traefik-certs-dumper writes per-domain files to /data/coolify/proxy/certs/
    candidates.push(
        {
            cert: `/data/coolify/proxy/certs/${mailHost}.crt`,
            key:  `/data/coolify/proxy/certs/${mailHost}.key`,
            label: `coolify-traefik (${mailHost})`,
        },
        {
            cert: `/data/coolify/proxy/certs/${mailDomain}.crt`,
            key:  `/data/coolify/proxy/certs/${mailDomain}.key`,
            label: `coolify-traefik (${mailDomain})`,
        },
        // Some Coolify versions use fullchain.pem / privkey.pem naming
        {
            cert: `/data/coolify/proxy/certs/${mailHost}/fullchain.pem`,
            key:  `/data/coolify/proxy/certs/${mailHost}/privkey.pem`,
            label: `coolify-traefik-pem (${mailHost})`,
        },
    )

    // --- Standard Let's Encrypt / certbot ---
    candidates.push(
        {
            cert: `/etc/letsencrypt/live/${mailHost}/fullchain.pem`,
            key:  `/etc/letsencrypt/live/${mailHost}/privkey.pem`,
            label: `letsencrypt (${mailHost})`,
        },
        {
            cert: `/etc/letsencrypt/live/${mailDomain}/fullchain.pem`,
            key:  `/etc/letsencrypt/live/${mailDomain}/privkey.pem`,
            label: `letsencrypt (${mailDomain})`,
        },
    )

    return candidates
}

function loadFromCandidates(): LoadedCert | null {
    const paths = candidatePaths()

    for (const { cert: certPath, key: keyPath, label } of paths) {
        if (!existsSync(certPath) || !existsSync(keyPath)) continue

        try {
            const certStat = statSync(certPath)
            const keyStat = statSync(keyPath)
            const loaded: LoadedCert = {
                cert: readFileSync(certPath),
                key: readFileSync(keyPath),
                certPath,
                keyPath,
                certMtimeMs: certStat.mtimeMs,
                keyMtimeMs: keyStat.mtimeMs,
            }
            console.log(`[MAIL-TLS] Certificate loaded from: ${label} (${certPath})`)
            return loaded
        } catch (err) {
            console.warn(`[MAIL-TLS] Found cert at ${label} but failed to read:`, (err as Error).message)
        }
    }

    // Log all paths that were tried so it's easy to diagnose missing certs
    const tried = paths.map(p => `\n  [${p.label}]\n    cert: ${p.cert}\n    key:  ${p.key}`).join('')
    console.warn('[MAIL-TLS] No TLS certificate found. Mail servers will run in plaintext (dev) mode.')
    console.warn(`[MAIL-TLS] Paths tried:${tried}`)
    console.warn('[MAIL-TLS] To fix: set MAIL_TLS_CERT_PATH and MAIL_TLS_KEY_PATH, or place certs at one of the paths above.')

    return null
}

/**
 * Returns the currently active cert/key pair, reloading from disk when the files backing
 * the cached copy have changed mtime (e.g. a Let's Encrypt renewal replaced them in place).
 * Re-stats at most once per RECHECK_INTERVAL_MS; within that window the cached bytes are
 * returned unconditionally with no filesystem access at all. This is what lets a certificate
 * rotate without restarting the process — every caller (the three mail servers' TLS setup,
 * plus their periodic rotation-check intervals) goes through this one function.
 */
export function getMailTLSOptions(): { key: Buffer; cert: Buffer } | null {
    const now = Date.now()
    if (lastCheckedAt !== 0 && now - lastCheckedAt < RECHECK_INTERVAL_MS) {
        return cached ? { key: cached.key, cert: cached.cert } : null
    }
    lastCheckedAt = now

    if (cached) {
        try {
            const certStat = statSync(cached.certPath)
            const keyStat = statSync(cached.keyPath)
            if (certStat.mtimeMs === cached.certMtimeMs && keyStat.mtimeMs === cached.keyMtimeMs) {
                return { key: cached.key, cert: cached.cert }
            }
            console.log(`[MAIL-TLS] Certificate file changed on disk (${cached.certPath}) — reloading`)
        } catch (err) {
            console.warn('[MAIL-TLS] Cached certificate path became unreadable, rescanning candidates:', (err as Error).message)
        }
    }

    cached = loadFromCandidates()
    return cached ? { key: cached.key, cert: cached.cert } : null
}

export function hasMailTLS(): boolean {
    return getMailTLSOptions() !== null
}

/** Force re-detection on next call (e.g. after cert renewal, or between test cases). */
export function resetMailTLSCache(): void {
    cached = null
    lastCheckedAt = 0
    secureContextCache = null
}

/**
 * Returns a `tls.SecureContext` built from the current key/cert, cached by the same mtime
 * pair `getMailTLSOptions()` tracks so repeated calls (a per-connection SNICallback, or a
 * periodic rotation-check interval) don't rebuild the context when nothing has changed.
 * Returns null when no certificate is configured (dev/plaintext mode).
 */
export function getMailTLSSecureContext(): tls.SecureContext | null {
    const opts = getMailTLSOptions()
    if (!opts || !cached) return null

    if (
        secureContextCache &&
        secureContextCache.certMtimeMs === cached.certMtimeMs &&
        secureContextCache.keyMtimeMs === cached.keyMtimeMs
    ) {
        return secureContextCache.ctx
    }

    const ctx = tls.createSecureContext({ key: opts.key, cert: opts.cert })
    secureContextCache = { ctx, certMtimeMs: cached.certMtimeMs, keyMtimeMs: cached.keyMtimeMs }
    return ctx
}
