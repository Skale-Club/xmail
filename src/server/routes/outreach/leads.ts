import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { leads, leadLists } from '../../../db/schema'
import { eq, and, or, sql, ilike, inArray, asc, desc, type SQL } from 'drizzle-orm'
import { requireOutreachRead, requireOutreachWrite } from '../../lib/outreach-access'
import { paginate, paginationQuerySchema } from '../../lib/pagination'
import { mapEmailVerificationCustomFields, resolveLeadVerificationFields } from '../../lib/email-verification-mapping'
import { jsonbParam } from '../../lib/jsonb'
import { withSourceRunId } from '../../lib/prospecting/source-run-id'

const router = Router()

// Bounded, tenant-scoped lead list contract (Phase 20 CONS-05). Every parameter is validated:
// out-of-range or malformed input is a 400, never a silent fallback. `limit` is hard-capped at
// 100. Search is trimmed and length-bounded; sort/status/order are enumerated.
const LEAD_STATUSES = ['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'] as const
const LEAD_SORT_FIELDS = ['createdAt', 'updatedAt', 'email', 'status'] as const

const leadListQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(200).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    leadListId: z.string().uuid().optional(),
    sort: z.enum(LEAD_SORT_FIELDS).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
})

const LEAD_SORT_COLUMNS = {
    createdAt: leads.createdAt,
    updatedAt: leads.updatedAt,
    email: leads.email,
    status: leads.status,
} as const

// Escape LIKE/ILIKE wildcards so a user typing '%', '_', or '\' searches for those literal
// characters instead of injecting a pattern. Postgres ILIKE uses backslash as the default escape
// character, so an escaped '\%' matches a literal '%'.
function escapeLikePattern(input: string): string {
    return input.replace(/[\\%_]/g, (char) => `\\${char}`)
}

