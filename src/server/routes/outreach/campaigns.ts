import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { campaigns, sequences, sequenceSteps, campaignLeads, leads, organizationUsers, outreachEmails, emailAccounts } from '../../../db/schema'
import { eq, and, sql, inArray, desc } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { computeCampaignMetrics } from '../../lib/outreach-campaign-metrics'
import { resolveOutreachSettings } from '../../lib/outreach-settings'
import { paginate, paginationQuerySchema } from '../../lib/pagination'
import {
    validateSequenceForActivation,
    type SequenceValidationIssue,
} from '../../lib/outreach-sequence-state'
import {
    getCanonicalSequence,
    replaceCanonicalSequence,
    sequencePayloadSchema,
} from '../../lib/outreach-sequences'

const router = Router()

class CampaignEnrollmentClosedError extends Error {}

function resultRows<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[]
    if (value && typeof value === 'object' && 'rows' in value) {
        const rows = (value as { rows?: unknown }).rows
        return Array.isArray(rows) ? rows as T[] : []
    }
    return []
}

// Validation schemas
//
// Defaultable fields are OPTIONAL (not Zod `.default(...)`) so the handler can tell an omitted
// field from an explicit one and inherit the organization's stored settings for the former only
// (Phase 20 CONS-03). Zod `.default()` erases that distinction at parse time.
const createCampaignSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    description: z.string().optional(),
    fromName: z.string().optional(),
    replyToEmail: z.string().email().optional(),
    timezone: z.string().optional(),
    sendOnWeekends: z.boolean().optional(),
    sendStartTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
    sendEndTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
})

const updateCampaignSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    fromName: z.string().optional(),
    replyToEmail: z.string().email().optional(),
    timezone: z.string().optional(),
    sendOnWeekends: z.boolean().optional(),
    sendStartTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
    sendEndTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
    status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
})

const createSequenceSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    description: z.string().optional(),
})

const createSequenceStepSchema = z.object({
    // One-based ordering (migration 040 / sequence_steps_order_positive). The canonical replace
    // endpoint is the primary write surface; this legacy single-step path shares the same invariant.
    stepOrder: z.number().int().min(1),
    type: z.enum(['email', 'delay', 'condition']).default('email'),
    delayHours: z.number().int().min(0).default(0),
    subject: z.string().optional(),
    plainBody: z.string().optional(),
    htmlBody: z.string().optional(),
    subjectB: z.string().optional(),
    plainBodyB: z.string().optional(),
    htmlBodyB: z.string().optional(),
    abTestEnabled: z.boolean().default(false),
    abTestPercentage: z.number().int().min(0).max(100).default(50),
})

