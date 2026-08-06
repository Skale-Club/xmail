import { promises as dnsPromises } from 'node:dns'

// Shared, configurable DNS resolver (Phase: verification-gates DNS-01). Extracted from
// routes/domains.ts so other modules (e.g. the recipient MX pre-filter) can reuse the same
// resolver instance/config instead of duplicating it. Behavior is unchanged from the original
// domains.ts helpers: every lookup swallows errors and resolves to an empty array, matching what
// domain-verification callers there have always expected.
export const resolver = new dnsPromises.Resolver()
resolver.setServers((process.env.DNS_SERVERS || '8.8.8.8,1.1.1.1').split(','))

export async function resolveTxt(hostname: string): Promise<string[]> {
    try {
        const records = await resolver.resolveTxt(hostname)
        return records.map((chunks) => chunks.join(''))
    } catch {
        return []
    }
}

export async function resolveMx(hostname: string): Promise<{ exchange: string; priority: number }[]> {
    try {
        return await resolver.resolveMx(hostname)
    } catch {
        return []
    }
}

export async function resolveCname(hostname: string): Promise<string[]> {
    try {
        return await resolver.resolveCname(hostname)
    } catch {
        return []
    }
}
