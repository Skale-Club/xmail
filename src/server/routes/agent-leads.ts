import { Router } from 'express'
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
    campaignLeads,
    campaigns,
    emailAccounts,
    leadLists,
    leads,
    outreachEmails,
    type Lead,
} from '../../db/schema'
import {
    MANAGE_SCOPE,
    READ_SCOPE,
    ManageError,
    auditManage,
    confirmBodySchema,
    diffFields,
    handleManageError,
    isUuid,
    paginationMeta,
    paginationSchema,
    requireConfirmation,
    requireScope,
} from '../lib/agent-manage'
import { jsonbParam } from '../lib/jsonb'

/**
 * Hermes / Kai lead operations.
 *
 *   GET    /campaigns/:id/leads                 outreach:read    campaign roster: status, step, last event
 *   GET    /leads/:leadId                       outreach:read    one lead + the campaigns it is in
 *   PATCH  /leads/:leadId                       outreach:manage  personalization fields (partial)
 *   DELETE /campaigns/:id/leads/:leadId         outreach:manage  take a lead out of a campaign (confirm: true)
 *   GET    /lead-lists                          outreach:read
 *   POST   /lead-lists                          outreach:manage
 *   PATCH  /lead-lists/:listId                  outreach:manage
 *
 * Nothing here adds a lead to a campaign or creates a lead: enrolling stays on
 * POST /campaigns/:id/enroll-draft (draft only, verified inbox, platform-email and protected-domain
 * guards) and imports stay on /prospects/import. Email, verification status, unsubscribe state and
 * the lead's status are not editable here: those are facts the system records, not copy.
 */

const router = Router()

const CAMPAIGN_LEAD_STATUSES = ['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed'] as const

const listLeadsQuerySchema = paginationSchema.extend({
    status: z.enum(CAMPAIGN_LEAD_STATUSES).optional(),
})

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()

// customFields keys the agent must not write: they carry how the address was verified and where
// the lead came from. Letting an LLM edit them would let it certify an address (finding 3 in the
// system map) or re-attribute a lead to another prospecting run.
const RESERVED_CUSTOM_FIELD_KEY = /^(email_status|email_verif\w*|source_run_id|xcraper_run_id|outcome_\w+|unsubscribe\w*)$/i
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_CUSTOM_FIELDS_BYTES = 50_000

const updateLeadSchema = z.object({
    firstName: nullableText(100),
    lastName: nullableText(100),
    companyName: nullableText(200),
    industry: nullableText(150),
    title: nullableText(200),
    website: nullableText(500),
    phone: nullableText(100),
    // {{city}} is derived from this field ("Street, City, ST ZIP"); there is no separate city column.
    location: nullableText(200),
    // Stored in customFields.shortName, the name the greeting uses. null clears it.
    shortName: nullableText(100),
    /** Merged into customFields key by key (hook flags such as has_owned_website, booking, ...). */
    customFields: z.record(z.string().min(1).max(100), z.unknown()).optional(),
    /** customFields keys to delete. */
    removeCustomFields: z.array(z.string().min(1).max(100)).max(50).optional(),
    reason: z.string().trim().max(500).optional(),
}).strict().refine(
    (value) => Object.entries(value).some(([key, entry]) => key !== 'reason' && entry !== undefined),
    { message: 'Provide at least one field to change' },
)

const PLAIN_LEAD_FIELDS = ['firstName', 'lastName', 'companyName', 'industry', 'title', 'website', 'phone', 'location'] as const

const leadListCreateSchema = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1_000).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
}).strict()

const leadListUpdateSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    reason: z.string().trim().max(500).optional(),
}).strict().refine(
    (value) => Object.entries(value).some(([key, entry]) => key !== 'reason' && entry !== undefined),
    { message: 'Provide at least one field to change' },
)

/** custom_fields is jsonb; a double-encoded legacy row reads back as a JSON string. */
function asObject(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
        } catch {
            return {}
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
}