const addLeadsToCampaignSchema = z.object({
    leadIds: z.array(z.string().uuid()).min(1),
    emailAccountId: z.string().uuid().optional(),
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

// P009 — the domains cold outreach must NOT send from (primary transactional domain).
// Sourced from MAIL_DOMAIN plus an optional OUTREACH_PROTECTED_DOMAINS (comma-separated) override.
function getProtectedSendingDomains(): Set<string> {
    const raw = [process.env.MAIL_DOMAIN, process.env.OUTREACH_PROTECTED_DOMAINS]
        .filter((v): v is string => Boolean(v))
        .join(',')
    return new Set(
        raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
    )
}

type CampaignActivationIssue = SequenceValidationIssue | {
    code:
        | 'sequence_missing'
        | 'sequence_empty'
        | 'campaign_missing_leads'
        | 'lead_missing_email_account'
        | 'email_account_invalid'
        | 'protected_sending_domain'
    message: string
}

async function validateCampaignReadyForActivation(campaignId: string, organizationId: string): Promise<CampaignActivationIssue[]> {
    const issues: CampaignActivationIssue[] = []

    // One database-enforced canonical sequence per campaign (Phase 20). Resolve it through the
    // canonical service instead of any first-row convention.
    const canonicalSequence = await getCanonicalSequence(campaignId, organizationId)

    if (!canonicalSequence) {
        issues.push({ code: 'sequence_missing', message: 'Campaign needs at least one sequence.' })
    } else if (canonicalSequence.steps.length === 0) {
        issues.push({ code: 'sequence_empty', message: 'Campaign sequence needs at least one step.' })
    } else {
        issues.push(...validateSequenceForActivation(canonicalSequence.steps))
    }

    const assignedLeads = await db.query.campaignLeads.findMany({
        where: eq(campaignLeads.campaignId, campaignId),
        columns: { assignedEmailAccountId: true },
    })
    if (assignedLeads.length === 0) {
        issues.push({ code: 'campaign_missing_leads', message: 'Campaign needs at least one lead.' })
    }

    // audit-2026-07 (API High #1): the old check compared the DEDUPED set of account ids to
    // the lead count, so it wrongly failed whenever two or more leads shared the same inbox
    // (the normal case — the add-leads path assigns one inbox to a whole batch). The invariant
    // is "no lead has a NULL inbox", so test that directly.
    const leadMissingInbox = assignedLeads.some(lead => !lead.assignedEmailAccountId)
    if (leadMissingInbox) {
        issues.push({
            code: 'lead_missing_email_account',
            message: 'Every campaign lead needs an assigned sending inbox.',
        })
    }

    const assignedAccountIds = [...new Set(assignedLeads.map(lead => lead.assignedEmailAccountId).filter((id): id is string => Boolean(id)))]

    if (assignedAccountIds.length > 0) {
        const verifiedAccounts = await db.query.emailAccounts.findMany({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                eq(emailAccounts.status, 'verified'),
                inArray(emailAccounts.id, assignedAccountIds)
            ),
            columns: { id: true, email: true },
        })
        if (verifiedAccounts.length !== assignedAccountIds.length) {
            issues.push({
                code: 'email_account_invalid',
                message: 'Every assigned sending inbox must belong to this organization and be verified.',
            })
        }

        // P009 — reputation isolation: cold outreach must never send from the primary
        // transactional domain (mx.skale.club / MAIL_DOMAIN), which would burn its reputation.
        // Use disposable provider (IceMail/Primeforge) inboxes instead.
        const protectedDomains = getProtectedSendingDomains()
        if (protectedDomains.size > 0) {
            const offending = verifiedAccounts.filter(a => {
                const domain = a.email.split('@')[1]?.toLowerCase()
                return domain != null && protectedDomains.has(domain)
            })
            if (offending.length > 0) {
                issues.push({
                    code: 'protected_sending_domain',
                    message: `Cold outreach cannot send from the primary domain (${offending.map(a => a.email).join(', ')}). ` +
                        'Assign a disposable/provider inbox instead.',
                })
            }
        }
    }

    return issues
}

// ============ CAMPAIGNS ============

// List campaigns
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string
        const status = req.query.status as string

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

        const conditions = [eq(campaigns.organizationId, organizationId)]

        if (status) {
            conditions.push(eq(campaigns.status, status as any))
        }

        const result = await paginate(db, campaigns, {
            where: and(...conditions),
            page,
            limit,
            orderBy: desc(campaigns.createdAt),
            with: {
                sequences: {
                    with: {
                        steps: {
                            columns: {
                                htmlBody: false,
                                plainBody: false,
                                htmlBodyB: false,
                                plainBodyB: false,
                            },
                        },
                    },
                },
            },
        })

        // audit-2026-07 (frontend C1 / data M2): the list UI renders emailsSent, openRate,
        // clickRate, replyRate and bounceRate per campaign — fields the raw campaign row does
        // NOT contain, so the client crashed on `undefined.toFixed()`. Compute them here from
        // outreach_emails using the SAME cohort/semantics as the admin health endpoint
        // (src/server/lib/outreach-metrics.ts): denominator = emails actually sent, numerators
        // = unique emails with the corresponding timestamp set. Single grouped query.
        const campaignRows = result.data as Array<Record<string, unknown> & { id: string }>
        const campaignIdList = campaignRows.map(c => c.id)
        const metricsByCampaign = new Map<string, {
            emailsSent: number; openRate: number; clickRate: number; replyRate: number; bounceRate: number
        }>()

        if (campaignIdList.length > 0) {
            const agg = await db
                .select({
                    campaignId: outreachEmails.campaignId,
                    sent: sql<number>`count(*) FILTER (WHERE ${outreachEmails.sentAt} IS NOT NULL)`,
                    opened: sql<number>`count(*) FILTER (WHERE ${outreachEmails.openedAt} IS NOT NULL)`,
                    clicked: sql<number>`count(*) FILTER (WHERE ${outreachEmails.clickedAt} IS NOT NULL)`,
                    replied: sql<number>`count(*) FILTER (WHERE ${outreachEmails.repliedAt} IS NOT NULL)`,
                    bounced: sql<number>`count(*) FILTER (WHERE ${outreachEmails.bouncedAt} IS NOT NULL)`,
                })
                .from(outreachEmails)
                .where(and(
                    eq(outreachEmails.organizationId, organizationId),
                    inArray(outreachEmails.campaignId, campaignIdList),
                ))
                .groupBy(outreachEmails.campaignId)

            for (const row of agg) {
                if (!row.campaignId) continue
                const sent = Number(row.sent) || 0
                const rate = (n: number) => (sent > 0 ? Math.round((Number(n) / sent) * 1000) / 10 : 0)
                metricsByCampaign.set(row.campaignId, {
                    emailsSent: sent,
                    openRate: rate(row.opened),
                    clickRate: rate(row.clicked),
                    replyRate: rate(row.replied),
                    bounceRate: rate(row.bounced),
                })
            }
        }

        const campaignsWithMetrics = campaignRows.map(c => ({
            ...c,
            ...(metricsByCampaign.get(c.id) ?? { emailsSent: 0, openRate: 0, clickRate: 0, replyRate: 0, bounceRate: 0 }),
        }))

        res.json({ campaigns: campaignsWithMetrics, pagination: result.pagination })
    } catch (error) {
        console.error('Error fetching campaigns:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get global stats for all campaigns in an organization
// NOTE: Must be registered before /:id to avoid Express matching "stats" as an ID
router.get('/stats', async (req: Request, res: Response) => {
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

        // Get all campaigns for the organization
        const campaignsList = await db.query.campaigns.findMany({
            where: eq(campaigns.organizationId, organizationId),
            columns: { id: true, status: true },
        })

        if (campaignsList.length === 0) {
            return res.json({
                totalCampaigns: 0,
                activeCampaigns: 0,
                totalLeads: 0,
                totalEmails: 0,
                openRate: 0,
                clickRate: 0,
                replyRate: 0,
                bounceRate: 0,
            })
        }

        const campaignIds = campaignsList.map(c => c.id)

        // Shared with /analytics and /:id/stats — see outreach-campaign-metrics.ts for why the
        // rates are per unique lead rather than per event.
        const metrics = await computeCampaignMetrics(campaignIds)
        const activeCampaigns = campaignsList.filter(c => c.status === 'active').length

        res.json({
            totalCampaigns: campaignsList.length,
            activeCampaigns,
            totalLeads: metrics.totalLeads,
            totalEmails: metrics.contacted,
            openRate: metrics.openRate,
            clickRate: metrics.clickRate,
            replyRate: metrics.replyRate,
            bounceRate: metrics.bounceRate,
        })
    } catch (error) {
        console.error('Error fetching campaign stats:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// List all sequences across all campaigns for an organization
// NOTE: Must be registered before /:id to avoid Express matching "sequences" as an ID
router.get('/sequences', async (req: Request, res: Response) => {
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

        const orgCampaigns = await db.query.campaigns.findMany({
            where: eq(campaigns.organizationId, organizationId),
            columns: { id: true },
        })

        if (orgCampaigns.length === 0) {
            return res.json({ sequences: [], pagination: { page, limit, total: 0, totalPages: 0 } })
        }

        const campaignIds = orgCampaigns.map(c => c.id)

        const result = await paginate(db, sequences, {
            where: inArray(sequences.campaignId, campaignIds),
            page,
            limit,
            with: {
                campaign: {
                    columns: {
                        id: true,
                        name: true,
                    },
                },
                steps: true,
            },
        })

        res.json({ sequences: result.data, pagination: result.pagination })
    } catch (error) {
        console.error('Error fetching sequences:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get aggregated analytics for an organization
// NOTE: Must be registered before /:id to avoid Express matching "analytics" as an ID
router.get('/analytics', async (req: Request, res: Response) => {
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

        const campaignsList = await db.query.campaigns.findMany({
            where: eq(campaigns.organizationId, organizationId),
            columns: { id: true, status: true },
        })

        // Previously summed the denormalized campaigns.* counters while /stats aggregated
        // campaign_leads, so the dashboard and the analytics page disagreed about the same org.
        // Both now read the same function over the same rows.
        const metrics = await computeCampaignMetrics(campaignsList.map(c => c.id))
        const activeCampaigns = campaignsList.filter(c => c.status === 'active').length

        res.json({
            overview: {
                totalCampaigns: campaignsList.length,
                activeCampaigns,
                totalLeads: metrics.totalLeads,
                totalEmailsSent: metrics.contacted,
                totalOpens: metrics.totalOpens,
                totalClicks: metrics.totalClicks,
                totalReplies: metrics.totalReplies,
                totalBounces: metrics.bouncedLeads,
                avgOpenRate: metrics.openRate,
                avgClickRate: metrics.clickRate,
                avgReplyRate: metrics.replyRate,
                avgBounceRate: metrics.bounceRate,
            },
        })
    } catch (error) {
        console.error('Error fetching analytics:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get daily analytics for an organization
router.get('/analytics/daily', async (req: Request, res: Response) => {
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

        const orgCampaigns = await db.query.campaigns.findMany({
            where: eq(campaigns.organizationId, organizationId),
            columns: { id: true },
        })

        if (orgCampaigns.length === 0) {
            return res.json([])
        }

        const campaignIds = orgCampaigns.map(c => c.id)

        // Get daily stats from outreach_emails for the last 30 days
        const dailyStats = await db
            .select({
                date: sql<string>`date_trunc('day', ${outreachEmails.sentAt})::date::text`,
                emailsSent: sql<number>`count(*)`,
                opens: sql<number>`count(*) filter (where ${outreachEmails.openedAt} is not null)`,
                clicks: sql<number>`count(*) filter (where ${outreachEmails.clickedAt} is not null)`,
                replies: sql<number>`count(*) filter (where ${outreachEmails.repliedAt} is not null)`,
            })
            .from(outreachEmails)
            .where(and(
                inArray(outreachEmails.campaignId, campaignIds),
                sql`${outreachEmails.sentAt} >= now() - interval '30 days'`
            ))
            .groupBy(sql`date_trunc('day', ${outreachEmails.sentAt})::date`)
            .orderBy(sql`date_trunc('day', ${outreachEmails.sentAt})::date`)

        res.json(dailyStats)
    } catch (error) {
        console.error('Error fetching daily analytics:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get campaign by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
            with: {
                sequences: {
                    with: {
                        steps: {
                            orderBy: (steps, { asc }) => [asc(steps.stepOrder)],
                        },
                    },
                },
            },
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({ campaign })
    } catch (error) {
        console.error('Error fetching campaign:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create campaign
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

        const validatedData = createCampaignSchema.parse(req.body)

        // Omitted schedule/tracking fields inherit the organization's stored defaults; explicit
        // request values always win. Resolved once at creation — later default changes never
        // rewrite this campaign.
        const settings = await resolveOutreachSettings(organizationId)
        const campaignValues = {
            name: validatedData.name,
            description: validatedData.description,
            fromName: validatedData.fromName,
            replyToEmail: validatedData.replyToEmail,
            timezone: validatedData.timezone ?? settings.defaultTimezone,
            sendOnWeekends: validatedData.sendOnWeekends ?? settings.sendOnWeekends,
            sendStartTime: validatedData.sendStartTime ?? settings.defaultSendStartTime,
            sendEndTime: validatedData.sendEndTime ?? settings.defaultSendEndTime,
            trackOpens: validatedData.trackOpens ?? settings.trackOpens,
            trackClicks: validatedData.trackClicks ?? settings.trackClicks,
        }

        // Campaign creation and its single canonical sequence are one transaction (Phase 20):
        // a campaign never exists without exactly one sequence, and a failure creates neither.
        const { newCampaign, defaultSequence } = await db.transaction(async (tx) => {
            const [campaign] = await tx.insert(campaigns).values({
                organizationId,
                ...campaignValues,
            }).returning()

            const [sequence] = await tx.insert(sequences).values({
                campaignId: campaign.id,
                name: 'Main Sequence',
                description: 'Default email sequence for this campaign',
            }).returning()

            return { newCampaign: campaign, defaultSequence: sequence }
        })

        res.status(201).json({
            campaign: newCampaign,
            sequence: defaultSequence,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating campaign:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update campaign
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = updateCampaignSchema.parse(req.body)

        const updateData: any = { ...validatedData, updatedAt: new Date() }

        // Handle status changes
        if (validatedData.status === 'active' && campaign.status !== 'active') {
            const readinessIssues = await validateCampaignReadyForActivation(campaignId, campaign.organizationId)
            if (readinessIssues.length > 0) {
                return res.status(422).json({
                    error: 'Campaign is not ready to activate',
                    issues: readinessIssues,
                    // Retain human-readable details for existing clients while the stable
                    // `issues[].code` contract becomes the programmatic integration surface.
                    details: readinessIssues.map((issue) => issue.message),
                })
            }
            updateData.startedAt = new Date()
        } else if (validatedData.status === 'completed' && campaign.status !== 'completed') {
            updateData.completedAt = new Date()
        }

        const [updatedCampaign] = await db.update(campaigns)
            .set(updateData)
            .where(eq(campaigns.id, campaignId))
            .returning()

        if (!updatedCampaign) return res.status(500).json({ error: 'Update failed — record not found' })

        res.json({ campaign: updatedCampaign })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating campaign:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete campaign
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        // Wrap in transaction for defense-in-depth. The schema-level ON DELETE CASCADE
        // (migration 020) handles sequences, sequence_steps, campaign_leads, outreach_emails
        // automatically. If a future relation is added without cascade, add explicit
        // tx.delete(...) calls here BEFORE the campaigns delete. See audit P0-10.
        await db.transaction(async (tx) => {
            await tx.delete(campaigns).where(eq(campaigns.id, campaignId))
        })

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting campaign:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============ CANONICAL SEQUENCE (Phase 20) ============

// Get the single canonical sequence for a campaign.
router.get('/:campaignId/sequence', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
            columns: { id: true, organizationId: true },
        })
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const sequence = await getCanonicalSequence(campaignId, campaign.organizationId)
        res.json({ sequence })
    } catch (error) {
        console.error('Error fetching canonical sequence:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Replace the campaign's complete ordered step set transactionally.
router.put('/:campaignId/sequence', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
            columns: { id: true, organizationId: true },
        })
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const payload = sequencePayloadSchema.parse(req.body)
        const result = await replaceCanonicalSequence({
            campaignId,
            organizationId: campaign.organizationId,
            payload,
        })

        if (!result.ok) {
            if (result.reason === 'campaign_not_found') {
                return res.status(404).json({ error: 'Campaign not found' })
            }
            if (result.reason === 'campaign_not_editable') {
                return res.status(409).json({
                    error: `Cannot edit the sequence of a ${result.status} campaign — pause it first`,
                    code: 'campaign_not_editable',
                    status: result.status,
                })
            }
            return res.status(409).json({
                error: 'Cannot remove sequence steps that already have send history or active leads',
                code: 'sequence_step_referenced',
                conflicts: result.conflicts,
            })
        }

        res.json({ sequence: result.sequence })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error replacing canonical sequence:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============ SEQUENCES (legacy compatibility adapters) ============

// Deprecated: returns the single canonical sequence wrapped in an array for older clients.
router.get('/:campaignId/sequences', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
            columns: { id: true, organizationId: true },
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.setHeader('Deprecation', 'true')
        res.setHeader('Link', `</api/outreach/campaigns/${campaignId}/sequence>; rel="successor-version"`)
        const canonical = await getCanonicalSequence(campaignId, campaign.organizationId)
        res.json({ sequences: canonical ? [canonical] : [], deprecated: true })
    } catch (error) {
        console.error('Error fetching sequences:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Deprecated: a campaign has exactly one canonical sequence, so this never creates a second row —
// it returns the existing canonical sequence (creating one only if the campaign somehow lacks it).
router.post('/:campaignId/sequences', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
            columns: { id: true, organizationId: true },
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = createSequenceSchema.parse(req.body)

        res.setHeader('Deprecation', 'true')
        res.setHeader('Link', `</api/outreach/campaigns/${campaignId}/sequence>; rel="successor-version"`)

        const existing = await getCanonicalSequence(campaignId, campaign.organizationId)
        if (existing) {
            return res.status(200).json({ sequence: existing, deprecated: true })
        }

        const [newSequence] = await db.insert(sequences).values({
            campaignId,
            ...validatedData,
        }).returning()

        res.status(201).json({ sequence: newSequence, deprecated: true })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating sequence:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete sequence
router.delete('/sequences/:sequenceId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const sequenceId = req.params.sequenceId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const sequence = await db.query.sequences.findFirst({
            where: eq(sequences.id, sequenceId),
            with: {
                campaign: true,
            },
        })

        if (!sequence) {
            return res.status(404).json({ error: 'Sequence not found' })
        }

        const membership = await checkOrgMembership(userId, sequence.campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        await db.delete(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequenceId))
        await db.delete(sequences).where(eq(sequences.id, sequenceId))

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting sequence:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============ SEQUENCE STEPS ============

// Add step to sequence
router.post('/sequences/:sequenceId/steps', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const sequenceId = req.params.sequenceId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const sequence = await db.query.sequences.findFirst({
            where: eq(sequences.id, sequenceId),
            with: {
                campaign: true,
            },
        })

        if (!sequence) {
            return res.status(404).json({ error: 'Sequence not found' })
        }

        const membership = await checkOrgMembership(userId, sequence.campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = createSequenceStepSchema.parse(req.body)

        const [newStep] = await db.insert(sequenceSteps).values({
            sequenceId,
            ...validatedData,
        }).returning()

        res.status(201).json({ step: newStep })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating sequence step:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update sequence step
router.put('/sequences/steps/:stepId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const stepId = req.params.stepId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const step = await db.query.sequenceSteps.findFirst({
            where: eq(sequenceSteps.id, stepId),
            with: {
                sequence: {
                    with: {
                        campaign: true,
                    },
                },
            },
        })

        if (!step) {
            return res.status(404).json({ error: 'Step not found' })
        }

        const membership = await checkOrgMembership(userId, step.sequence.campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = createSequenceStepSchema.partial().parse(req.body)

        const [updatedStep] = await db.update(sequenceSteps)
            .set({
                ...validatedData,
                updatedAt: new Date(),
            })
            .where(eq(sequenceSteps.id, stepId))
            .returning()

        if (!updatedStep) return res.status(500).json({ error: 'Update failed — record not found' })

        res.json({ step: updatedStep })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating sequence step:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete sequence step
router.delete('/sequences/steps/:stepId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const stepId = req.params.stepId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const step = await db.query.sequenceSteps.findFirst({
            where: eq(sequenceSteps.id, stepId),
            with: {
                sequence: {
                    with: {
                        campaign: true,
                    },
                },
            },
        })

        if (!step) {
            return res.status(404).json({ error: 'Step not found' })
        }

        const membership = await checkOrgMembership(userId, step.sequence.campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        await db.delete(sequenceSteps).where(eq(sequenceSteps.id, stepId))

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting sequence step:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============ CAMPAIGN LEADS ============

// Get leads in campaign
router.get('/:campaignId/leads', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId
        const page = parseInt(req.query.page as string) || 1
        const limit = parseInt(req.query.limit as string) || 50
        const status = req.query.status as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const offset = (page - 1) * limit

        const conditions = [eq(campaignLeads.campaignId, campaignId)]

        if (status) {
            conditions.push(eq(campaignLeads.status, status as any))
        }

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(campaignLeads)
            .where(and(...conditions))

        const total = Number(countResult[0]?.count || 0)

        const campaignLeadsList = await db.query.campaignLeads.findMany({
            where: and(...conditions),
            limit,
            offset,
            with: {
                lead: true,
                assignedEmailAccount: true,
                currentStep: {
                    columns: {
                        id: true,
                        sequenceId: true,
                        stepOrder: true,
                        type: true,
                        delayHours: true,
                        subject: true,
                        abTestEnabled: true,
                        abTestPercentage: true,
                        totalSent: true,
                        totalOpens: true,
                        totalClicks: true,
                        totalReplies: true,
                        createdAt: true,
                        updatedAt: true,
                        htmlBody: false,
                        plainBody: false,
                        htmlBodyB: false,
                        plainBodyB: false,
                    },
                },
            },
            orderBy: (campaignLeads, { desc }) => [desc(campaignLeads.createdAt)],
        })

        res.json({
            campaignLeads: campaignLeadsList,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        })
    } catch (error) {
        console.error('Error fetching campaign leads:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Add leads to campaign
router.post('/:campaignId/leads', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }
        if (campaign.status === 'completed' || campaign.status === 'archived') {
            return res.status(409).json({
                error: `Cannot enroll leads into a ${campaign.status} campaign`,
                code: 'campaign_enrollment_closed',
            })
        }

        const validatedData = addLeadsToCampaignSchema.parse(req.body)

        if (validatedData.emailAccountId) {
            const account = await db.query.emailAccounts.findFirst({
                where: and(
                    eq(emailAccounts.id, validatedData.emailAccountId),
                    eq(emailAccounts.organizationId, campaign.organizationId)
                ),
                columns: { id: true },
            })
            if (!account) {
                return res.status(400).json({ error: 'Email account not found or access denied' })
            }
        }

        // Verify leads exist and belong to organization
        const leadsList = await db.query.leads.findMany({
            where: and(
                eq(leads.organizationId, campaign.organizationId),
                inArray(leads.id, validatedData.leadIds)
            ),
        })

        if (leadsList.length !== validatedData.leadIds.length) {
            return res.status(400).json({ error: 'Some leads not found or access denied' })
        }

        // Check for existing campaign leads
        const existingCampaignLeads = await db.query.campaignLeads.findMany({
            where: and(
                eq(campaignLeads.campaignId, campaignId),
                inArray(campaignLeads.leadId, validatedData.leadIds)
            ),
            columns: { leadId: true },
        })

        const existingLeadIds = new Set(existingCampaignLeads.map(cl => cl.leadId))

        // Filter out existing leads
        const newLeadIds = validatedData.leadIds.filter(id => !existingLeadIds.has(id))

        if (newLeadIds.length === 0) {
            // Not an error for orchestration callers (e.g. Xphere enrolling prospects):
            // every submitted lead is already in the campaign. Idempotent retries must
            // succeed rather than fail with a 400 — see leads.ts bulk-import for the
            // matching fix.
            return res.status(200).json({ added: 0, existing: existingLeadIds.size, campaignLeads: [] })
        }

        // Enroll onto the campaign's single canonical sequence (Phase 20) — no first-row
        // convention. Its steps are returned ordered, so steps[0] is the true first step.
        const canonicalSequence = await getCanonicalSequence(campaignId, campaign.organizationId)

        if (!canonicalSequence) {
            return res.status(400).json({
                error: 'Campaign has no sequence — create a sequence with at least one step before adding leads',
            })
        }

        const firstStep = canonicalSequence.steps[0]

        if (!firstStep) {
            return res.status(400).json({
                error: 'Campaign sequence has no steps — add at least one step before adding leads',
            })
        }

        // Add leads to campaign. nextScheduledAt MUST be non-NULL or the processor's
        // lte(nextScheduledAt, now) filter treats the row as not-yet-due (NULL semantics in SQL).
        // See audit P0-01.
        const insertedCampaignLeads = await db.transaction(async (tx) => {
            const lockedCampaign = resultRows<{ status: string }>(await tx.execute(sql`
                SELECT status::text AS status
                FROM campaigns
                WHERE id = ${campaignId}::uuid
                FOR UPDATE
            `))[0]
            if (!lockedCampaign) throw new CampaignEnrollmentClosedError('Campaign no longer exists')
            if (lockedCampaign.status === 'completed' || lockedCampaign.status === 'archived') {
                throw new CampaignEnrollmentClosedError(`Cannot enroll leads into a ${lockedCampaign.status} campaign`)
            }

            const currentRows = await tx
                .select({ leadId: campaignLeads.leadId })
                .from(campaignLeads)
                .where(and(
                    eq(campaignLeads.campaignId, campaignId),
                    inArray(campaignLeads.leadId, newLeadIds),
                ))
            const currentLeadIds = new Set(currentRows.map((row) => row.leadId))
            const lockedNewLeadIds = newLeadIds.filter((leadId) => !currentLeadIds.has(leadId))
            if (lockedNewLeadIds.length === 0) return []

            const now = new Date()
            const inserted = await tx.insert(campaignLeads).values(
                lockedNewLeadIds.map((leadId) => ({
                    campaignId,
                    leadId,
                    assignedEmailAccountId: validatedData.emailAccountId,
                    currentStepId: firstStep.id,
                    currentStepOrder: firstStep.stepOrder,
                    nextScheduledAt: now,
                })),
            ).returning()
            await tx.update(campaigns)
                .set({ totalLeads: sql`${campaigns.totalLeads} + ${inserted.length}` })
                .where(eq(campaigns.id, campaignId))
            return inserted
        })

        res.status(201).json({
            added: insertedCampaignLeads.length,
            existing: validatedData.leadIds.length - insertedCampaignLeads.length,
            campaignLeads: insertedCampaignLeads,
        })
    } catch (error) {
        if (error instanceof CampaignEnrollmentClosedError) {
            return res.status(409).json({ error: error.message, code: 'campaign_enrollment_closed' })
        }
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error adding leads to campaign:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Remove lead from campaign
router.delete('/:campaignId/leads/:leadId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.campaignId
        const leadId = req.params.leadId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        await db.delete(campaignLeads)
            .where(and(
                eq(campaignLeads.campaignId, campaignId),
                eq(campaignLeads.leadId, leadId)
            ))

        // Update campaign total leads count
        await db.update(campaigns)
            .set({
                totalLeads: sql`GREATEST(0, ${campaigns.totalLeads} - 1)`,
            })
            .where(eq(campaigns.id, campaignId))

        res.json({ success: true })
    } catch (error) {
        console.error('Error removing lead from campaign:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// ============ CAMPAIGN STATS ============

// Get campaign statistics
router.get('/:id/stats', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const campaignId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const campaign = await db.query.campaigns.findFirst({
            where: eq(campaigns.id, campaignId),
        })

        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' })
        }

        const membership = await checkOrgMembership(userId, campaign.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const metrics = await computeCampaignMetrics([campaignId])

        // `replied`/`bounced` are kept as aliases: this endpoint's original shape, which the
        // campaign Stats and Overview tabs already read. The rates are now served alongside them
        // so the client stops doing its own division (it was dividing event totals by contacted,
        // producing a different "open rate" than the dashboard showed for the same campaign).
        res.json({
            stats: {
                ...metrics,
                replied: metrics.repliedLeads,
                bounced: metrics.bouncedLeads,
            },
        })
    } catch (error) {
        console.error('Error fetching campaign stats:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
