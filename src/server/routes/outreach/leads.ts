import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { leads, leadLists, organizationUsers } from '../../../db/schema'
import { eq, and, sql, inArray, desc } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { paginate, paginationQuerySchema } from '../../lib/pagination'

const router = Router()

// Validation schemas
const createLeadSchema = z.object({
    email: z.string().email('Invalid email address'),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    companyName: z.string().optional(),
    companySize: z.string().optional(),
    industry: z.string().optional(),
    title: z.string().optional(),
    website: z.string().optional(),
    linkedinUrl: z.string().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    customFields: z.record(z.any()).optional(),
    source: z.string().optional(),
    leadListId: z.string().uuid().optional(),
})

const updateLeadSchema = z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    companyName: z.string().optional(),
    companySize: z.string().optional(),
    industry: z.string().optional(),
    title: z.string().optional(),
    website: z.string().optional(),
    linkedinUrl: z.string().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    customFields: z.record(z.any()).optional(),
    status: z.enum(['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed']).optional(),
})

const bulkImportSchema = z.object({
    leads: z.array(createLeadSchema).min(1).max(1000),
    leadListId: z.string().uuid().optional(),
})

const createLeadListSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    description: z.string().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
})

// Helper to check org membership (platform admins bypass membership check)
async function checkOrgMembership(userId: string, organizationId: string) {
    const admin = await isPlatformAdmin(userId)
    if (admin) return { role: 'admin' as const }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId)
        ),
    })
    return membership
}

function canWriteOutreach(membership: Awaited<ReturnType<typeof checkOrgMembership>>): boolean {
    return membership?.role === 'admin' || membership?.role === 'member'
}

async function validateLeadListAccess(organizationId: string, leadListId: string | undefined): Promise<boolean> {
    if (!leadListId) return true
    const list = await db.query.leadLists.findFirst({
        where: and(
            eq(leadLists.id, leadListId),
            eq(leadLists.organizationId, organizationId)
        ),
        columns: { id: true },
    })
    return Boolean(list)
}

// ============ LEAD LISTS ============