function toLeadView(lead: Lead) {
    return {
        id: lead.id,
        email: lead.email,
        firstName: lead.firstName,
        lastName: lead.lastName,
        companyName: lead.companyName,
        companySize: lead.companySize,
        industry: lead.industry,
        title: lead.title,
        website: lead.website,
        linkedinUrl: lead.linkedinUrl,
        phone: lead.phone,
        location: lead.location,
        customFields: asObject(lead.customFields),
        status: lead.status,
        source: lead.source,
        leadListId: lead.leadListId,
        emailVerificationStatus: lead.emailVerificationStatus,
        icpScore: lead.icpScore,
        icpTier: lead.icpTier,
        totalEmailsSent: lead.totalEmailsSent,
        totalOpens: lead.totalOpens,
        totalClicks: lead.totalClicks,
        totalReplies: lead.totalReplies,
        lastContactedAt: lead.lastContactedAt,
        lastRepliedAt: lead.lastRepliedAt,
        unsubscribedAt: lead.unsubscribedAt,
        createdAt: lead.createdAt,
        updatedAt: lead.updatedAt,
    }
}

async function loadCampaign(organizationId: string, campaignId: string) {
    if (!isUuid(campaignId)) throw new ManageError(404, { error: 'Campaign not found' })
    const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
    })
    if (!campaign) throw new ManageError(404, { error: 'Campaign not found' })
    return campaign
}

async function loadLead(organizationId: string, leadId: string): Promise<Lead> {
    if (!isUuid(leadId)) throw new ManageError(404, { error: 'Lead not found' })
    const lead = await db.query.leads.findFirst({
        where: and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)),
    })
    if (!lead) throw new ManageError(404, { error: 'Lead not found' })
    return lead
}

/** The most recent thing that happened to a campaign lead, from the timestamps the sequence keeps. */
function lastEventOf(row: {
    lastRepliedAt: Date | null
    lastContactedAt: Date | null
    completedAt: Date | null
    status: string
}) {
    const candidates: Array<{ type: string; at: Date }> = []
    if (row.lastRepliedAt) candidates.push({ type: 'replied', at: row.lastRepliedAt })
    if (row.lastContactedAt) candidates.push({ type: 'email_sent', at: row.lastContactedAt })
    if (row.completedAt) candidates.push({ type: 'sequence_completed', at: row.completedAt })
    if (candidates.length === 0) return null
    return candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0]
}

router.get('/campaigns/:id/leads', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = listLeadsQuerySchema.parse(req.query)
        const campaign = await loadCampaign(principal.organizationId, req.params.id)

        const where = query.status
            ? and(eq(campaignLeads.campaignId, campaign.id), eq(campaignLeads.status, query.status))
            : eq(campaignLeads.campaignId, campaign.id)
        const [{ total }] = await db.select({ total: count() }).from(campaignLeads).where(where)
        const rows = await db
            .select()
            .from(campaignLeads)
            .where(where)
            .orderBy(desc(campaignLeads.createdAt))
            .limit(query.limit)
            .offset((query.page - 1) * query.limit)

        const leadIds = rows.map((row) => row.leadId)
        const accountIds = [...new Set(rows.map((row) => row.assignedEmailAccountId).filter((id): id is string => Boolean(id)))]
        const leadRows = leadIds.length === 0 ? [] : await db.query.leads.findMany({
            where: and(eq(leads.organizationId, principal.organizationId), inArray(leads.id, leadIds)),
        })
        const accountRows = accountIds.length === 0 ? [] : await db
            .select({ id: emailAccounts.id, email: emailAccounts.email })
            .from(emailAccounts)
            .where(and(eq(emailAccounts.organizationId, principal.organizationId), inArray(emailAccounts.id, accountIds)))
        const leadById = new Map(leadRows.map((lead) => [lead.id, lead]))
        const accountById = new Map(accountRows.map((account) => [account.id, account]))

        res.json({
            campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
            leads: rows.map((row) => {
                const lead = leadById.get(row.leadId)
                return {
                    leadId: row.leadId,
                    campaignLeadId: row.id,
                    email: lead?.email ?? null,
                    firstName: lead?.firstName ?? null,
                    companyName: lead?.companyName ?? null,
                    status: row.status,
                    currentStepOrder: row.currentStepOrder,
                    nextScheduledAt: row.nextScheduledAt,
                    firstContactedAt: row.firstContactedAt,
                    lastContactedAt: row.lastContactedAt,
                    lastRepliedAt: row.lastRepliedAt,
                    completedAt: row.completedAt,
                    totalOpens: row.totalOpens,
                    totalClicks: row.totalClicks,
                    totalReplies: row.totalReplies,
                    lastEvent: lastEventOf(row),
                    sendingInbox: row.assignedEmailAccountId ? accountById.get(row.assignedEmailAccountId) ?? null : null,
                }
            }),
            pagination: paginationMeta(query.page, query.limit, Number(total)),
        })
    } catch (error) {
        handleManageError(error, res, 'campaign leads list')
    }
})

