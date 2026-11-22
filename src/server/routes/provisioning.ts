/**
 * /api/provisioning/v1 — narrow server-to-server API for owned-microsite mailboxes.
 *
 * Deliberately NOT the outreach service key and NOT a human route: its own bearer secret
 * (XMAIL_PROVISIONING_API_KEY), bound to one organization (XMAIL_PROVISIONING_ORG_ID), its own
 * rate limiter, fail-closed when unconfigured. See docs/microsite-mailbox-provisioning.md.
 *
 * The /api auth middleware lets this prefix through (lib/api-auth.ts); this router is the only
 * authentication on it.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import {
    ProvisioningError,
    ensureDomain,
    ensureInfoMailbox,
    getDomainStatus,
    resolveProvisioningConfig,
    verifyDomain,
    type ProvisioningConfig,
    type ProvisioningStore,
} from '../lib/microsite-provisioning'
import { checkDomainDns } from '../lib/domain-dns'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { DomainVerificationUpdate } from '../lib/domain-dns'
import type { DomainRecord } from '../lib/microsite-provisioning'

/** Constant-time compare that also hides the secret length (both sides are hashed first). */
function secretsMatch(provided: string, expected: string): boolean {
    const a = createHash('sha256').update(provided).digest()
    const b = createHash('sha256').update(expected).digest()
    return timingSafeEqual(a, b)
}

export interface ProvisioningRouterDeps {
    store: ProvisioningStore
    /** Resolved per request so the env can be validated fresh; defaults to process.env. */
    getConfig?: () => ProvisioningConfig | null
    checkDns?: (domain: DomainRecord) => Promise<DomainVerificationUpdate>
    /** Tests turn the limiter off; production keeps it. */
    rateLimitPerMinute?: number | false
}

const defaultCheckDns = async (domain: DomainRecord) => (await checkDomainDns(domain)).update

export function createProvisioningRouter(deps: ProvisioningRouterDeps): Router {
    const router = Router()
    const getConfig = deps.getConfig ?? (() => resolveProvisioningConfig())
    const checkDns = deps.checkDns ?? defaultCheckDns

    if (deps.rateLimitPerMinute !== false) {
        router.use(rateLimit({
            windowMs: 60 * 1000,
            max: deps.rateLimitPerMinute ?? 120,
            standardHeaders: true,
            legacyHeaders: false,
            message: { error: 'rate_limited' },
        }))
    }

    // Auth: disabled (503) when key/org are unset, 401 with no detail on a bad token.
    router.use((req: Request, res: Response, next: NextFunction) => {
        const config = getConfig()
        if (!config) return res.status(503).json({ error: 'provisioning_disabled' })
        const header = req.headers.authorization
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
        if (!token || !secretsMatch(token, config.apiKey)) {
            return res.status(401).json({ error: 'invalid_token' })
        }
        res.locals.provisioningConfig = config
        next()
    })

    const handle = (
        fn: (req: Request, res: Response, config: ProvisioningConfig) => Promise<void>,
    ) => async (req: Request, res: Response) => {
        try {
            await fn(req, res, res.locals.provisioningConfig as ProvisioningConfig)
        } catch (error) {
            if (error instanceof ProvisioningError) {
                res.status(error.status).json({ error: error.code })
                return
            }
            // Never echo internals; the message may carry SQL or hostnames.
            console.error('[provisioning] unexpected error:', error instanceof Error ? error.message : 'unknown')
            res.status(500).json({ error: 'internal_error' })
        }
    }

    const domainParam = (req: Request): string => String(req.params.domain ?? '')
    const bodySiteRef = (req: Request): unknown =>
        req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).siteRef : undefined

    router.get('/domains/:domain', handle(async (req, res, config) => {
        res.json(await getDomainStatus(deps.store, config, domainParam(req)))
    }))

    router.put('/domains/:domain', handle(async (req, res, config) => {
        const { created, status } = await ensureDomain(deps.store, config, domainParam(req), bodySiteRef(req))
        res.status(created ? 201 : 200).json(status)
    }))

    router.put('/domains/:domain/mailboxes/info', handle(async (req, res, config) => {
        const { created, domainCreated, status } = await ensureInfoMailbox(deps.store, config, domainParam(req), bodySiteRef(req))
        res.status(created || domainCreated ? 201 : 200).json(status)
    }))

    router.post('/domains/:domain/verify', handle(async (req, res, config) => {
        res.json(await verifyDomain(deps.store, config, domainParam(req), checkDns))
    }))

    return router
}
