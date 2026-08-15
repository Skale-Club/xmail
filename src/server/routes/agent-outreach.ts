import { Router, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
    campaigns,
    campaignLeads,
    emailAccounts,
    leadLists,
    leads,
    outreachAgentCredentials,
    outreachEventOutbox,
    sequences,
    sequenceSteps,
    type OutreachAgentScope,
} from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import { resolveOutreachSettings } from '../lib/outreach-settings'
import { publishOutreachEvent } from '../lib/xphere-events'
import { resolveLeadVerificationFields } from '../lib/email-verification-mapping'
import agentProspectingRouter from './agent-prospecting'
import agentApprovalsRouter from './agent-approvals'
import agentAssessmentsRouter from './agent-assessments'
import { jsonbParam } from '../lib/jsonb'

const router = Router()

router.use('/prospecting', agentProspectingRouter)
router.use('/', agentApprovalsRouter)
router.use('/', agentAssessmentsRouter)

function requireScope(req: Request, res: Response, scope: OutreachAgentScope): AgentPrincipal | null {
    const principal = getAgentPrincipal(req)
    if (!principal) {
        res.status(401).json({ error: 'Unauthorized' })
        return null
    }
    if (!agentHasScope(principal, scope)) {
        void writeAgentAudit({
            principal,
            request: req,
            action: 'agent.scope.denied',
            outcome: 'denied',
            metadata: { requiredScope: scope },
        }).catch(() => undefined)
        res.status(403).json({ error: `Missing required scope: ${scope}` })
        return null
    }
    return principal
}

const prospectSchema = z.object({
    email: z.string().email().transform((value) => value.trim().toLowerCase()),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    companyName: z.string().trim().max(200).optional(),
    companySize: z.string().trim().max(100).optional(),
    industry: z.string().trim().max(150).optional(),
    title: z.string().trim().max(200).optional(),
    website: z.string().trim().max(500).optional(),
    linkedinUrl: z.string().trim().max(500).optional(),
    phone: z.string().trim().max(100).optional(),
    location: z.string().trim().max(200).optional(),
    customFields: z.record(z.unknown()).optional(),
})

const importProspectsSchema = z.object({
    prospects: z.array(prospectSchema).min(1).max(100),
    leadListId: z.string().uuid().optional(),
    source: z.string().trim().min(1).max(100).default('hermes'),
})

const campaignStepSchema = z.object({
    delayHours: z.number().int().min(0).max(24 * 90).default(0),
    subject: z.string().trim().min(1).max(500),
    plainBody: z.string().trim().min(1).max(100_000).optional(),
    htmlBody: z.string().trim().min(1).max(250_000).optional(),
}).refine((step) => Boolean(step.plainBody || step.htmlBody), {
    message: 'Each step requires plainBody or htmlBody',
})

const createDraftSchema = z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2_000).optional(),
    fromName: z.string().trim().max(200).optional(),
    replyToEmail: z.string().email().optional(),
    timezone: z.string().trim().max(100).optional(),
    sendOnWeekends: z.boolean().optional(),
    sendStartTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
    sendEndTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
    steps: z.array(campaignStepSchema).max(20).default([]),
})

const enrollDraftSchema = z.object({
    leadIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    leadListId: z.string().uuid().optional(),
    emailAccountId: z.string().uuid(),
}).refine((value) => Boolean(value.leadIds?.length || value.leadListId), {
    message: 'leadIds or leadListId is required',
})

router.get('/health', (req, res) => {
    const principal = requireScope(req, res, 'outreach:read')
    if (!principal) return
    res.json({
        status: 'ok',
        organizationId: principal.organizationId,
        credentialId: principal.credentialId,
        scopes: principal.scopes,
        serverTime: new Date().toISOString(),
    })
})