router.get('/leads/:leadId', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const lead = await loadLead(principal.organizationId, req.params.leadId)
        const memberships = await db.select().from(campaignLeads).where(eq(campaignLeads.leadId, lead.id))
        const campaignIds = [...new Set(memberships.map((row) => row.campaignId))]
        const campaignRows = campaignIds.length === 0 ? [] : await db
            .select({ id: campaigns.id, name: campaigns.name, status: campaigns.status })
            .from(campaigns)
            .where(and(eq(campaigns.organizationId, principal.organizationId), inArray(campaigns.id, campaignIds)))
        const campaignById = new Map(campaignRows.map((campaign) => [campaign.id, campaign]))
        res.json({
            lead: toLeadView(lead),
            campaigns: memberships.flatMap((row) => {
                const campaign = campaignById.get(row.campaignId)
                if (!campaign) return []
                return [{
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    campaignStatus: campaign.status,
                    status: row.status,
                    currentStepOrder: row.currentStepOrder,
                    nextScheduledAt: row.nextScheduledAt,
                    lastContactedAt: row.lastContactedAt,
                    lastRepliedAt: row.lastRepliedAt,
                    lastEvent: lastEventOf(row),
                }]
            }),
        })
    } catch (error) {
        handleManageError(error, res, 'lead detail')
    }
})

router.patch('/leads/:leadId', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = updateLeadSchema.parse(req.body)
        const lead = await loadLead(principal.organizationId, req.params.leadId)

        const customPatch: Record<string, unknown> = { ...(input.customFields ?? {}) }
        if (input.shortName !== undefined) customPatch.shortName = input.shortName
        const removals = input.removeCustomFields ?? []
        for (const key of [...Object.keys(customPatch), ...removals]) {
            if (FORBIDDEN_KEYS.has(key) || RESERVED_CUSTOM_FIELD_KEY.test(key)) {
                throw new ManageError(422, {
                    error: `customFields key "${key}" is managed by the system and cannot be changed here`,
                    code: 'reserved_custom_field',
                    key,
                })
            }
        }

        const outcome = await db.transaction(async (tx) => {
            const [current] = await tx
                .select()
                .from(leads)
                .where(and(eq(leads.id, lead.id), eq(leads.organizationId, principal.organizationId)))
                .for('update')
            if (!current) throw new ManageError(404, { error: 'Lead not found' })

            const plainPatch: Record<string, unknown> = {}
            for (const key of PLAIN_LEAD_FIELDS) {
                if (input[key] !== undefined) plainPatch[key] = input[key]
            }
            const plain = diffFields(current as unknown as Record<string, unknown>, plainPatch)

            const currentCustom = asObject(current.customFields)
            const nextCustom = { ...currentCustom }
            const customBefore: Record<string, unknown> = {}
            const customAfter: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(customPatch)) {
                const stored = currentCustom[key] ?? null
                if (value === null || value === undefined) {
                    if (key in currentCustom) {
                        customBefore[key] = stored
                        customAfter[key] = null
                        delete nextCustom[key]
                    }
                } else if (JSON.stringify(stored) !== JSON.stringify(value)) {
                    customBefore[key] = stored
                    customAfter[key] = value
                    nextCustom[key] = value
                }
            }
            for (const key of removals) {
                if (key in nextCustom) {
                    customBefore[key] = currentCustom[key]
                    customAfter[key] = null
                    delete nextCustom[key]
                }
            }
            const customChanged = Object.keys(customAfter).length > 0
            if (customChanged && JSON.stringify(nextCustom).length > MAX_CUSTOM_FIELDS_BYTES) {
                throw new ManageError(422, { error: 'customFields would grow past the size limit', code: 'custom_fields_too_large' })
            }

            if (plain.changedFields.length === 0 && !customChanged) return { changed: false as const, lead: current }

            const [updated] = await tx
                .update(leads)
                .set({
                    ...plain.after,
                    ...(customChanged ? { customFields: jsonbParam(nextCustom) } : {}),
                    updatedAt: new Date(),
                })
                .where(and(eq(leads.id, current.id), eq(leads.organizationId, principal.organizationId)))
                .returning()
            const changedFields = [...plain.changedFields, ...(customChanged ? ['customFields'] : [])]
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.lead.updated',
                resourceType: 'lead',
                resourceId: current.id,
                metadata: {
                    leadId: current.id,
                    reason: input.reason ?? null,
                    changedFields,
                    before: { ...plain.before, ...(customChanged ? { customFields: customBefore } : {}) },
                    after: { ...plain.after, ...(customChanged ? { customFields: customAfter } : {}) },
                },
            })
            return {
                changed: true as const,
                lead: updated,
                changedFields,
                before: { ...plain.before, ...(customChanged ? { customFields: customBefore } : {}) },
                after: { ...plain.after, ...(customChanged ? { customFields: customAfter } : {}) },
            }
        })

        if (!outcome.changed) {
            return res.json({ changed: false, changedFields: [], lead: toLeadView(outcome.lead), note: 'Nothing differs from what is already saved; nothing was written.' })
        }
        res.json({
            changed: true,
            changedFields: outcome.changedFields,
            before: outcome.before,
            after: outcome.after,
            lead: toLeadView(outcome.lead),
        })
    } catch (error) {
        handleManageError(error, res, 'lead update')
    }
})

