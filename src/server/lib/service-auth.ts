/**
 * Machine-to-machine (service-key) authentication for the Xphere orchestrator.
 *
 * A valid `x-service-key` authenticates a SERVER-CONFIGURED principal and organization.
 * The caller cannot choose its own identity or tenant: the bound user id and organization
 * come from the environment, and any caller-supplied identity/scope is overwritten or
 * rejected. This is intentionally NOT a general multi-key API-credential product — it
 * binds the single existing orchestrator (see Phase 20 CONTEXT / CONS-06).
 *
 * Fail-closed rule (CLAUDE.md): the service path only activates when the full set
 * (XMAIL_SERVICE_KEY + XMAIL_SERVICE_USER_ID + XMAIL_SERVICE_ORGANIZATION_ID) is present.
 * A configured key without a bound principal/organization never authenticates.
 */
import crypto from 'node:crypto'
import type { Request } from 'express'
import { SERVICE_ORGANIZATION_HEADER, SERVICE_PRINCIPAL_HEADER } from './outreach-access'

export const SERVICE_KEY_HEADER = 'x-service-key'

const REQUIRED_ENV = [
    'XMAIL_SERVICE_KEY',
    'XMAIL_SERVICE_USER_ID',
    'XMAIL_SERVICE_ORGANIZATION_ID',
] as const

export interface ServiceAuthConfig {
    key: string
    userId: string
    organizationId: string
}

type EnvLike = Record<string, string | undefined>

/**
 * Resolve the bound service principal from the environment. Returns null unless all
 * three variables are present and non-empty (fails closed).
 */
export function resolveServiceAuthConfig(env: EnvLike = process.env): ServiceAuthConfig | null {
    const key = env.XMAIL_SERVICE_KEY?.trim()
    const userId = env.XMAIL_SERVICE_USER_ID?.trim()
    const organizationId = env.XMAIL_SERVICE_ORGANIZATION_ID?.trim()
    if (!key || !userId || !organizationId) return null
    return { key, userId, organizationId }
}

/**
 * Describe the configuration state for a startup diagnostic. A partial configuration
 * is a misconfiguration worth warning about loudly: the machine path silently stays
 * disabled until it is completed.
 */
export function describeServiceAuthState(env: EnvLike = process.env): {
    enabled: boolean
    partial: boolean
    missing: string[]
} {
    const present = REQUIRED_ENV.filter((name) => Boolean(env[name]?.trim()))
    const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim())
    return {
        enabled: present.length === REQUIRED_ENV.length,
        partial: present.length > 0 && present.length < REQUIRED_ENV.length,
        missing,
    }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    if (bufA.length !== bufB.length) {
        // Still run a comparison to avoid leaking length via timing.
        crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length))
        return false
    }
    return crypto.timingSafeEqual(bufA, bufB)
}

export interface ServicePrincipalResult {
    ok: boolean
    status?: number
    body?: unknown
}

/**
 * Bind an already-verified machine caller to the server-configured principal and
 * organization:
 *   - x-user-id (and derived identity headers) are overwritten with the bound user;
 *   - a query/body organizationId that mismatches the bound organization is rejected (403);
 *   - a service-principal marker + bound organization header are set so routes that derive
 *     their organization from a resource can still enforce the scope through the shared helper.
 *
 * The service key must already have been verified before calling this.
 */
export function applyServicePrincipal(req: Request, config: ServiceAuthConfig): ServicePrincipalResult {
    const queryOrg = typeof req.query?.organizationId === 'string' ? req.query.organizationId : undefined
    const body = req.body as unknown
    const isPlainObject = Boolean(body) && typeof body === 'object' && !Array.isArray(body)
    const bodyOrg = isPlainObject && typeof (body as Record<string, unknown>).organizationId === 'string'
        ? (body as Record<string, string>).organizationId
        : undefined

    for (const candidate of [queryOrg, bodyOrg]) {
        if (candidate !== undefined && candidate !== config.organizationId) {
            return {
                ok: false,
                status: 403,
                body: { error: 'Organization scope not permitted for this credential' },
            }
        }
    }

    // Overwrite identity — the client cannot pick who it is.
    req.headers['x-user-id'] = config.userId
    delete req.headers['x-user-email']
    delete req.headers['x-user-first-name']
    delete req.headers['x-user-last-name']
    delete req.headers['x-user-email-verified']

    // Bind the organization scope for resource-derived route enforcement.
    req.headers[SERVICE_PRINCIPAL_HEADER] = 'true'
    req.headers[SERVICE_ORGANIZATION_HEADER] = config.organizationId

    // Overwrite the body organization where present so downstream sees only the bound
    // tenant. (req.query is a getter in Express 5; query scope is enforced via the marker
    // above and the mismatch rejection here.)
    if (isPlainObject) {
        (body as Record<string, unknown>).organizationId = config.organizationId
    }

    return { ok: true }
}
