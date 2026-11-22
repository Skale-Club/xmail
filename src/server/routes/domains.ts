import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { domains, organizations, organizationUsers } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { isPlatformAdmin } from '../lib/admin'
import {
    buildDnsRecords, checkDomainDns, generateDkimKeyPair, DEFAULT_DKIM_SELECTOR,
    type DomainRow, type DnsRecordSpec, type DomainDnsRecords,
} from '../lib/domain-dns'
import { invalidateDkimCache } from '../lib/dkim'

const router = Router()

const createDomainSchema = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1).max(255),
    verificationMethod: z.enum(['dns', 'email']).default('dns'),
})

export { buildDnsRecords }
export type { DnsRecordSpec, DomainDnsRecords }

/**
 * Lazily backfills a DKIM keypair for domains created before key generation existed (POST '/'
 * below generates one at creation time for everything else). Called from every read path that
 * needs dnsRecords (GET list/detail, verify) so an old domain gets a key the first time anyone
 * looks at it, rather than showing "(generated after domain verification)" forever. Cheap
 * no-op once a key exists.
 */
async function ensureDkimKeyPair(domain: DomainRow): Promise<DomainRow> {
    if (domain.dkimPrivateKey && domain.dkimPublicKey) return domain

    const { privateKey, publicKey } = generateDkimKeyPair()
    const [updated] = await db
        .update(domains)
        .set({ dkimPrivateKey: privateKey, dkimPublicKey: publicKey, updatedAt: new Date() })
        .where(eq(domains.id, domain.id))
        .returning()

    // In case sending code already looked this domain up and cached a "no DKIM" miss.
    invalidateDkimCache(domain.name)

    return updated ?? domain
}

/**
 * Public projection of a domain row. Now that DKIM keys are generated, the raw row carries the
 * private key — it must never leave the server. Every response below goes through this.
 */
function toPublicDomain(domain: DomainRow) {
    const { dkimPrivateKey: _dkimPrivateKey, ...rest } = domain
    void _dkimPrivateKey
    return { ...rest, dnsRecords: buildDnsRecords(domain) }
}

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

        const domainsWithDns = await Promise.all(
            domainsList.map(async (domain) => {
                const ensured = await ensureDkimKeyPair(domain)
                return toPublicDomain(ensured)
            })
        )

        res.json({ domains: domainsWithDns })
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

        const ensured = await ensureDkimKeyPair(domain)

        res.json({ domain: toPublicDomain(ensured) })
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

        // Generate the DKIM keypair up front so the DNS instructions shown right after
        // creation already have a real `p=` value instead of "(generated after domain
        // verification)" — that placeholder never actually resolved to anything because no
        // route ever generated a key.
        const { privateKey, publicKey } = generateDkimKeyPair()

        const [domain] = await db.insert(domains).values({
            organizationId: data.organizationId,
            name: normalizedName,
            verificationMethod: data.verificationMethod,
            verificationToken: uuidv4(),
            dkimSelector: DEFAULT_DKIM_SELECTOR,
            dkimPrivateKey: privateKey,
            dkimPublicKey: publicKey,
        }).returning()

        res.status(201).json({ domain: toPublicDomain(domain) })
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

        const rawDomain = await db.query.domains.findFirst({
            where: eq(domains.id, domainId),
        })

        if (!rawDomain) {
            return res.status(404).json({ error: 'Domain not found' })
        }

        const { organization, membership } = await checkDomainAccess(userId, rawDomain.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can verify domains' })
        }

        // Backfill a DKIM key here too — a domain may reach verify without ever having hit a
        // GET route first.
        const domain = await ensureDkimKeyPair(rawDomain)

        const { update: verificationUpdate, dnsResults } = await checkDomainDns(domain)

        const [updatedDomain] = await db
            .update(domains)
            .set({ ...verificationUpdate, updatedAt: new Date() })
            .where(eq(domains.id, domainId))
            .returning()

        res.json({
            domain: toPublicDomain(updatedDomain),
            dnsResults,
        })
    } catch (error) {
        console.error('Error verifying domain:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/:id/dkim/regenerate', async (req: Request, res: Response) => {
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
            return res.status(403).json({ error: 'Only admins can regenerate DKIM keys' })
        }

        const { privateKey, publicKey } = generateDkimKeyPair()

        const [updatedDomain] = await db
            .update(domains)
            .set({
                dkimPrivateKey: privateKey,
                dkimPublicKey: publicKey,
                // The old key's TXT record is no longer what we sign with — force it back to
                // pending so admins know to re-publish and re-verify.
                dkimStatus: 'pending',
                dkimError: null,
                updatedAt: new Date(),
            })
            .where(eq(domains.id, domainId))
            .returning()

        invalidateDkimCache(domain.name)

        res.json({ domain: toPublicDomain(updatedDomain) })
    } catch (error) {
        console.error('Error regenerating DKIM key:', error)
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
