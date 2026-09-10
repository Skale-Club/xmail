/**
 * Route Matcher for Inbound Email
 *
 * Matches incoming email recipients against configured routes.
 * Supports wildcard patterns:
 *   - *@domain.com    — matches any local part on the domain
 *   - user@*          — matches the user on any domain
 *   - *               — matches everything
 *   - exact address   — exact match
 */

import { db } from '../../db'
import { routes, smtpEndpoints, httpEndpoints, addressEndpoints, domains } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { decryptSecret } from './crypto'
import nodemailer from 'nodemailer'
import { sendOutbound } from './outbound-transport'
import { v4 as uuidv4 } from 'uuid'
import { messages } from '../../db/schema'
import { incrementStat } from './tracking'
import { isPrivateHostWithDns } from './network-guard'

// SEC-01 — SSRF guard for inbound-route HTTP forwarding. Mirrors the write-time check in
// routes.ts / webhooks.ts (isPrivateHostWithDns), plus the redirect/timeout hardening used by
// webhooks.ts's dispatch fetch and tracking.ts's fireWebhooks. 10s matches the webhook dispatch
// timeout (see routes/webhooks.ts, lib/tracking.ts) rather than the old 30s here, which was never
// SSRF-hardened to begin with.
const HTTP_ROUTE_FETCH_TIMEOUT_MS = 10_000

export interface MatchedRoute {
    route: typeof routes.$inferSelect
    endpoint: {
        type: 'smtp' | 'http' | 'address' | 'hold' | 'reject'
        config: Record<string, unknown> | null
    }
}

/**
 * Check if a recipient address matches a route pattern.
 */
function addressMatchesPattern(address: string, pattern: string): boolean {
    const normalizedAddress = address.toLowerCase().trim()
    const normalizedPattern = pattern.toLowerCase().trim()

    if (normalizedPattern === '*') return true

    const [addrLocal, addrDomain] = normalizedAddress.split('@')
    const patternParts = normalizedPattern.split('@')

    if (patternParts.length === 1) {
        // No @ — treat as domain-only pattern
        return addrDomain === normalizedPattern
    }

    const [patternLocal, patternDomain] = patternParts

    const localMatch = patternLocal === '*' || patternLocal === addrLocal
    const domainMatch = patternDomain === '*' || patternDomain === addrDomain

    return localMatch && domainMatch
}

/**
 * Find matching routes for a recipient address within an organization.
 */
export async function findMatchingRoutes(
    organizationId: string,
    recipientAddress: string
): Promise<MatchedRoute[]> {
    const orgRoutes = await db.query.routes.findMany({
        where: eq(routes.organizationId, organizationId),
    })

    const matched: MatchedRoute[] = []

    for (const route of orgRoutes) {
        if (!addressMatchesPattern(recipientAddress, route.address)) {
            continue
        }

        let endpoint: MatchedRoute['endpoint'] = {
            type: route.mode === 'endpoint' ? 'smtp' : route.mode,
            config: null,
        }

        if (route.mode === 'endpoint') {
            if (route.smtpEndpointId) {
                const smtpEp = await db.query.smtpEndpoints.findFirst({
                    where: eq(smtpEndpoints.id, route.smtpEndpointId),
                })
                if (smtpEp) {
                    let password: string | null = null
                    if (smtpEp.passwordEncrypted) {
                        try {
                            password = decryptSecret(smtpEp.passwordEncrypted)
                        } catch {
                            password = null
                        }
                    } else if (smtpEp.password) {
                        // Legacy plaintext — kept for rows not yet backfilled
                        password = smtpEp.password
                    }
                    endpoint = {
                        type: 'smtp',
                        config: {
                            hostname: smtpEp.hostname,
                            port: smtpEp.port,
                            sslMode: smtpEp.sslMode,
                            username: smtpEp.username,
                            password,
                        },
                    }
                }
            } else if (route.httpEndpointId) {
                const httpEp = await db.query.httpEndpoints.findFirst({
                    where: eq(httpEndpoints.id, route.httpEndpointId),
                })
                if (httpEp) {
                    endpoint = {
                        type: 'http',
                        config: {
                            url: httpEp.url,
                            method: httpEp.method,
                            headers: httpEp.headers,
                            includeOriginal: httpEp.includeOriginal,
                        },
                    }
                }
            } else if (route.addressEndpointId) {
                const addrEp = await db.query.addressEndpoints.findFirst({
                    where: eq(addressEndpoints.id, route.addressEndpointId),
                })
                if (addrEp) {
                    endpoint = {
                        type: 'address',
                        config: {
                            emailAddress: addrEp.emailAddress,
                        },
                    }
                }
            }
        }

        matched.push({ route, endpoint })
    }

    return matched
}

