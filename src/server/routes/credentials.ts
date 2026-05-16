import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../db';
import { credentials, organizations, organizationUsers } from '../../db/schema';
import { eq, desc, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { isPlatformAdmin } from '../lib/admin'

const router = Router();

// Validation schemas
const createCredentialSchema = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1).max(100),
    type: z.enum(['smtp', 'api']),
    key: z.string().min(1),
    secret: z.string().optional(),
});

// NOTE: updateCredentialSchema previously defined here was removed (Phase 12 COR-07 lint cleanup);
// re-add when an update endpoint is implemented.

// Helper to check access
export async function checkCredentialAccess(userId: string, organizationId: string) {
    const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
    });

    if (!organization) return { organization: null, membership: null }

    if (await isPlatformAdmin(userId)) {
        return { organization, membership: { role: 'admin' as const } }
    }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organization.id),
            eq(organizationUsers.userId, userId)
        ),
    })

    return { organization, membership }
}

// List credentials for organization
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

        const { organization, membership } = await checkCredentialAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const credentialsList = await db.query.credentials.findMany({
            where: eq(credentials.organizationId, organizationId),
            orderBy: [desc(credentials.createdAt)],
        })

        res.json({ credentials: credentialsList })
    } catch (error) {
        console.error('Error fetching credentials:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
});

// Create credential
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = createCredentialSchema.parse(req.body)

        const { organization, membership } = await checkCredentialAccess(userId, data.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can create credentials' })
        }

        const key = uuidv4()

        // Hash the secret before inserting
        let hashedSecret: string | null = null
        if (data.secret) {
            hashedSecret = await hashSecret(data.secret)
        }

        const [credential] = await db.insert(credentials).values({
            organizationId: data.organizationId,
            name: data.name,
            type: data.type,
            key: data.key || key,
            secretHash: hashedSecret,
        }).returning()

        res.status(201).json({ credential })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating credential:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
});

// Regenerate credential key
router.post('/:id/regenerate', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const credentialId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const credential = await db.query.credentials.findFirst({
            where: eq(credentials.id, credentialId),
        })

        if (!credential) {
            return res.status(404).json({ error: 'Credential not found' })
        }

        const { organization, membership } = await checkCredentialAccess(userId, credential.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can regenerate credentials' })
        }

        const newKey = uuidv4()
        const newSecret = uuidv4()
        const hashedNewSecret = await hashSecret(newSecret)

        const [updatedCredential] = await db
            .update(credentials)
            .set({
                key: newKey,
                secretHash: hashedNewSecret,
                updatedAt: new Date(),
            })
            .where(eq(credentials.id, credentialId))
            .returning()

        res.json({
            credential: updatedCredential,
            newKey,
            newSecret,
        })
    } catch (error) {
        console.error('Error regenerating credential:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
});

// Delete credential
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const credentialId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const credential = await db.query.credentials.findFirst({
            where: eq(credentials.id, credentialId),
        })

        if (!credential) {
            return res.status(404).json({ error: 'Credential not found' })
        }

        const { organization, membership } = await checkCredentialAccess(userId, credential.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete credentials' })
        }

        await db.delete(credentials).where(eq(credentials.id, credentialId))

        res.json({ message: 'Credential deleted successfully' })
    } catch (error) {
        console.error('Error deleting credential:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
});

// Helper function to hash secret using scrypt
async function hashSecret(secret: string): Promise<string> {
    const { scrypt, randomBytes } = await import('crypto')
    return new Promise((resolve, reject) => {
        const salt = randomBytes(16).toString('hex')
        scrypt(secret, salt, 64, (err, derived) => {
            if (err) return reject(err)
            resolve(`${salt}:${derived.toString('hex')}`)
        })
    })
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
    const { scrypt, timingSafeEqual } = await import('crypto')
    const [salt, hash] = stored.split(':')
    return new Promise((resolve, reject) => {
        scrypt(secret, salt, 64, (err, derived) => {
            if (err) return reject(err)
            resolve(timingSafeEqual(Buffer.from(hash, 'hex'), derived))
        })
    })
}

export default router