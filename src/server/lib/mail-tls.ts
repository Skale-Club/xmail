import { readFileSync, existsSync } from 'fs'

let cached: { key: Buffer; cert: Buffer } | null = null
let attempted = false

export function getMailTLSOptions(): { key: Buffer; cert: Buffer } | null {
    if (attempted) return cached
    attempted = true

    const certPath = process.env.MAIL_TLS_CERT_PATH
    const keyPath = process.env.MAIL_TLS_KEY_PATH

    if (!certPath || !keyPath) return null
    if (!existsSync(certPath) || !existsSync(keyPath)) {
        console.warn('[MAIL-TLS] MAIL_TLS_CERT_PATH/MAIL_TLS_KEY_PATH set but file not found')
        return null
    }

    try {
        cached = {
            cert: readFileSync(certPath),
            key: readFileSync(keyPath),
        }
        console.log('[MAIL-TLS] TLS certificate loaded')
        return cached
    } catch (err) {
        console.error('[MAIL-TLS] Failed to load TLS certificate:', (err as Error).message)
        return null
    }
}

export function hasMailTLS(): boolean {
    return getMailTLSOptions() !== null
}