/**
 * Check if a domain is registered in any organization for inbound routing.
 * Returns the organizationId if found.
 */
export async function findOrganizationForDomain(emailDomain: string): Promise<string | null> {
    const domain = await db.query.domains.findFirst({
        where: and(
            eq(domains.name, emailDomain.toLowerCase()),
            eq(domains.verificationStatus, 'verified')
        ),
    })

    return domain?.organizationId ?? null
}

/**
 * Process inbound email through route matching.
 * Returns delivery actions to take.
 */
export async function processInboundEmail(
    recipientAddress: string
): Promise<{
    organizationId: string | null
    routes: MatchedRoute[]
    action: 'deliver' | 'hold' | 'reject' | 'none'
}> {
    const domain = recipientAddress.split('@')[1]?.toLowerCase()
    if (!domain) {
        console.log(`[RouteMatcher] processInboundEmail("${recipientAddress}") → NO DOMAIN`)
        return { organizationId: null, routes: [], action: 'none' }
    }

    console.log(`[RouteMatcher] processInboundEmail("${recipientAddress}") → checking domain "${domain}"...`)

    const organizationId = await findOrganizationForDomain(domain)
    if (!organizationId) {
        console.log(`[RouteMatcher] processInboundEmail("${recipientAddress}") → domain "${domain}" has NO ORG (not verified or not registered)`)
        return { organizationId: null, routes: [], action: 'none' }
    }

    console.log(`[RouteMatcher] processInboundEmail("${recipientAddress}") → orgId=${organizationId}, checking routes...`)

    const matchedRoutes = await findMatchingRoutes(organizationId, recipientAddress)

    if (matchedRoutes.length === 0) {
        console.log(`[RouteMatcher] processInboundEmail("${recipientAddress}") → NO MATCHING ROUTES → action=none`)
        return { organizationId, routes: [], action: 'none' }
    }

    console.log(`[RouteMatcher] processInboundEmail("${recipientAddress}") → ${matchedRoutes.length} route(s) matched:`, matchedRoutes.map(r => `${r.route.name}(${r.endpoint.type})`))

    // If any route rejects, reject the entire message
    if (matchedRoutes.some((r) => r.endpoint.type === 'reject')) {
        console.log(`[RouteMatcher] → action=REJECT`)
        return { organizationId, routes: matchedRoutes, action: 'reject' }
    }

    // If any route holds, hold the message
    if (matchedRoutes.some((r) => r.endpoint.type === 'hold')) {
        console.log(`[RouteMatcher] → action=HOLD`)
        return { organizationId, routes: matchedRoutes, action: 'hold' }
    }

    console.log(`[RouteMatcher] → action=DELIVER`)
    return { organizationId, routes: matchedRoutes, action: 'deliver' }
}

/**
 * Forward an inbound message to a route's configured HTTP endpoint.
 *
 * SEC-01 — fails closed on the SSRF guard: a private/internal host, or a DNS check that itself
 * throws, both refuse the fetch rather than proceeding. Never throws — every failure path is
 * logged (under the `[RouteMatcher]` prefix ops already greps for, see CLAUDE.md "Logs") and
 * swallowed, so one bad endpoint never blocks the rest of the matched routes in the same message
 * (this was the MX-local copy's behaviour before it was consolidated into this canonical function).
 */