router.get('/campaigns', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'outreach:read')
        if (!principal) return
        const query = z.object({
            status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
        }).parse(req.query)
        const where = query.status
            ? and(eq(campaigns.organizationId, principal.organizationId), eq(campaigns.status, query.status))
            : eq(campaigns.organizationId, principal.organizationId)
        const rows = await db.query.campaigns.findMany({
            where,
            limit: query.limit,
            orderBy: [desc(campaigns.createdAt)],
        })
        res.json({ campaigns: rows })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign list failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/prospects/import', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'prospects:write')
        if (!principal) return
        const input = importProspectsSchema.parse(req.body)
        if (input.leadListId) {
            const list = await db.query.leadLists.findFirst({
                where: and(
                    eq(leadLists.id, input.leadListId),
                    eq(leadLists.organizationId, principal.organizationId),
                ),
                columns: { id: true },
            })
            if (!list) return res.status(400).json({ error: 'Lead list not found or access denied' })
        }

        const uniqueByEmail = new Map(input.prospects.map((prospect) => [prospect.email, prospect]))
        const uniqueProspects = [...uniqueByEmail.values()]
        // Contract mapping (verification-gates step 1): map customFields verification signals
        // onto the existing verification columns, falling back to the free MX pre-filter (step 4)
        // only when no email_status was supplied. Duplicates are skipped via onConflictDoNothing
        // as before — this only affects the insert path.
        const prospectsWithVerification = await Promise.all(uniqueProspects.map(async (prospect) => ({
            prospect,
            verification: await resolveLeadVerificationFields(prospect.email, prospect.customFields),
        })))
        const inserted = await db.insert(leads).values(prospectsWithVerification.map(({ prospect, verification }) => ({
            organizationId: principal.organizationId,
            ...prospect,
            // Ver lib/jsonb.ts: sem o cast via text o Supavisor codifica o valor duas vezes e a
            // coluna guarda uma STRING JSON, invisível através do ORM mas opaca a todo operador
            // jsonb do lado do servidor.
            ...(prospect.customFields ? { customFields: jsonbParam(prospect.customFields) } : {}),
            source: input.source,
            leadListId: input.leadListId,
            ...verification,
        }))).onConflictDoNothing().returning()
        const resolved = await db.query.leads.findMany({
            where: and(
                eq(leads.organizationId, principal.organizationId),
                inArray(leads.email, [...uniqueByEmail.keys()]),
            ),
            columns: { id: true, email: true, status: true, createdAt: true },
        })
        if (input.leadListId && inserted.length > 0) {
            await db.update(leadLists)
                .set({ leadCount: sql`${leadLists.leadCount} + ${inserted.length}`, updatedAt: new Date() })
                .where(eq(leadLists.id, input.leadListId))
        }
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.prospects.imported',
            resourceType: 'lead',
            metadata: { submitted: input.prospects.length, unique: uniqueProspects.length, imported: inserted.length },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'prospects.imported',
            aggregateType: 'lead_batch',
            aggregateId: principal.credentialId,
            deduplicationKey: `agent:prospects.imported:${createHash('sha256').update(
                resolved.map((prospect) => prospect.id).sort().join(','),
            ).digest('hex')}`,
            payload: { submitted: input.prospects.length, unique: uniqueProspects.length, imported: inserted.length },
        })
        res.status(inserted.length > 0 ? 201 : 200).json({
            submitted: input.prospects.length,
            imported: inserted.length,
            duplicates: input.prospects.length - inserted.length,
            prospects: resolved,
        })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent prospect import failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/campaigns/drafts', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:draft')
        if (!principal) return
        const input = createDraftSchema.parse(req.body)
        const settings = await resolveOutreachSettings(principal.organizationId)
        const idempotencyWhere = and(
            eq(campaigns.organizationId, principal.organizationId),
            eq(campaigns.agentCredentialId, principal.credentialId),
            eq(campaigns.agentIdempotencyKey, input.idempotencyKey),
        )
        const existing = await db.query.campaigns.findFirst({
            where: idempotencyWhere,
            with: {
                sequences: {
                    with: { steps: { orderBy: (step, { asc: ascending }) => [ascending(step.stepOrder)] } },
                },
            },
        })
        if (existing) {
            await writeAgentAudit({
                principal,
                request: req,
                action: 'agent.campaign.draft_replayed',
                resourceType: 'campaign',
                resourceId: existing.id,
                metadata: { idempotencyKey: input.idempotencyKey },
            })
            await publishOutreachEvent({
                organizationId: principal.organizationId,
                eventType: 'campaign.draft_created',
                aggregateType: 'campaign',
                aggregateId: existing.id,
                deduplicationKey: `agent:campaign.draft_created:${existing.id}`,
                payload: { campaign_id: existing.id, step_count: existing.sequences[0]?.steps.length ?? 0 },
            })
            return res.status(200).json({
                campaign: existing,
                sequence: existing.sequences[0] ?? null,
                steps: existing.sequences[0]?.steps ?? [],
                activationRequired: true,
                idempotentReplay: true,
            })
        }
        const result = await db.transaction(async (tx) => {
            const [campaign] = await tx.insert(campaigns).values({
                organizationId: principal.organizationId,
                agentCredentialId: principal.credentialId,
                agentIdempotencyKey: input.idempotencyKey,
                name: input.name,
                description: input.description,
                fromName: input.fromName,
                replyToEmail: input.replyToEmail,
                timezone: input.timezone ?? settings.defaultTimezone,
                sendOnWeekends: input.sendOnWeekends ?? settings.sendOnWeekends,
                sendStartTime: input.sendStartTime ?? settings.defaultSendStartTime,
                sendEndTime: input.sendEndTime ?? settings.defaultSendEndTime,
                trackOpens: input.trackOpens ?? settings.trackOpens,
                trackClicks: input.trackClicks ?? settings.trackClicks,
                status: 'draft',
            }).onConflictDoNothing({
                target: [campaigns.organizationId, campaigns.agentCredentialId, campaigns.agentIdempotencyKey],
            }).returning()
            if (!campaign) return null
            const [sequence] = await tx.insert(sequences).values({
                campaignId: campaign.id,
                name: 'Main Sequence',
                description: 'Drafted by an outreach agent; human activation is required',
            }).returning()
            const steps = input.steps.length === 0 ? [] : await tx.insert(sequenceSteps).values(
                input.steps.map((step, index) => ({
                    sequenceId: sequence.id,
                    stepOrder: index + 1,
                    type: 'email' as const,
                    delayHours: step.delayHours,
                    subject: step.subject,
                    plainBody: step.plainBody,
                    htmlBody: step.htmlBody,
                })),
            ).returning()
            return { campaign, sequence, steps }
        })
        if (!result) {
            const raced = await db.query.campaigns.findFirst({ where: idempotencyWhere })
            if (!raced) throw new Error('Idempotent draft conflict could not be resolved')
            await publishOutreachEvent({
                organizationId: principal.organizationId,
                eventType: 'campaign.draft_created',
                aggregateType: 'campaign',
                aggregateId: raced.id,
                deduplicationKey: `agent:campaign.draft_created:${raced.id}`,
                payload: { campaign_id: raced.id },
            })
            return res.status(200).json({
                campaign: raced,
                activationRequired: true,
                idempotentReplay: true,
            })
        }
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.campaign.draft_created',
            resourceType: 'campaign',
            resourceId: result.campaign.id,
            metadata: { stepCount: result.steps.length, idempotencyKey: input.idempotencyKey },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'campaign.draft_created',
            aggregateType: 'campaign',
            aggregateId: result.campaign.id,
            deduplicationKey: `agent:campaign.draft_created:${result.campaign.id}`,
            payload: { campaign_id: result.campaign.id, step_count: result.steps.length },
        })
        res.status(201).json({ ...result, activationRequired: true, idempotentReplay: false })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign draft failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/campaigns/:id/enroll-draft', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:draft')
        if (!principal) return
        const input = enrollDraftSchema.parse(req.body)
        const campaign = await db.query.campaigns.findFirst({
            where: and(eq(campaigns.id, req.params.id), eq(campaigns.organizationId, principal.organizationId)),
        })
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
        if (campaign.status !== 'draft') {
            return res.status(409).json({ error: 'Agent enrollment is allowed only while the campaign is a draft' })
        }
        const account = await db.query.emailAccounts.findFirst({
            where: and(
                eq(emailAccounts.id, input.emailAccountId),
                eq(emailAccounts.organizationId, principal.organizationId),
                eq(emailAccounts.status, 'verified'),
                // Warm-up-only inboxes never carry campaign traffic (migration 051).
                eq(emailAccounts.warmupOnly, false),
            ),
            columns: { id: true },
        })
        if (!account) return res.status(400).json({ error: 'Verified sending inbox not found or access denied' })

        let requestedLeadIds = input.leadIds ? [...new Set(input.leadIds)] : []
        if (requestedLeadIds.length === 0 && input.leadListId) {
            const list = await db.query.leadLists.findFirst({
                where: and(eq(leadLists.id, input.leadListId), eq(leadLists.organizationId, principal.organizationId)),
                columns: { id: true },
            })
            if (!list) return res.status(400).json({ error: 'Lead list not found or access denied' })
            const listLeads = await db.query.leads.findMany({
                where: and(eq(leads.organizationId, principal.organizationId), eq(leads.leadListId, list.id)),
                columns: { id: true },
                limit: 101,
            })
            if (listLeads.length > 100) return res.status(422).json({ error: 'Agent enrollment is limited to 100 leads per request' })
            requestedLeadIds = listLeads.map((lead) => lead.id)
        }
        const eligibleLeads = await db.query.leads.findMany({
            where: and(
                eq(leads.organizationId, principal.organizationId),
                inArray(leads.id, requestedLeadIds),
                inArray(leads.emailVerificationStatus, ['verified', 'likely']),
                sql`${leads.unsubscribedAt} IS NULL`,
            ),
            columns: { id: true },
        })
        if (eligibleLeads.length !== requestedLeadIds.length) {
            return res.status(422).json({ error: 'Every agent-enrolled lead must belong to the organization, have a verified/likely email and not be unsubscribed' })
        }
        const sequence = await db.query.sequences.findFirst({
            where: eq(sequences.campaignId, campaign.id),
            with: { steps: { orderBy: (step, { asc: ascending }) => [ascending(step.stepOrder)] } },
        })
        const firstStep = sequence?.steps[0]
        if (!firstStep) return res.status(422).json({ error: 'Campaign draft needs at least one sequence step before enrollment' })

        const inserted = await db.transaction(async (tx) => {
            const rows = await tx.insert(campaignLeads).values(eligibleLeads.map((lead) => ({
                campaignId: campaign.id,
                leadId: lead.id,
                assignedEmailAccountId: account.id,
                currentStepId: firstStep.id,
                currentStepOrder: firstStep.stepOrder,
                nextScheduledAt: new Date(),
            }))).onConflictDoNothing({ target: [campaignLeads.campaignId, campaignLeads.leadId] }).returning()
            if (rows.length > 0) {
                await tx.update(campaigns).set({
                    totalLeads: sql`${campaigns.totalLeads} + ${rows.length}`,
                    updatedAt: new Date(),
                }).where(and(eq(campaigns.id, campaign.id), eq(campaigns.organizationId, principal.organizationId)))
            }
            return rows
        })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.campaign.draft_enrolled',
            resourceType: 'campaign',
            resourceId: campaign.id,
            metadata: { requested: requestedLeadIds.length, added: inserted.length, emailAccountId: account.id },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'campaign.draft_enrolled',
            aggregateType: 'campaign',
            aggregateId: campaign.id,
            deduplicationKey: `campaign.draft_enrolled:${campaign.id}:${requestedLeadIds.sort().join(',')}`,
            payload: { campaign_id: campaign.id, requested_count: requestedLeadIds.length, added_count: inserted.length },
        })
        res.status(inserted.length > 0 ? 201 : 200).json({
            added: inserted.length,
            existing: requestedLeadIds.length - inserted.length,
            campaignLeads: inserted,
            activationRequired: true,
        })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent draft enrollment failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/campaigns/:id/pause', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:pause')
        if (!principal) return
        const campaign = await db.query.campaigns.findFirst({
            where: and(eq(campaigns.id, req.params.id), eq(campaigns.organizationId, principal.organizationId)),
        })
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' })
        if (campaign.status === 'completed' || campaign.status === 'archived') {
            return res.status(409).json({ error: `Cannot pause a ${campaign.status} campaign` })
        }
        const [updated] = campaign.status === 'paused' ? [campaign] : await db.update(campaigns)
            .set({ status: 'paused', pausedAt: new Date(), pausedReason: 'agent', updatedAt: new Date() })
            .where(and(eq(campaigns.id, campaign.id), eq(campaigns.organizationId, principal.organizationId)))
            .returning()
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.campaign.paused',
            resourceType: 'campaign',
            resourceId: campaign.id,
            metadata: { previousStatus: campaign.status, idempotent: campaign.status === 'paused' },
        })
        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'campaign.paused',
            aggregateType: 'campaign',
            aggregateId: campaign.id,
            deduplicationKey: `agent:campaign.paused:${campaign.id}:${updated.updatedAt.getTime()}`,
            payload: { campaign_id: campaign.id, previous_status: campaign.status },
        })
        res.json({ campaign: updated })
    } catch (error) {
        console.error('Agent campaign pause failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/events', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'events:read')
        if (!principal) return
        const query = z.object({
            after: z.coerce.number().int().safe().min(0).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
        }).parse(req.query)
        const credential = await db.query.outreachAgentCredentials.findFirst({
            where: eq(outreachAgentCredentials.id, principal.credentialId),
            columns: { eventCursor: true },
        })
        const after = query.after ?? credential?.eventCursor ?? 0
        const events = await db.query.outreachEventOutbox.findMany({
            where: and(
                eq(outreachEventOutbox.organizationId, principal.organizationId),
                gt(outreachEventOutbox.sequenceNumber, after),
            ),
            orderBy: [asc(outreachEventOutbox.sequenceNumber)],
            limit: query.limit,
            columns: {
                id: true,
                sequenceNumber: true,
                eventType: true,
                schemaVersion: true,
                aggregateType: true,
                aggregateId: true,
                payload: true,
                occurredAt: true,
            },
        })
        res.json({
            events,
            acknowledgedCursor: credential?.eventCursor ?? 0,
            nextCursor: events.length > 0 ? events[events.length - 1].sequenceNumber : after,
        })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent event poll failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/events/ack', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'events:read')
        if (!principal) return
        const { cursor } = z.object({ cursor: z.number().int().safe().min(0) }).parse(req.body)
        const [bounds] = await db.select({
            maxCursor: sql<number>`coalesce(max(${outreachEventOutbox.sequenceNumber}), 0)`,
        }).from(outreachEventOutbox).where(eq(outreachEventOutbox.organizationId, principal.organizationId))
        const maxCursor = Number(bounds?.maxCursor ?? 0)
        if (cursor > maxCursor) return res.status(400).json({ error: 'Cursor is beyond the organization event stream' })

        const [updated] = await db.update(outreachAgentCredentials)
            .set({
                eventCursor: sql`greatest(${outreachAgentCredentials.eventCursor}, ${cursor})`,
                updatedAt: new Date(),
            })
            .where(eq(outreachAgentCredentials.id, principal.credentialId))
            .returning({ eventCursor: outreachAgentCredentials.eventCursor })
        await writeAgentAudit({
            principal,
            request: req,
            action: 'agent.events.acknowledged',
            resourceType: 'event_cursor',
            resourceId: String(updated.eventCursor),
            metadata: { requestedCursor: cursor },
        })
        res.json({ acknowledgedCursor: updated.eventCursor })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent event acknowledgement failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
