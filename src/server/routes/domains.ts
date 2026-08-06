import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { domains, organizations, organizationUsers } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { isPlatformAdmin } from '../lib/admin'
import { resolveMx, resolveTxt, resolveCname } from '../lib/dns-resolver'

const MAIL_HOST = process.env.MAIL_HOST || 'mx.skaleclub.com'

const router = Router()

const createDomainSchema = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1).max(255),
    verificationMethod: z.enum(['dns', 'email']).default('dns'),
})

export async function checkDomainAccess(userId: string, organizationId: string) {
    const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
    })

    if (!organization) return { organization: null, membership: null }

    if (await isPlatformAdmin(userId)) {
        return { organization, membership: { role: 'admin' as const } }
    }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId)
        ),
    })

    return { organization, membership }
}

router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'Organization ID required' })
        }

        const { organization, membership } = await checkDomainAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const domainsList = await db.query.domains.findMany({
            where: eq(domains.organizationId, organizationId),
        })

        res.json({ domains: domainsList })
    } catch (error) {
        console.error('Error fetching domains:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const domainId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const domain = await db.query.domains.findFirst({
            where: eq(domains.id, domainId),
        })

        if (!domain) {
            return res.status(404).json({ error: 'Domain not found' })
        }

        const { organization, membership } = await checkDomainAccess(userId, domain.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ domain })
    } catch (error) {
        console.error('Error fetching domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = createDomainSchema.parse(req.body)

        const { organization, membership } = await checkDomainAccess(userId, data.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can add domains' })
        }

        // QUA-04 — see audit M9. Lowercase + trim once, use the normalized value for both
        // the duplicate-existence check and the INSERT. This makes the column effectively
        // case-insensitive and prevents the EXAMPLE.COM-then-example.com dupe class.
        const normalizedName = data.name.toLowerCase().trim()

        const existingDomain = await db.query.domains.findFirst({
            where: and(
                eq(domains.organizationId, data.organizationId),
                eq(domains.name, normalizedName)
            ),
        })

        if (existingDomain) {
            return res.status(400).json({ error: 'Domain already exists' })
        }

        const [domain] = await db.insert(domains).values({
            organizationId: data.organizationId,
            name: normalizedName,
            verificationMethod: data.verificationMethod,
            verificationToken: uuidv4(),
        }).returning()

        res.status(201).json({ domain })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:id/verify', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const domainId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const domain = await db.query.domains.findFirst({
            where: eq(domains.id, domainId),
        })

        if (!domain) {
            return res.status(404).json({ error: 'Domain not found' })
        }

        const { organization, membership } = await checkDomainAccess(userId, domain.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can verify domains' })
        }

        const domainName = domain.name
        const expectedToken = `skaleclub-verification:${domain.verificationToken}`
        const dkimSelector = domain.dkimSelector || 'skaleclub'

        const [rootTxt, dkimTxt, dmarcTxt, mxRecords, returnPathCname] = await Promise.all([
            resolveTxt(domainName),
            resolveTxt(`${dkimSelector}._domainkey.${domainName}`),
            resolveTxt(`_dmarc.${domainName}`),
            resolveMx(domainName),
            resolveCname(`rp.${domainName}`),
        ])

        const verificationFound = rootTxt.some((r) => r === expectedToken)
        const verificationStatus = verificationFound ? 'verified' as const : 'failed' as const

        const spfFound = rootTxt.some((r) => r.startsWith('v=spf1') && r.includes('spf.skaleclub.com'))
        const spfStatus = spfFound ? 'verified' : 'failed'
        const spfError = spfFound ? null : 'SPF record not found or does not include spf.skaleclub.com'

        const dkimFound = dkimTxt.length > 0 && dkimTxt.some((r) => r.startsWith('v=DKIM1'))
        const dkimStatus = dkimFound ? 'verified' : 'failed'
        const dkimError = dkimFound ? null : 'DKIM record not found'

        const dmarcFound = dmarcTxt.some((r) => r.startsWith('v=DMARC1'))
        const dmarcStatus = dmarcFound ? 'verified' : 'failed'
        const dmarcError = dmarcFound ? null : 'DMARC record not found'

        const mxFound = mxRecords.some((r) => r.exchange.toLowerCase() === MAIL_HOST.toLowerCase())
        const mxStatus = mxFound ? 'verified' : 'failed'
        const mxError = mxFound ? null : `MX record not found or does not point to ${MAIL_HOST}`

        const returnPathTarget = 'rp.skaleclub.com'
        const returnPathFound = returnPathCname.some((r) => r.toLowerCase() === returnPathTarget)
        const returnPathStatus = returnPathFound ? 'verified' : 'failed'
        const returnPathError = returnPathFound ? null : `Return-Path CNAME not found (expected rp.${domainName} → ${returnPathTarget})`

        const allVerified = verificationFound && spfFound && dkimFound && dmarcFound && mxFound && returnPathFound

        const [updatedDomain] = await db
            .update(domains)
            .set({
                verificationStatus,
                verifiedAt: allVerified ? new Date() : null,
                spfStatus,
                spfError,
                dkimStatus,
                dkimError,
                dmarcStatus,
                dmarcError,
                mxStatus,
                mxError,
                returnPathStatus,
                returnPathError,
                updatedAt: new Date(),
            })
            .where(eq(domains.id, domainId))
            .returning()

        res.json({
            domain: updatedDomain,
            dnsResults: {
                verification: { found: verificationFound },
                spf: { found: spfFound, error: spfError },
                dkim: { found: dkimFound, error: dkimError },
                dmarc: { found: dmarcFound, error: dmarcError },
                mx: { found: mxFound, error: mxError },
                returnPath: { found: returnPathFound, error: returnPathError },
            },
        })
    } catch (error) {
        console.error('Error verifying domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const domainId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const domain = await db.query.domains.findFirst({
            where: eq(domains.id, domainId),
        })

        if (!domain) {
            return res.status(404).json({ error: 'Domain not found' })
        }

        const { organization, membership } = await checkDomainAccess(userId, domain.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete domains' })
        }

        await db.delete(domains).where(eq(domains.id, domainId))

        res.json({ message: 'Domain deleted successfully' })
    } catch (error) {
        console.error('Error deleting domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
