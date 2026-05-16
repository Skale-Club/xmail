import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { templates, organizations, organizationUsers } from '../../db/schema'
import { eq, and, desc, like } from 'drizzle-orm'
import { isPlatformAdmin } from '../lib/admin'

const router = Router()

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

// Validation schemas
const createTemplateSchema = z.object({
    organizationId: z.string().uuid(),
    name: z.string().min(1, 'Name is required'),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    subject: z.string().min(1, 'Subject is required'),
    plainBody: z.string().optional(),
    htmlBody: z.string().optional(),
    variables: z.array(z.string()).optional(),
})

const updateTemplateSchema = z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
    subject: z.string().min(1).optional(),
    plainBody: z.string().optional(),
    htmlBody: z.string().optional(),
    variables: z.array(z.string()).optional(),
})

// Helper to check organization access
export async function checkOrganizationAccess(userId: string, organizationId: string) {
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

// List templates for an organization
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

        const { organization, membership } = await checkOrganizationAccess(userId, organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const search = req.query.search as string | undefined

        const conditions = [eq(templates.organizationId, organizationId)]

        if (search) {
            conditions.push(like(templates.name, `%${search}%`))
        }

        const templatesList = await db.query.templates.findMany({
            where: and(...conditions),
            columns: {
                htmlBody: false,
                plainBody: false,
            },
            orderBy: [desc(templates.createdAt)],
        })

        res.json({ templates: templatesList })
    } catch (error) {
        console.error('Error fetching templates:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get template by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const templateId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const template = await db.query.templates.findFirst({
            where: eq(templates.id, templateId),
        })

        if (!template) {
            return res.status(404).json({ error: 'Template not found' })
        }

        const { organization, membership } = await checkOrganizationAccess(userId, template.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ template })
    } catch (error) {
        console.error('Error fetching template:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create template
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const data = createTemplateSchema.parse(req.body)

        const { organization, membership } = await checkOrganizationAccess(userId, data.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        // Check slug uniqueness within organization
        const existing = await db.query.templates.findFirst({
            where: and(
                eq(templates.organizationId, data.organizationId),
                eq(templates.slug, data.slug)
            ),
        })

        if (existing) {
            return res.status(409).json({ error: 'Template with this slug already exists for this organization' })
        }

        const [template] = await db.insert(templates).values({
            organizationId: data.organizationId,
            name: data.name,
            slug: data.slug,
            subject: data.subject,
            plainBody: data.plainBody,
            htmlBody: data.htmlBody,
            variables: data.variables || [],
        }).returning()

        res.status(201).json({ template })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating template:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update template
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const templateId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const existingTemplate = await db.query.templates.findFirst({
            where: eq(templates.id, templateId),
        })

        if (!existingTemplate) {
            return res.status(404).json({ error: 'Template not found' })
        }

        const { organization, membership } = await checkOrganizationAccess(userId, existingTemplate.organizationId)

        if (!organization || !membership || membership.role === 'viewer') {
            return res.status(403).json({ error: 'Access denied' })
        }

        const data = updateTemplateSchema.parse(req.body)

        // Check slug uniqueness if slug is being changed
        if (data.slug && data.slug !== existingTemplate.slug) {
            const slugExists = await db.query.templates.findFirst({
                where: and(
                    eq(templates.organizationId, existingTemplate.organizationId),
                    eq(templates.slug, data.slug)
                ),
            })

            if (slugExists) {
                return res.status(409).json({ error: 'Template with this slug already exists for this organization' })
            }
        }

        const [updatedTemplate] = await db
            .update(templates)
            .set({
                ...data,
                updatedAt: new Date(),
            })
            .where(eq(templates.id, templateId))
            .returning()

        res.json({ template: updatedTemplate })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating template:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete template
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const templateId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const template = await db.query.templates.findFirst({
            where: eq(templates.id, templateId),
        })

        if (!template) {
            return res.status(404).json({ error: 'Template not found' })
        }

        const { organization, membership } = await checkOrganizationAccess(userId, template.organizationId)

        if (!organization || !membership || membership.role === 'viewer') {
            return res.status(403).json({ error: 'Access denied' })
        }

        await db.delete(templates).where(eq(templates.id, templateId))

        res.json({ message: 'Template deleted successfully' })
    } catch (error) {
        console.error('Error deleting template:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Render template with variables (preview)
router.post('/:id/render', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const templateId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const template = await db.query.templates.findFirst({
            where: eq(templates.id, templateId),
        })

        if (!template) {
            return res.status(404).json({ error: 'Template not found' })
        }

        const { organization, membership } = await checkOrganizationAccess(userId, template.organizationId)

        if (!organization || !membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const variables = z.record(z.string()).default({}).parse(req.body.variables || {})

        // Replace {{variable}} placeholders
        const render = (text: string | null, isHtml: boolean): string | null => {
            if (!text) return text
            return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
                const value = variables[key] ?? `{{${key}}}`
                return isHtml ? escapeHtml(value) : value
            })
        }

        res.json({
            subject: render(template.subject, false),
            plainBody: render(template.plainBody, false),
            htmlBody: render(template.htmlBody, true),
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error rendering template:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