async function deliverHttpRoute(
    recipient: string,
    rawEmail: Buffer,
    routeName: string,
    cfg: { url: string; method?: string; headers?: Record<string, string>; includeOriginal?: boolean },
): Promise<void> {
    let hostname: string
    try {
        hostname = new URL(cfg.url).hostname
    } catch {
        console.error(`[RouteMatcher] HTTP route delivery blocked: route="${routeName}" url="${cfg.url}" reason="invalid URL"`)
        return
    }

    let isPrivate: boolean
    try {
        isPrivate = await isPrivateHostWithDns(hostname)
    } catch (dnsErr) {
        // Fail closed: a DNS check that throws is treated the same as a resolved private host.
        console.error(`[RouteMatcher] HTTP route delivery blocked: route="${routeName}" url="${cfg.url}" reason="DNS check failed: ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}"`)
        return
    }
    if (isPrivate) {
        console.error(`[RouteMatcher] HTTP route delivery blocked: route="${routeName}" url="${cfg.url}" reason="resolves to a private/internal host"`)
        return
    }

    const body = cfg.includeOriginal
        ? { recipient, raw: rawEmail.toString('base64') }
        : { recipient }

    try {
        const response = await fetch(cfg.url, {
            method: cfg.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...(cfg.headers || {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(HTTP_ROUTE_FETCH_TIMEOUT_MS),
            // SEC — do not follow a redirect to an internal address (SSRF via 3xx). Per the fetch
            // spec a manual-redirect response to a 3xx comes back non-ok (status 0,
            // type: 'opaqueredirect'), so it is logged as a failure below rather than followed.
            redirect: 'manual',
        })

        if (!response.ok) {
            console.error(`[RouteMatcher] HTTP route delivery failed: route="${routeName}" url="${cfg.url}" status=${response.status}`)
        }
    } catch (err) {
        console.error(`[RouteMatcher] HTTP route delivery error: route="${routeName}" url="${cfg.url}":`, err instanceof Error ? err.message : err)
    }
}

/**
 * Deliver email via matched routes (SMTP, HTTP, address forwarding, hold).
 */
export async function deliverViaRoutes(
    recipient: string,
    rawEmail: Buffer,
    matchedRoutes: MatchedRoute[],
    organizationId: string
): Promise<void> {
    for (const { route, endpoint } of matchedRoutes) {
        if (endpoint.type === 'hold') {
            const token = uuidv4()
            await db.insert(messages).values({
                organizationId,
                token,
                direction: 'incoming',
                fromAddress: '',
                toAddresses: [recipient],
                subject: '(held)',
                status: 'held',
                held: true,
                holdExpiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                heldReason: `Route: ${route.name}`,
            }).onConflictDoNothing()

            await incrementStat(organizationId, 'messagesHeld')
            continue
        }

        if (endpoint.type === 'smtp' && endpoint.config) {
            const cfg = endpoint.config as { hostname: string; port: number; sslMode: string; username?: string; password?: string }
            const transporter = nodemailer.createTransport({
                host: cfg.hostname,
                port: cfg.port,
                secure: cfg.sslMode === 'ssl' || cfg.port === 465,
                auth: cfg.username && cfg.password ? { user: cfg.username, pass: cfg.password } : undefined,
            })

            await transporter.sendMail({
                envelope: { from: '', to: [recipient] },
                raw: rawEmail,
            })
        }

        if (endpoint.type === 'address' && endpoint.config) {
            const cfg = endpoint.config as { emailAddress: string }
            // Encaminhamento de rota usa o mesmo transporte de saida do resto da plataforma. O
            // `if (host)` sem `else` que existia aqui deixava a rota de encaminhamento parada e
            // muda quando nao havia relay — a mensagem sumia sem log e sem erro.
            await sendOutbound(
                { envelope: { from: '', to: [cfg.emailAddress] }, raw: rawEmail },
                [cfg.emailAddress],
            )
        }

        if (endpoint.type === 'http' && endpoint.config) {
            const cfg = endpoint.config as { url: string; method?: string; headers?: Record<string, string>; includeOriginal?: boolean }
            await deliverHttpRoute(recipient, rawEmail, route.name, cfg)
        }
    }
}