router.delete('/campaigns/:id/leads/:leadId', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = confirmBodySchema.parse(req.body ?? {})
        const campaign = await loadCampaign(principal.organizationId, req.params.id)
        const lead = await loadLead(principal.organizationId, req.params.leadId)

        const membership = await db.query.campaignLeads.findFirst({
            where: and(eq(campaignLeads.campaignId, campaign.id), eq(campaignLeads.leadId, lead.id)),
        })
        if (!membership) throw new ManageError(404, { error: 'Lead is not enrolled in this campaign' })

        const [{ sent }] = await db
            .select({ sent: count() })
            .from(outreachEmails)
            .where(and(eq(outreachEmails.organizationId, principal.organizationId), eq(outreachEmails.campaignLeadId, membership.id)))
        const hasHistory = Number(sent) > 0
        // A lead that was never mailed is deleted outright. One with send history is only stopped:
        // deleting the row would cascade away the outreach_emails behind the campaign's metrics.
        const effect = hasHistory ? 'stopped' : 'deleted'

        requireConfirmation(input, {
            action: effect === 'deleted' ? 'remove lead from campaign' : 'stop the lead\'s sequence',
            effect,
            lead: { id: lead.id, email: lead.email },
            campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
            leadStatusInCampaign: membership.status,
            currentStepOrder: membership.currentStepOrder,
            emailsAlreadySent: Number(sent),
            consequence: effect === 'deleted'
                ? 'The lead is removed from this campaign. It was never emailed, so nothing else changes. It can be enrolled again later.'
                : 'No further emails will be scheduled for this lead in this campaign. Emails already sent stay in the history and the metrics. The lead stays on the roster as finished and cannot be re-enrolled in this campaign.',
        })

        await db.transaction(async (tx) => {
            const [locked] = await tx
                .select()
                .from(campaignLeads)
                .where(and(eq(campaignLeads.id, membership.id), eq(campaignLeads.campaignId, campaign.id)))
                .for('update')
            if (!locked) throw new ManageError(404, { error: 'Lead is not enrolled in this campaign' })
            if (effect === 'deleted') {
                await tx.delete(campaignLeads).where(and(eq(campaignLeads.id, locked.id), eq(campaignLeads.campaignId, campaign.id)))
                await tx
                    .update(campaigns)
                    .set({ totalLeads: sql`GREATEST(0, ${campaigns.totalLeads} - 1)`, updatedAt: new Date() })
                    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.organizationId, principal.organizationId)))
            } else {
                await tx
                    .update(campaignLeads)
                    .set({
                        nextScheduledAt: null,
                        nextFollowUpAt: null,
                        completedAt: locked.completedAt ?? new Date(),
                        updatedAt: new Date(),
                    })
                    .where(and(eq(campaignLeads.id, locked.id), eq(campaignLeads.campaignId, campaign.id)))
            }
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.campaign.lead_removed',
                resourceType: 'campaign',
                resourceId: campaign.id,
                metadata: {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    campaignStatus: campaign.status,
                    leadId: lead.id,
                    campaignLeadId: locked.id,
                    effect,
                    leadStatusBefore: locked.status,
                    currentStepOrder: locked.currentStepOrder,
                    emailsAlreadySent: Number(sent),
                    reason: input.reason ?? null,
                },
            })
        })

        res.json({ removed: true, effect, leadId: lead.id, campaignId: campaign.id, emailsAlreadySent: Number(sent) })
    } catch (error) {
        handleManageError(error, res, 'campaign lead removal')
    }
})

