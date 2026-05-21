import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { campaigns, sequences, sequenceSteps, campaignLeads, leads, emailAccounts, organizationUsers, outreachEmails } from '../../../db/schema'
import { eq, and, sql, inArray, desc, asc } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { paginate, paginationQuerySchema } from '../../lib/pagination'

const router = Router()

// Validation schemas
const createCampaignSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    description: z.string().optional(),
    fromName: z.string().optional(),
    replyToEmail: z.string().email().optional(),
    timezone: z.string().default('UTC'),
    sendOnWeekends: z.boolean().default(false),
    sendStartTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).default('09:00'),
    sendEndTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).default('17:00'),
    trackOpens: z.boolean().default(true),
    trackClicks: z.boolean().default(true),
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
    stepOrder: z.number().int().min(0),
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

        res.json({ campaigns: result.data, pagination: result.pagination })
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

        // Get aggregated stats from all campaign_leads for this org
        const statsResult = await db
            .select({
                totalLeads: sql<number>`count(*)`,
                contacted: sql<number>`count(*) filter (where ${campaignLeads.status} != 'new')`,
                replied: sql<number>`count(*) filter (where ${campaignLeads.status} = 'replied' or ${campaignLeads.status} = 'interested')`,
                bounced: sql<number>`count(*) filter (where ${campaignLeads.status} = 'bounced')`,
                totalOpens: sql<number>`coalesce(sum(${campaignLeads.totalOpens}), 0)`,
                totalClicks: sql<number>`coalesce(sum(${campaignLeads.totalClicks}), 0)`,
                totalReplies: sql<number>`coalesce(sum(${campaignLeads.totalReplies}), 0)`,
            })
            .from(campaignLeads)
            .where(inArray(campaignLeads.campaignId, campaignIds))

        const stats = statsResult[0] || {
            totalLeads: 0,
            contacted: 0,
            replied: 0,
            bounced: 0,
            totalOpens: 0,
            totalClicks: 0,
            totalReplies: 0,
        }

        const activeCampaigns = campaignsList.filter(c => c.status === 'active').length

        // Calculate rates
        const totalEmails = Number(stats.contacted) || 0
        const openRate = totalEmails > 0 ? (Number(stats.totalOpens) / totalEmails) * 100 : 0
        const clickRate = totalEmails > 0 ? (Number(stats.totalClicks) / totalEmails) * 100 : 0
        const replyRate = totalEmails > 0 ? (Number(stats.replied) / totalEmails) * 100 : 0
        const bounceRate = totalEmails > 0 ? (Number(stats.bounced) / totalEmails) * 100 : 0

        res.json({
            totalCampaigns: campaignsList.length,
            activeCampaigns,
            totalLeads: Number(stats.totalLeads) || 0,
            totalEmails,
            openRate,
            clickRate,
            replyRate,
            bounceRate,
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
        })

        const activeCampaigns = campaignsList.filter(c => c.status === 'active').length
        const totalLeads = campaignsList.reduce((sum, c) => sum + (c.totalLeads || 0), 0)
        const totalEmailsSent = campaignsList.reduce((sum, c) => sum + (c.leadsContacted || 0), 0)
        const totalOpens = campaignsList.reduce((sum, c) => sum + (c.totalOpens || 0), 0)
        const totalClicks = campaignsList.reduce((sum, c) => sum + (c.totalClicks || 0), 0)
        const totalReplies = campaignsList.reduce((sum, c) => sum + (c.totalReplies || 0), 0)
        const totalBounces = campaignsList.reduce((sum, c) => sum + (c.totalBounces || 0), 0)

        const avgOpenRate = totalEmailsSent > 0 ? (totalOpens / totalEmailsSent) * 100 : 0
        const avgClickRate = totalEmailsSent > 0 ? (totalClicks / totalEmailsSent) * 100 : 0
        const avgReplyRate = totalEmailsSent > 0 ? (totalReplies / totalEmailsSent) * 100 : 0
        const avgBounceRate = totalEmailsSent > 0 ? (totalBounces / totalEmailsSent) * 100 : 0

        res.json({
            overview: {
                totalCampaigns: campaignsList.length,
                activeCampaigns,
                totalLeads,
                totalEmailsSent,
                totalOpens,
                totalClicks,
                totalReplies,
                totalBounces,
                avgOpenRate,
                avgClickRate,
                avgReplyRate,
                avgBounceRate,
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

        const validatedData = createCampaignSchema.parse(req.body)

        const [newCampaign] = await db.insert(campaigns).values({
            organizationId,
            ...validatedData,
        }).returning()

        // Create default sequence
        const [defaultSequence] = await db.insert(sequences).values({
            campaignId: newCampaign.id,
            name: 'Main Sequence',
            description: 'Default email sequence for this campaign',
        }).returning()

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

        const validatedData = updateCampaignSchema.parse(req.body)

        const updateData: any = { ...validatedData, updatedAt: new Date() }

        // Handle status changes
        if (validatedData.status === 'active' && campaign.status !== 'active') {
            updateData.startedAt = new Date()
        } else if (validatedData.status === 'completed' && campaign.status !== 'completed') {
            updateData.completedAt = new Date()
        }

        const [updatedCampaign] = await db.update(campaigns)
            .set(updateData)
            .where(eq(campaigns.id, campaignId))
            .returning()

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

// ============ SEQUENCES ============

// Get sequence for campaign
router.get('/:campaignId/sequences', async (req: Request, res: Response) => {
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

        const sequencesList = await db.query.sequences.findMany({
            where: eq(sequences.campaignId, campaignId),
            with: {
                steps: {
                    orderBy: (steps, { asc }) => [asc(steps.stepOrder)],
                },
            },
        })

        res.json({ sequences: sequencesList })
    } catch (error) {
        console.error('Error fetching sequences:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create sequence
router.post('/:campaignId/sequences', async (req: Request, res: Response) => {
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

        const validatedData = createSequenceSchema.parse(req.body)

        const [newSequence] = await db.insert(sequences).values({
            campaignId,
            ...validatedData,
        }).returning()

        res.status(201).json({ sequence: newSequence })
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

        const validatedData = createSequenceStepSchema.partial().parse(req.body)

        const [updatedStep] = await db.update(sequenceSteps)
            .set({
                ...validatedData,
                updatedAt: new Date(),
            })
            .where(eq(sequenceSteps.id, stepId))
            .returning()

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

        const validatedData = addLeadsToCampaignSchema.parse(req.body)

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
            return res.status(400).json({ error: 'All leads already in campaign', added: 0, existing: existingLeadIds.size })
        }

        // Get first step of sequence — two sequential queries (the previous subquery was
        // a Drizzle anti-pattern that generated invalid SQL and was non-deterministic when
        // a campaign had multiple sequences). See audit P0-09.
        const firstSequence = await db.query.sequences.findFirst({
            where: eq(sequences.campaignId, campaignId),
            orderBy: [asc(sequences.createdAt)],
        })

        if (!firstSequence) {
            return res.status(400).json({
                error: 'Campaign has no sequence — create a sequence with at least one step before adding leads',
            })
        }

        const firstStep = await db.query.sequenceSteps.findFirst({
            where: eq(sequenceSteps.sequenceId, firstSequence.id),
            orderBy: [asc(sequenceSteps.stepOrder)],
        })

        if (!firstStep) {
            return res.status(400).json({
                error: 'Campaign sequence has no steps — add at least one step before adding leads',
            })
        }

        // Add leads to campaign. nextScheduledAt MUST be non-NULL or the processor's
        // lte(nextScheduledAt, now) filter treats the row as not-yet-due (NULL semantics in SQL).
        // See audit P0-01.
        const now = new Date()
        const insertedCampaignLeads = await db.insert(campaignLeads).values(
            newLeadIds.map(leadId => ({
                campaignId,
                leadId,
                assignedEmailAccountId: validatedData.emailAccountId,
                currentStepId: firstStep.id,
                currentStepOrder: firstStep.stepOrder,
                nextScheduledAt: now,
            }))
        ).returning()

        // Update campaign total leads count
        await db.update(campaigns)
            .set({
                totalLeads: sql`${campaigns.totalLeads} + ${insertedCampaignLeads.length}`,
            })
            .where(eq(campaigns.id, campaignId))

        res.status(201).json({
            added: insertedCampaignLeads.length,
            existing: existingLeadIds.size,
            campaignLeads: insertedCampaignLeads,
        })
    } catch (error) {
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

        // Get aggregated stats from campaign_leads
        const statsResult = await db
            .select({
                totalLeads: sql<number>`count(*)`,
                contacted: sql<number>`count(*) filter (where ${campaignLeads.status} != 'new')`,
                replied: sql<number>`count(*) filter (where ${campaignLeads.status} = 'replied' or ${campaignLeads.status} = 'interested')`,
                bounced: sql<number>`count(*) filter (where ${campaignLeads.status} = 'bounced')`,
                totalOpens: sql<number>`coalesce(sum(${campaignLeads.totalOpens}), 0)`,
                totalClicks: sql<number>`coalesce(sum(${campaignLeads.totalClicks}), 0)`,
                totalReplies: sql<number>`coalesce(sum(${campaignLeads.totalReplies}), 0)`,
            })
            .from(campaignLeads)
            .where(eq(campaignLeads.campaignId, campaignId))

        const stats = statsResult[0] || {
            totalLeads: 0,
            contacted: 0,
            replied: 0,
            bounced: 0,
            totalOpens: 0,
            totalClicks: 0,
            totalReplies: 0,
        }

        res.json({ stats })
    } catch (error) {
        console.error('Error fetching campaign stats:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
