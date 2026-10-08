import { Router } from 'express'
import { and, count, desc, eq, ilike, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import { suppressions } from '../../db/schema'
import {
    MANAGE_SCOPE,
    READ_SCOPE,
    ManageError,
    auditManage,
    confirmBodySchema,
    handleManageError,
    isUuid,
    paginationMeta,
    paginationSchema,
    requireConfirmation,
    requireScope,
} from '../lib/agent-manage'
import { domainSuppressionKey } from '../lib/inbox-suppression'
import { isPublicEmailDomain } from '../lib/public-email-domains'

/**
 * Hermes / Kai suppression list (addresses and domains the organization will not email).
 *
 *   GET    /suppressions        outreach:read
 *   POST   /suppressions        outreach:manage    add one address OR one domain
 *   DELETE /suppressions/:id    outreach:manage    lift one (confirm: true), manual ones only
 *
 * Adding is the safe direction (it only stops mail) and is idempotent. Lifting is not: the agent
 * can lift only a suppression a person added by hand (`source = 'manual'`). Unsubscribes,
 * spam complaints and bounces are legal and deliverability facts, and putting those addresses
 * back in front of a campaign is exactly what CAN-SPAM and the sender reputation punish, so those
 * stay human-only. A domain block on a free-mail provider is refused for the same reason the
 * human inbox refuses it: it would silence countless unrelated people.
 */

const router = Router()

const listQuerySchema = paginationSchema.extend({
    search: z.string().trim().max(200).optional(),
    source: z.enum(['bounce', 'complaint', 'unsubscribe', 'manual']).optional(),
})

const ADDRESS = z.string().trim().toLowerCase().email().max(320)
const DOMAIN = z.string().trim().toLowerCase().max(253)
    .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Provide a bare domain such as example.com')

const addSchema = z.object({
    email: ADDRESS.optional(),
    domain: DOMAIN.optional(),
    reason: z.string().trim().max(500).optional(),
}).strict().refine(
    (value) => (value.email === undefined) !== (value.domain === undefined),
    { message: 'Provide exactly one of email or domain' },
)

function toView(row: { id: string; emailAddress: string; source: string; reason: string; createdAt: Date }) {
    const isDomain = row.emailAddress.startsWith('@')
    return {
        id: row.id,
        scope: isDomain ? 'domain' : 'address',
        value: isDomain ? row.emailAddress.slice(1) : row.emailAddress,
        source: row.source,
        reason: row.reason,
        createdAt: row.createdAt,
        removableByAgent: row.source === 'manual',
    }
}

router.get('/suppressions', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = listQuerySchema.parse(req.query)
        const conditions = [eq(suppressions.organizationId, principal.organizationId)]
        if (query.source) conditions.push(eq(suppressions.source, query.source))
        if (query.search) conditions.push(ilike(suppressions.emailAddress, `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`))
        const where = and(...conditions)
        const [{ total }] = await db.select({ total: count() }).from(suppressions).where(where)
        const rows = await db
            .select()
            .from(suppressions)
            .where(where)
            .orderBy(desc(suppressions.createdAt))
            .limit(query.limit)
            .offset((query.page - 1) * query.limit)
        res.json({
            suppressions: rows.map(toView),
            pagination: paginationMeta(query.page, query.limit, Number(total)),
        })
    } catch (error) {
        handleManageError(error, res, 'suppression list')
    }
})

router.post('/suppressions', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = addSchema.parse(req.body)
        const isDomain = input.domain !== undefined
        const value = (isDomain ? input.domain : input.email) as string
        if (isDomain && isPublicEmailDomain(value)) {
            throw new ManageError(422, {
                error: `${value} is a public or free-mail provider; a domain-wide block is not permitted. Suppress the individual address instead.`,
                code: 'suppression_public_domain',
            })
        }
        const key = isDomain ? domainSuppressionKey(value) : value

        const outcome = await db.transaction(async (tx) => {
            const [existing] = await tx
                .select()
                .from(suppressions)
                .where(and(eq(suppressions.organizationId, principal.organizationId), sql`lower(${suppressions.emailAddress}) = ${key}`))
                .limit(1)
            if (existing) return { created: false as const, row: existing }
            const [row] = await tx.insert(suppressions).values({
                organizationId: principal.organizationId,
                emailAddress: key,
                source: 'manual',
                reason: isDomain ? 'agent_domain_block' : 'agent_sender_block',
            }).onConflictDoNothing().returning()
            if (!row) {
                const [raced] = await tx
                    .select()
                    .from(suppressions)
                    .where(and(eq(suppressions.organizationId, principal.organizationId), sql`lower(${suppressions.emailAddress}) = ${key}`))
                    .limit(1)
                return { created: false as const, row: raced }
            }
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.suppression.added',
                resourceType: 'suppression',
                resourceId: row.id,
                metadata: { suppressionId: row.id, scope: isDomain ? 'domain' : 'address', value, reason: input.reason ?? null },
            })
            return { created: true as const, row }
        })

        res.status(outcome.created ? 201 : 200).json({
            added: outcome.created,
            alreadySuppressed: !outcome.created,
            suppression: toView(outcome.row),
        })
    } catch (error) {
        handleManageError(error, res, 'suppression add')
    }
})

router.delete('/suppressions/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = confirmBodySchema.parse(req.body ?? {})
        if (!isUuid(req.params.id)) throw new ManageError(404, { error: 'Suppression not found' })
        const row = await db.query.suppressions.findFirst({
            where: and(eq(suppressions.id, req.params.id), eq(suppressions.organizationId, principal.organizationId)),
        })
        if (!row) throw new ManageError(404, { error: 'Suppression not found' })
        if (row.source !== 'manual') {
            throw new ManageError(403, {
                error: `This suppression was recorded from a ${row.source}. Only a person can lift it.`,
                code: 'suppression_not_removable_by_agent',
                source: row.source,
            })
        }
        const view = toView(row)
        requireConfirmation(input, {
            action: 'lift suppression',
            scope: view.scope,
            value: view.value,
            consequence: view.scope === 'domain'
                ? `Campaigns may email every address at ${view.value} again.`
                : `Campaigns may email ${view.value} again.`,
        })

        await db.transaction(async (tx) => {
            const deleted = await tx
                .delete(suppressions)
                .where(and(eq(suppressions.id, row.id), eq(suppressions.organizationId, principal.organizationId), eq(suppressions.source, 'manual')))
                .returning()
            if (deleted.length === 0) throw new ManageError(404, { error: 'Suppression not found' })
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.suppression.removed',
                resourceType: 'suppression',
                resourceId: row.id,
                metadata: {
                    suppressionId: row.id,
                    scope: view.scope,
                    value: view.value,
                    source: row.source,
                    originalReason: row.reason,
                    reason: input.reason ?? null,
                },
            })
        })
        res.json({ removed: true, suppression: view })
    } catch (error) {
        handleManageError(error, res, 'suppression removal')
    }
})

export default router