router.get('/lead-lists', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const query = paginationSchema.parse(req.query)
        const where = eq(leadLists.organizationId, principal.organizationId)
        const [{ total }] = await db.select({ total: count() }).from(leadLists).where(where)
        const rows = await db
            .select()
            .from(leadLists)
            .where(where)
            .orderBy(desc(leadLists.createdAt))
            .limit(query.limit)
            .offset((query.page - 1) * query.limit)
        res.json({
            leadLists: rows.map((list) => ({
                id: list.id,
                name: list.name,
                description: list.description,
                color: list.color,
                leadCount: list.leadCount,
                createdAt: list.createdAt,
                updatedAt: list.updatedAt,
            })),
            pagination: paginationMeta(query.page, query.limit, Number(total)),
        })
    } catch (error) {
        handleManageError(error, res, 'lead lists')
    }
})

router.post('/lead-lists', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = leadListCreateSchema.parse(req.body)
        const created = await db.transaction(async (tx) => {
            const [list] = await tx.insert(leadLists).values({
                organizationId: principal.organizationId,
                name: input.name,
                description: input.description,
                color: input.color,
            }).returning()
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.lead_list.created',
                resourceType: 'lead_list',
                resourceId: list.id,
                metadata: { leadListId: list.id, name: list.name },
            })
            return list
        })
        res.status(201).json({ leadList: { id: created.id, name: created.name, description: created.description, color: created.color, leadCount: created.leadCount } })
    } catch (error) {
        handleManageError(error, res, 'lead list creation')
    }
})

router.patch('/lead-lists/:listId', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = leadListUpdateSchema.parse(req.body)
        if (!isUuid(req.params.listId)) throw new ManageError(404, { error: 'Lead list not found' })

        const outcome = await db.transaction(async (tx) => {
            const [current] = await tx
                .select()
                .from(leadLists)
                .where(and(eq(leadLists.id, req.params.listId), eq(leadLists.organizationId, principal.organizationId)))
                .for('update')
            if (!current) throw new ManageError(404, { error: 'Lead list not found' })
            const patch: Record<string, unknown> = {}
            for (const key of ['name', 'description', 'color'] as const) {
                if (input[key] !== undefined) patch[key] = input[key]
            }
            const { before, after, changedFields } = diffFields(current as unknown as Record<string, unknown>, patch)
            if (changedFields.length === 0) return { changed: false as const, list: current }
            const [updated] = await tx
                .update(leadLists)
                .set({ ...after, updatedAt: new Date() })
                .where(and(eq(leadLists.id, current.id), eq(leadLists.organizationId, principal.organizationId)))
                .returning()
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.lead_list.updated',
                resourceType: 'lead_list',
                resourceId: current.id,
                metadata: { leadListId: current.id, reason: input.reason ?? null, changedFields, before, after },
            })
            return { changed: true as const, list: updated, before, after, changedFields }
        })
        const list = outcome.list
        res.json({
            changed: outcome.changed,
            changedFields: outcome.changed ? outcome.changedFields : [],
            leadList: { id: list.id, name: list.name, description: list.description, color: list.color, leadCount: list.leadCount },
        })
    } catch (error) {
        handleManageError(error, res, 'lead list update')
    }
})

export default router
