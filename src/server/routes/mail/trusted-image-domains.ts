import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { userTrustedImageDomains } from '../../../db/schema'
import { normalizeTrustedDomain } from '../../../lib/sender-domain'

/**
 * Per-USER list of sender domains whose remote images load automatically in the webmail.
 * Every query is scoped by the authenticated user id (x-user-id, set by the auth middleware);
 * there is no organization or mailbox dimension and no way to address another user's rows.
 */
const router = Router()

const MAX_BULK = 200

const domainField = z
    .string()
    .max(253)
    .transform((value, ctx) => {
        const normalized = normalizeTrustedDomain(value)
        if (!normalized) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid domain' })
            return z.NEVER
        }
        return normalized
    })

// `{ domain }` adds one; `{ domains: [...] }` adds several (used by the one-time localStorage import).
export const addTrustedDomainsSchema = z.union([
    z.object({ domain: domainField }).transform(({ domain }) => [domain]),
    z.object({ domains: z.array(domainField).min(1).max(MAX_BULK) }).transform(({ domains }) => [...new Set(domains)]),
])

router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })

        const rows = await db
            .select({ domain: userTrustedImageDomains.domain })
            .from(userTrustedImageDomains)
            .where(eq(userTrustedImageDomains.userId, userId))
            .orderBy(asc(userTrustedImageDomains.domain))

        res.json({ domains: rows.map(row => row.domain) })
    } catch (error) {
        console.error('Error listing trusted image domains:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })

        const parsed = addTrustedDomainsSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({ error: parsed.error.errors })
        }
        const domains = parsed.data

        await db
            .insert(userTrustedImageDomains)
            .values(domains.map(domain => ({ userId, domain })))
            .onConflictDoNothing()

        res.status(201).json({ domains })
    } catch (error) {
        console.error('Error adding trusted image domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:domain', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        if (!userId) return res.status(401).json({ error: 'Unauthorized' })

        const domain = normalizeTrustedDomain(req.params.domain)
        if (!domain) return res.status(400).json({ error: 'Invalid domain' })

        await db
            .delete(userTrustedImageDomains)
            .where(and(
                eq(userTrustedImageDomains.userId, userId),
                eq(userTrustedImageDomains.domain, domain),
            ))

        res.json({ success: true })
    } catch (error) {
        console.error('Error removing trusted image domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