// Validation schemas
const createLeadSchema = z.object({
    // audit-2026-07 (H4/#2): normalize email to lowercase at the boundary so suppression
    // (unsubscribe/bounce lists are lowercased) reliably matches, and so the same address
    // can't be stored twice as case variants. Applies to bulk-import too (uses this schema).
    email: z.string().email('Invalid email address').transform(v => v.trim().toLowerCase()),
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

        const membership = await requireOutreachRead(req, res, organizationId)
        if (!membership) return

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

        const membership = await requireOutreachWrite(req, res, organizationId)
        if (!membership) return

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

        const membership = await requireOutreachWrite(req, res, list.organizationId)
        if (!membership) return

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

// List leads: server-side search / filter / sort / pagination, tenant-scoped and bounded.
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await requireOutreachRead(req, res, organizationId)
        if (!membership) return

        const { page, limit, search, status, leadListId, sort, order } = leadListQuerySchema.parse(req.query)
        const offset = (page - 1) * limit

        // Tenant scope first, always. No query parameter can widen it.
        const conditions: SQL[] = [eq(leads.organizationId, organizationId)]

        if (status) conditions.push(eq(leads.status, status))
        if (leadListId) conditions.push(eq(leads.leadListId, leadListId))

        const trimmedSearch = search?.trim()
        if (trimmedSearch) {
            const term = `%${escapeLikePattern(trimmedSearch)}%`
            const searchCondition = or(
                ilike(leads.email, term),
                ilike(leads.firstName, term),
                ilike(leads.lastName, term),
                ilike(leads.companyName, term),
                ilike(leads.title, term),
            )
            if (searchCondition) conditions.push(searchCondition)
        }

        const where = and(...conditions)

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(leads)
            .where(where)

        const total = Number(countResult[0]?.count || 0)

        // Stable ordering: the requested field, then a unique id tie-breaker so equal sort keys
        // never reorder between pages (created_at DESC, id DESC by default).
        const sortColumn = LEAD_SORT_COLUMNS[sort]
        const primaryOrder = order === 'asc' ? asc(sortColumn) : desc(sortColumn)

        const leadsList = await db.query.leads.findMany({
            where,
            limit,
            offset,
            orderBy: [primaryOrder, desc(leads.id)],
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
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
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

        const membership = await requireOutreachRead(req, res, lead.organizationId)
        if (!membership) return

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

        const membership = await requireOutreachWrite(req, res, organizationId)
        if (!membership) return

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

        // Contract mapping (verification-gates step 1): map Xphere's customFields verification
        // signals (email_status/email_verified_at/email_verification_provider) onto the existing
        // emailVerificationStatus/emailVerificationProvider/emailVerifiedAt columns, falling back
        // to the free MX pre-filter only when no status was supplied.
        const verificationFields = await resolveLeadVerificationFields(validatedData.email, validatedData.customFields)

        const [newLead] = await db.insert(leads).values({
            organizationId,
            ...validatedData,
            // jsonbParam, não o binding padrão do Drizzle: sem o cast intermediário via text o
            // Supavisor codifica o valor uma segunda vez e a coluna guarda uma STRING JSON. O ORM
            // desfaz isso na leitura, então nada parece quebrado — mas todo operador jsonb no
            // servidor (`->`, `->>`, `||`, `jsonb_exists`) passa a ver um escalar. Ver lib/jsonb.ts.
            ...(() => {
                const fields = withSourceRunId(validatedData.customFields, validatedData.source)
                return fields ? { customFields: jsonbParam(fields) } : {}
            })(),
            ...verificationFields,
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

        const membership = await requireOutreachWrite(req, res, organizationId)
        if (!membership) return

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
            columns: { id: true, email: true },
        })

        const existingEmails = new Set(existingLeads.map(l => l.email))
        const existingLeadIds = existingLeads.map(l => l.id)

        // Filter out duplicates
        const newLeads = validatedData.leads.filter(l => !existingEmails.has(l.email))
        const duplicateLeads = validatedData.leads.filter(l => existingEmails.has(l.email))

        // Update-if-exists: orchestration re-imports are enrichment syncs, not no-ops. Merge new
        // custom fields (for example Xphere's multilingual websiteInsights) and refresh any
        // explicitly supplied profile fields without erasing existing values. Verification still
        // updates only when the re-import carries a recognized explicit status.
        await Promise.all(duplicateLeads.map(async (lead) => {
            const verification = mapEmailVerificationCustomFields(lead.customFields)
            const profile = {
                ...(lead.firstName !== undefined ? { firstName: lead.firstName } : {}),
                ...(lead.lastName !== undefined ? { lastName: lead.lastName } : {}),
                ...(lead.companyName !== undefined ? { companyName: lead.companyName } : {}),
                ...(lead.companySize !== undefined ? { companySize: lead.companySize } : {}),
                ...(lead.industry !== undefined ? { industry: lead.industry } : {}),
                ...(lead.title !== undefined ? { title: lead.title } : {}),
                ...(lead.website !== undefined ? { website: lead.website } : {}),
                ...(lead.linkedinUrl !== undefined ? { linkedinUrl: lead.linkedinUrl } : {}),
                ...(lead.phone !== undefined ? { phone: lead.phone } : {}),
                ...(lead.location !== undefined ? { location: lead.location } : {}),
            }
            await db.update(leads)
                .set({
                    ...profile,
                    ...verification,
                    ...(lead.customFields ? {
                        // First-touch attribution for `source_run_id` (Phase 32 follow-up):
                        // the general merge below (`||`) lets the new payload win key-for-key,
                        // which is correct for every other custom field — but source_run_id
                        // identifies which prospecting run originally sourced this lead, and
                        // letting a later re-import overwrite it would let a second run
                        // silently steal attribution (and its outcome_* counters) from the
                        // run that actually found the lead first. This mirrors
                        // prospect_candidates.imported_as = 'created', which exists on the
                        // Apollo path for the identical reason — see
                        // measureProspectingOutcomes.ts's attribution-rule comment. So: do
                        // the normal merge, then re-apply whatever source_run_id already
                        // existed (if any) on top, restoring it verbatim.
                        customFields: sql`(COALESCE(${leads.customFields}, '{}'::jsonb) || ${JSON.stringify(lead.customFields)}::jsonb)
                            || CASE WHEN jsonb_exists(${leads.customFields}, 'source_run_id')
                                    THEN jsonb_build_object('source_run_id', ${leads.customFields} -> 'source_run_id')
                                    ELSE '{}'::jsonb END`,
                    } : {}),
                    updatedAt: new Date(),
                })
                .where(and(eq(leads.organizationId, organizationId), eq(leads.email, lead.email)))
        }))

        if (newLeads.length === 0) {
            // Not an error for orchestration callers (e.g. Xphere enrolling prospects):
            // every submitted lead already exists, so return their ids so the caller
            // can still enroll them in a campaign. Idempotent re-imports must succeed.
            return res.status(200).json({
                imported: 0,
                duplicates: validatedData.leads.length,
                leads: [],
                leadIds: existingLeadIds,
            })
        }

        // Contract mapping (verification-gates step 1): map Xphere's customFields verification
        // signals onto the existing verification columns, falling back to the free MX pre-filter
        // (step 4) only when no email_status was supplied.
        const newLeadsWithVerification = await Promise.all(newLeads.map(async (lead) => ({
            lead,
            verification: await resolveLeadVerificationFields(lead.email, lead.customFields),
        })))

        // Insert new leads
        const insertedLeads = await db.insert(leads).values(
            newLeadsWithVerification.map(({ lead, verification }) => ({
                organizationId,
                ...lead,
                // Duas coisas acontecem aqui, e as duas são de atribuição:
                //
                // 1. withSourceRunId carimba a chave canônica `source_run_id` a partir do que o
                //    produtor de fato mandou (o Xphere manda `xcraper_run_id`) ou do próprio
                //    `source`. Sem ela o join do caminho (b) de measureProspectingOutcomes nunca
                //    casa e TODO run de xcraper fica com outcome_* zerado para sempre.
                // 2. jsonbParam impede a dupla codificação do pooler, que quebraria o merge `||` e
                //    o jsonb_exists('source_run_id') do re-import logo acima.
                ...(() => {
                    const fields = withSourceRunId(lead.customFields, lead.source)
                    return fields ? { customFields: jsonbParam(fields) } : {}
                })(),
                leadListId: validatedData.leadListId || lead.leadListId,
                ...verification,
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
            // All resolved lead ids (newly inserted + pre-existing) for the submitted
            // emails, so an orchestrator can enroll the full set in a campaign.
            leadIds: [...insertedLeads.map(l => l.id), ...existingLeadIds],
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

        const membership = await requireOutreachWrite(req, res, lead.organizationId)
        if (!membership) return

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

        const membership = await requireOutreachWrite(req, res, lead.organizationId)
        if (!membership) return

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

        const membership = await requireOutreachWrite(req, res, organizationId)
        if (!membership) return

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
