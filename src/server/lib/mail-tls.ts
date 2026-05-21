import { readFileSync, existsSync } from 'fs'

let cached: { key: Buffer; cert: Buffer } | null = null
let attempted = false

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

export function getMailTLSOptions(): { key: Buffer; cert: Buffer } | null {
    if (attempted) return cached
    attempted = true

    const paths = candidatePaths()

    for (const { cert: certPath, key: keyPath, label } of paths) {
        if (!existsSync(certPath) || !existsSync(keyPath)) continue

        try {
            cached = {
                cert: readFileSync(certPath),
                key:  readFileSync(keyPath),
            }
            console.log(`[MAIL-TLS] Certificate loaded from: ${label} (${certPath})`)
            return cached
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

export function hasMailTLS(): boolean {
    return getMailTLSOptions() !== null
}

/** Force re-detection on next call (e.g. after cert renewal). */
export function resetMailTLSCache(): void {
    cached = null
    attempted = false
}