// List all lead lists
router.get('/lists', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const { page, limit } = paginationQuerySchema.parse(req.query)

        const result = await paginate(db, leadLists, {
            where: eq(leadLists.organizationId, organizationId),
            page,
            limit,
            orderBy: desc(leadLists.createdAt),
        })

        res.json({ leadLists: result.data, pagination: result.pagination })
    } catch (error) {
        console.error('Error fetching lead lists:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create lead list
router.post('/lists', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = createLeadListSchema.parse(req.body)

        const [newList] = await db.insert(leadLists).values({
            organizationId,
            ...validatedData,
        }).returning()

        res.status(201).json({ leadList: newList })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating lead list:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete lead list
router.delete('/lists/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const listId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const list = await db.query.leadLists.findFirst({
            where: eq(leadLists.id, listId),
        })

        if (!list) {
            return res.status(404).json({ error: 'Lead list not found' })
        }

        const membership = await checkOrgMembership(userId, list.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        // Remove list from leads (set leadListId to null)
        await db.update(leads)
            .set({ leadListId: null })
            .where(eq(leads.leadListId, listId))

        await db.delete(leadLists).where(eq(leadLists.id, listId))

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting lead list:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============ LEADS ============

// List leads with pagination and filters
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string
        const page = parseInt(req.query.page as string) || 1
        const limit = parseInt(req.query.limit as string) || 50
        // Phase 12 COR-07: `_search` retained as a TODO marker; lead search not yet wired through.
        // Phase 13 QUA-01 will either implement the filter or remove the field entirely.
        const _search = req.query.search as string
        const status = req.query.status as string
        const leadListId = req.query.leadListId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const offset = (page - 1) * limit

        // Build where conditions
        const conditions = [eq(leads.organizationId, organizationId)]

        if (status) {
            conditions.push(eq(leads.status, status as any))
        }

        if (leadListId) {
            conditions.push(eq(leads.leadListId, leadListId))
        }

        // Get total count
        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(leads)
            .where(and(...conditions))

        const total = Number(countResult[0]?.count || 0)

        // Get leads
        const leadsList = await db.query.leads.findMany({
            where: and(...conditions),
            limit,
            offset,
            orderBy: (leads, { desc }) => [desc(leads.createdAt)],
            with: {
                leadList: true,
            },
        })

        res.json({
            leads: leadsList,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        })
    } catch (error) {
        console.error('Error fetching leads:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get lead by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const leadId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const lead = await db.query.leads.findFirst({
            where: eq(leads.id, leadId),
            with: {
                leadList: true,
            },
        })

        if (!lead) {
            return res.status(404).json({ error: 'Lead not found' })
        }

        const membership = await checkOrgMembership(userId, lead.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ lead })
    } catch (error) {
        console.error('Error fetching lead:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create lead
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = createLeadSchema.parse(req.body)
        if (!(await validateLeadListAccess(organizationId, validatedData.leadListId))) {
            return res.status(400).json({ error: 'Lead list not found or access denied' })
        }

        // Check for duplicate email
        const existing = await db.query.leads.findFirst({
            where: and(
                eq(leads.organizationId, organizationId),
                eq(leads.email, validatedData.email)
            ),
        })

        if (existing) {
            return res.status(400).json({ error: 'Lead with this email already exists' })
        }

        const [newLead] = await db.insert(leads).values({
            organizationId,
            ...validatedData,
        }).returning()

        // Update lead list count
        if (validatedData.leadListId) {
            await db.update(leadLists)
                .set({
                    leadCount: sql`${leadLists.leadCount} + 1`,
                })
                .where(eq(leadLists.id, validatedData.leadListId))
        }

        res.status(201).json({ lead: newLead })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating lead:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Bulk import leads
router.post('/bulk-import', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = bulkImportSchema.parse(req.body)
        const leadListIds = [...new Set([
            validatedData.leadListId,
            ...validatedData.leads.map(lead => lead.leadListId),
        ].filter((id): id is string => Boolean(id)))]
        if (leadListIds.length > 0) {
            const accessibleLists = await db.query.leadLists.findMany({
                where: and(
                    eq(leadLists.organizationId, organizationId),
                    inArray(leadLists.id, leadListIds)
                ),
                columns: { id: true },
            })
            if (accessibleLists.length !== leadListIds.length) {
                return res.status(400).json({ error: 'One or more lead lists were not found or access denied' })
            }
        }

        // Get existing emails
        const existingLeads = await db.query.leads.findMany({
            where: and(
                eq(leads.organizationId, organizationId),
                inArray(leads.email, validatedData.leads.map(l => l.email))
            ),
            columns: { email: true },
        })

        const existingEmails = new Set(existingLeads.map(l => l.email))

        // Filter out duplicates
        const newLeads = validatedData.leads.filter(l => !existingEmails.has(l.email))

        if (newLeads.length === 0) {
            return res.status(400).json({ error: 'All leads already exist', imported: 0, duplicates: validatedData.leads.length })
        }

        // Insert new leads
        const insertedLeads = await db.insert(leads).values(
            newLeads.map(lead => ({
                organizationId,
                ...lead,
                leadListId: validatedData.leadListId || lead.leadListId,
            }))
        ).returning()

        // Update lead list count
        if (validatedData.leadListId) {
            await db.update(leadLists)
                .set({
                    leadCount: sql`${leadLists.leadCount} + ${insertedLeads.length}`,
                })
                .where(eq(leadLists.id, validatedData.leadListId))
        }

        res.status(201).json({
            imported: insertedLeads.length,
            duplicates: validatedData.leads.length - insertedLeads.length,
            leads: insertedLeads,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error bulk importing leads:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update lead
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const leadId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const lead = await db.query.leads.findFirst({
            where: eq(leads.id, leadId),
        })

        if (!lead) {
            return res.status(404).json({ error: 'Lead not found' })
        }

        const membership = await checkOrgMembership(userId, lead.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = updateLeadSchema.parse(req.body)

        const [updatedLead] = await db.update(leads)
            .set({
                ...validatedData,
                updatedAt: new Date(),
            })
            .where(eq(leads.id, leadId))
            .returning()

        if (!updatedLead) return res.status(500).json({ error: 'Update failed — record not found' })

        res.json({ lead: updatedLead })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating lead:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete lead
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const leadId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const lead = await db.query.leads.findFirst({
            where: eq(leads.id, leadId),
        })

        if (!lead) {
            return res.status(404).json({ error: 'Lead not found' })
        }

        const membership = await checkOrgMembership(userId, lead.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        await db.delete(leads).where(eq(leads.id, leadId))

        // Update lead list count
        if (lead.leadListId) {
            await db.update(leadLists)
                .set({
                    leadCount: sql`GREATEST(0, ${leadLists.leadCount} - 1)`,
                })
                .where(eq(leadLists.id, lead.leadListId))
        }

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting lead:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Bulk delete leads
router.post('/bulk-delete', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string
        const { leadIds } = req.body as { leadIds: string[] }

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ error: 'leadIds array is required' })
        }

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        // Verify all leads belong to the organization
        const leadsToDelete = await db.query.leads.findMany({
            where: and(
                eq(leads.organizationId, organizationId),
                inArray(leads.id, leadIds)
            ),
        })

        if (leadsToDelete.length !== leadIds.length) {
            return res.status(400).json({ error: 'Some leads not found or access denied' })
        }

        await db.delete(leads).where(inArray(leads.id, leadIds))

        res.json({ success: true, deleted: leadsToDelete.length })
    } catch (error) {
        console.error('Error bulk deleting leads:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
