import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { routes, organizations, organizationUsers } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { isPlatformAdmin } from '../lib/admin'

const router = Router()

// Validation schemas
const createRouteSchema = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1).max(100),
    address: z.string().min(1),
    mode: z.enum(['endpoint', 'hold', 'reject']),
    spamMode: z.enum(['mark', 'reject']),
    spamThreshold: z.number().int().min(0).max(100).default(5),
})

const updateRouteSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    address: z.string().optional(),
    mode: z.enum(['endpoint', 'hold', 'reject']).optional(),
    spamMode: z.enum(['mark', 'reject']).optional(),
    spamThreshold: z.number().int().min(0).max(100).default(5),
})

// Helper to check access
export async function checkRouteAccess(userId: string, organizationId: string) {
    const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
    })

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

// List routes for organization
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

        const { organization, membership } = await checkRouteAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const routesList = await db.query.routes.findMany({
            where: eq(routes.organizationId, organizationId),
        })

        res.json({ routes: routesList })
    } catch (error) {
        console.error('Error fetching routes:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create route
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = createRouteSchema.parse(req.body)

        const { organization, membership } = await checkRouteAccess(userId, data.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can create routes' })
        }

        const [route] = await db.insert(routes).values({
            ...data,
        }).returning()

        res.status(201).json({ route })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating route:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update route
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const routeId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = updateRouteSchema.parse(req.body)

        const route = await db.query.routes.findFirst({
            where: eq(routes.id, routeId),
        })

        if (!route) {
            return res.status(404).json({ error: 'Route not found' })
        }

        const { organization, membership } = await checkRouteAccess(userId, route.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can update routes' })
        }

        const [updatedRoute] = await db
            .update(routes)
            .set({
                ...data,
                updatedAt: new Date(),
            })
            .where(eq(routes.id, routeId))
            .returning()

        res.json({ route: updatedRoute })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating route:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete route
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const routeId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const route = await db.query.routes.findFirst({
            where: eq(routes.id, routeId),
        })

        if (!route) {
            return res.status(404).json({ error: 'Route not found' })
        }

        const { organization, membership } = await checkRouteAccess(userId, route.organizationId)

        if (!organization || !membership || membership.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete routes' })
        }

        await db.delete(routes).where(eq(routes.id, routeId))

        res.json({ message: 'Route deleted successfully' })
    } catch (error) {
        console.error('Error deleting route:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
