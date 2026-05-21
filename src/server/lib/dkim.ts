/**
 * DKIM signing config loader.
 *
 * Fetches a domain's DKIM private key + selector from the `domains` table
 * and returns a config object consumable by `nodemailer.createTransport({dkim: ...})`.
 *
 * Cached in-memory per domain; call `invalidateDkimCache(domain)` when the
 * admin rotates the key in the DB.
 */

import { db } from '../../db'
import { domains } from '../../db/schema'
import { eq } from 'drizzle-orm'

export interface DkimConfig {
    domainName: string
    keySelector: string
    privateKey: string
}

const cache = new Map<string, DkimConfig | null>()

/**
 * Look up the DKIM config for the sender of an email address.
 * Returns null (cached) if the domain has no DKIM key configured.
 */
export async function getDkimConfigForEmail(fromEmail: string): Promise<DkimConfig | null> {
    const host = fromEmail.split('@')[1]?.toLowerCase()
    if (!host) return null
    if (cache.has(host)) return cache.get(host)!

    const row = await db.query.domains.findFirst({
        where: eq(domains.name, host),
        columns: {
            name: true,
            dkimSelector: true,
            dkimPrivateKey: true,
            dkimStatus: true,
        },
    })

    if (!row?.dkimPrivateKey) {
        cache.set(host, null)
        return null
    }

    const config: DkimConfig = {
        domainName: row.name,
        keySelector: row.dkimSelector || 'skaleclub',
        privateKey: row.dkimPrivateKey,
    }
    cache.set(host, config)
    return config
}

/**
 * Invalidate cached config for a domain. Call when rotating DKIM keys.
 */
export function invalidateDkimCache(hostOrEmail: string): void {
    const host = hostOrEmail.includes('@')
        ? hostOrEmail.split('@')[1]?.toLowerCase()
        : hostOrEmail.toLowerCase()
    if (host) cache.delete(host)
}

/**
 * Build a nodemailer-compatible dkim option from a config.
 */
export function toNodemailerDkim(config: DkimConfig): {
    domainName: string
    keySelector: string
    privateKey: string
} {
    return {
        domainName: config.domainName,
        keySelector: config.keySelector,
        privateKey: config.privateKey,
    }
}
