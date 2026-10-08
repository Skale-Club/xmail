import { Router } from 'express'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
    campaignLeads,
    campaigns,
    emailAccounts,
    outreachActionApprovals,
    sequences,
    sequenceSteps,
    type Campaign,
} from '../../db/schema'
import {
    MANAGE_SCOPE,
    READ_SCOPE,
    ManageError,
    auditManage,
    diffFields,
    handleManageError,
    isUuid,
    requireScope,
} from '../lib/agent-manage'
import { AGENT_ACCOUNT_COLUMNS, toAgentAccountView, type AgentAccountRow } from '../lib/agent-account-view'
import {
    CONTENT_LANGUAGE_PATTERN,
    SEND_TIME_PATTERN,
    buildDuplicateCampaignValues,
    isValidSendWindow,
    isValidTimeZone,
} from '../lib/campaign-settings'
import { computeCampaignMetrics } from '../lib/outreach-campaign-metrics'
import { publishOutreachEvent } from '../lib/xphere-events'
import { validateCampaignReadyForActivation } from './outreach/campaigns'

/**
 * Hermes / Kai campaign operations (scope `outreach:manage` for writes, `outreach:read` for reads).
 *
 *   GET   /campaigns/:id                full detail: settings, schedule, linked inboxes, stats
 *   PATCH /campaigns/:id                partial settings update
 *   POST  /campaigns/:id/duplicate      copy settings + sequence into a NEW DRAFT (no leads)
 *   POST  /campaigns/:id/resume         un-pause, only if a human already approved this campaign
 *
 * What none of these can do, by construction: send an e-mail, activate a campaign that was never
 * approved, change `status` through the settings update, or pick a sender. Resuming is the one
 * route that sets `status = 'active'`, and it refuses unless the campaign was activated before
 * through an executed `campaign_activation` approval AND the agent itself paused it AND the same
 * readiness checks as activation (sequence, leads with inbox, protected domain, warm-up-only,
 * warm-up ramp) pass again.
 */

const router = Router()

const CLOSED_STATUSES = new Set(['completed', 'archived'])

// Settings the agent may change. Deliberately NOT here:
//   status                      resume/pause/activation have their own gated routes
//   replyToEmail                redirects every prospect reply; a prompt-injected agent could
//                               point replies at an outside address
//   agenticFollowupEnabled, maxFollowUps, aiAutonomousEnabled
//                               autonomy opt-ins are a human decision
// There is no campaign-level daily limit or stop-on-reply switch: the daily limit belongs to the
// sending inbox (PATCH /email-accounts/:id) and a reply, bounce or unsubscribe ends that lead's
// sequence automatically.
const updateSettingsSchema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(2_000).optional(),
    contentLanguage: z.string().regex(CONTENT_LANGUAGE_PATTERN).optional(),
    fromName: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, 'Unknown IANA timezone').optional(),
    sendOnWeekends: z.boolean().optional(),
    sendStartTime: z.string().regex(SEND_TIME_PATTERN).optional(),
    sendEndTime: z.string().regex(SEND_TIME_PATTERN).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
    /** Why the setting is changing; stored verbatim in the audit row. */
    reason: z.string().trim().max(500).optional(),
}).strict().refine(
    (value) => Object.entries(value).some(([key, entry]) => key !== 'reason' && entry !== undefined),
    { message: 'Provide at least one setting to change' },
)

const SETTING_KEYS = [
    'name', 'description', 'contentLanguage', 'fromName', 'timezone', 'sendOnWeekends',
    'sendStartTime', 'sendEndTime', 'trackOpens', 'trackClicks',
] as const

const duplicateSchema = z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
    name: z.string().trim().min(1).max(100).optional(),
    reason: z.string().trim().max(500).optional(),
}).strict()

const resumeSchema = z.object({
    reason: z.string().trim().max(500).optional(),
}).strict()

function settingsView(campaign: Campaign) {
    return {
        name: campaign.name,
        description: campaign.description,
        contentLanguage: campaign.contentLanguage,
        fromName: campaign.fromName,
        replyToEmail: campaign.replyToEmail,
        timezone: campaign.timezone,
        sendOnWeekends: campaign.sendOnWeekends,
        sendStartTime: campaign.sendStartTime,
        sendEndTime: campaign.sendEndTime,
        trackOpens: campaign.trackOpens,
        trackClicks: campaign.trackClicks,
    }
}

async function loadCampaign(organizationId: string, campaignId: string): Promise<Campaign> {
    if (!isUuid(campaignId)) throw new ManageError(404, { error: 'Campaign not found' })
    const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
    })
    if (!campaign) throw new ManageError(404, { error: 'Campaign not found' })
    return campaign
}

type ResumeVerdict =
    | { resumable: true }
    | { resumable: false; code: string; reason: string }

/**
 * Whether a paused campaign may be resumed WITHOUT a new human approval. The campaign has to have
 * been activated through an executed `campaign_activation` approval of this very campaign, and
 * the agent itself has to be the one that paused it: a human pause, or a guardrail pause for
 * bounce/unsubscribe rate, is a decision the agent must not undo.
 */
async function resumeVerdict(organizationId: string, campaign: Campaign): Promise<ResumeVerdict> {
    if (campaign.status !== 'paused') {
        return { resumable: false, code: 'campaign_not_paused', reason: `The campaign is ${campaign.status}, not paused.` }
    }
    if (!campaign.activationApprovalId) {
        return {
            resumable: false,
            code: 'activation_approval_required',
            reason: 'This campaign was never activated through the approval flow. Request activation instead.',
        }
    }
    const approval = await db.query.outreachActionApprovals.findFirst({
        where: and(
            eq(outreachActionApprovals.id, campaign.activationApprovalId),
            eq(outreachActionApprovals.organizationId, organizationId),
            eq(outreachActionApprovals.actionKind, 'campaign_activation'),
            eq(outreachActionApprovals.resourceId, campaign.id),
            eq(outreachActionApprovals.status, 'executed'),
        ),
        columns: { id: true },
    })
    if (!approval) {
        return {
            resumable: false,
            code: 'activation_approval_required',
            reason: 'No executed activation approval exists for this campaign. Request activation instead.',
        }
    }
    if (campaign.pausedReason !== 'agent') {
        return {
            resumable: false,
            code: 'not_paused_by_agent',
            reason: `The campaign was paused by "${campaign.pausedReason ?? 'unknown'}", not by the agent. Only a campaign the agent paused can be resumed without a new approval; request activation to put it back.`,
        }
    }
    return { resumable: true }
}

async function linkedAccounts(organizationId: string, campaignId: string) {
    const grouped = await db
        .select({ id: campaignLeads.assignedEmailAccountId, leadCount: sql<number>`count(*)::int` })
        .from(campaignLeads)
        .where(eq(campaignLeads.campaignId, campaignId))
        .groupBy(campaignLeads.assignedEmailAccountId)
    const ids = grouped.map((row) => row.id).filter((id): id is string => Boolean(id))
    if (ids.length === 0) return { accounts: [], leadsWithoutInbox: grouped.find((row) => !row.id)?.leadCount ?? 0 }
    const rows = await db
        .select(AGENT_ACCOUNT_COLUMNS)
        .from(emailAccounts)
        .where(and(eq(emailAccounts.organizationId, organizationId), inArray(emailAccounts.id, ids)))
    const counts = new Map(grouped.map((row) => [row.id, row.leadCount]))
    return {
        accounts: (rows as AgentAccountRow[]).map((row) => ({ ...toAgentAccountView(row), leadCount: counts.get(row.id) ?? 0 })),
        leadsWithoutInbox: grouped.find((row) => !row.id)?.leadCount ?? 0,
    }
}

router.get('/campaigns/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, READ_SCOPE)
        if (!principal) return
        const campaign = await loadCampaign(principal.organizationId, req.params.id)

        const sequence = await db.query.sequences.findFirst({
            where: eq(sequences.campaignId, campaign.id),
            with: { steps: { orderBy: [asc(sequenceSteps.stepOrder)] } },
        })
        const [{ accounts, leadsWithoutInbox }, stats, verdict] = await Promise.all([
            linkedAccounts(principal.organizationId, campaign.id),
            computeCampaignMetrics([campaign.id]),
            resumeVerdict(principal.organizationId, campaign),
        ])
        const pendingApproval = await db.query.outreachActionApprovals.findFirst({
            where: and(
                eq(outreachActionApprovals.organizationId, principal.organizationId),
                eq(outreachActionApprovals.actionKind, 'campaign_activation'),
                eq(outreachActionApprovals.resourceId, campaign.id),
                eq(outreachActionApprovals.status, 'requested'),
            ),
            columns: { id: true },
        })

        res.json({
            campaign: {
                id: campaign.id,
                status: campaign.status,
                settings: settingsView(campaign),
                autonomy: {
                    agenticFollowupEnabled: campaign.agenticFollowupEnabled,
                    maxFollowUps: campaign.maxFollowUps,
                    aiAutonomousEnabled: campaign.aiAutonomousEnabled,
                },
                lifecycle: {
                    startedAt: campaign.startedAt,
                    pausedAt: campaign.pausedAt,
                    pausedReason: campaign.pausedReason,
                    completedAt: campaign.completedAt,
                    activatedThroughApproval: Boolean(campaign.activationApprovalId),
                    pendingActivationApproval: Boolean(pendingApproval),
                    canResumeWithoutApproval: verdict.resumable,
                    resumeBlockedBecause: verdict.resumable ? null : verdict.code,
                },
                createdAt: campaign.createdAt,
                updatedAt: campaign.updatedAt,
            },
            sequence: sequence
                ? {
                    id: sequence.id,
                    stepCount: sequence.steps.length,
                    steps: sequence.steps.map((step) => ({
                        stepOrder: step.stepOrder,
                        type: step.type,
                        delayHours: step.delayHours,
                        delayHoursMax: step.delayHoursMax,
                        subject: step.subject,
                        abTestEnabled: step.abTestEnabled,
                        totalSent: step.totalSent,
                    })),
                    note: 'Copy lives in GET /campaigns/:id/sequence.',
                }
                : null,
            sendingInboxes: accounts,
            leadsWithoutInbox,
            stats,
            notes: [
                'The daily sending limit is a property of each sending inbox (see sendingInboxes[].limits), not of the campaign.',
                'A reply, bounce or unsubscribe ends that lead\'s sequence automatically; there is no separate stop-on-reply setting.',
            ],
        })
    } catch (error) {
        handleManageError(error, res, 'campaign detail')
    }
})

router.patch('/campaigns/:id', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = updateSettingsSchema.parse(req.body)
        const campaign = await loadCampaign(principal.organizationId, req.params.id)
        if (CLOSED_STATUSES.has(campaign.status)) {
            throw new ManageError(409, { error: `Settings of a ${campaign.status} campaign cannot be changed`, code: 'campaign_not_editable' })
        }

        const outcome = await db.transaction(async (tx) => {
            const [current] = await tx
                .select()
                .from(campaigns)
                .where(and(eq(campaigns.id, campaign.id), eq(campaigns.organizationId, principal.organizationId)))
                .for('update')
            if (!current) throw new ManageError(404, { error: 'Campaign not found' })
            if (CLOSED_STATUSES.has(current.status)) {
                throw new ManageError(409, { error: `Settings of a ${current.status} campaign cannot be changed`, code: 'campaign_not_editable' })
            }

            // Only what the request names; everything else keeps its stored value.
            const patch: Record<string, unknown> = {}
            for (const key of SETTING_KEYS) {
                if (input[key] !== undefined) patch[key] = input[key]
            }
            const { before, after, changedFields } = diffFields(current as unknown as Record<string, unknown>, patch)
            if (changedFields.length === 0) return { changed: false as const, campaign: current }

            const nextStart = (after.sendStartTime as string | undefined) ?? current.sendStartTime
            const nextEnd = (after.sendEndTime as string | undefined) ?? current.sendEndTime
            if (!isValidSendWindow(nextStart, nextEnd)) {
                throw new ManageError(422, {
                    error: 'sendEndTime must be after sendStartTime',
                    code: 'invalid_send_window',
                    sendStartTime: nextStart,
                    sendEndTime: nextEnd,
                })
            }

            const [updated] = await tx
                .update(campaigns)
                .set({ ...after, updatedAt: new Date() })
                .where(and(eq(campaigns.id, current.id), eq(campaigns.organizationId, principal.organizationId)))
                .returning()
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.campaign.settings_updated',
                resourceType: 'campaign',
                resourceId: current.id,
                metadata: {
                    campaignId: current.id,
                    campaignName: current.name,
                    campaignStatus: current.status,
                    reason: input.reason ?? null,
                    changedFields,
                    before,
                    after,
                },
            })
            return { changed: true as const, campaign: updated, before, after, changedFields, status: current.status }
        })

        if (!outcome.changed) {
            return res.json({
                changed: false,
                changedFields: [],
                campaign: { id: outcome.campaign.id, status: outcome.campaign.status, settings: settingsView(outcome.campaign) },
                note: 'The payload matches what is already saved; nothing was written.',
            })
        }
        res.json({
            changed: true,
            changedFields: outcome.changedFields,
            before: outcome.before,
            after: outcome.after,
            campaign: { id: outcome.campaign.id, status: outcome.campaign.status, settings: settingsView(outcome.campaign) },
            appliesTo: outcome.status === 'draft' ? 'all sends once the campaign is activated' : 'future sends only',
        })
    } catch (error) {
        handleManageError(error, res, 'campaign settings update')
    }
})

router.post('/campaigns/:id/duplicate', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = duplicateSchema.parse(req.body)
        const source = await loadCampaign(principal.organizationId, req.params.id)

        const idempotencyWhere = and(
            eq(campaigns.organizationId, principal.organizationId),
            eq(campaigns.agentCredentialId, principal.credentialId),
            eq(campaigns.agentIdempotencyKey, input.idempotencyKey),
        )
        const replayed = await db.query.campaigns.findFirst({ where: idempotencyWhere })
        if (replayed) {
            return res.status(200).json({ campaign: { id: replayed.id, name: replayed.name, status: replayed.status }, copiedFrom: source.id, idempotentReplay: true, activationRequired: true })
        }

        const sourceSequence = await db.query.sequences.findFirst({
            where: eq(sequences.campaignId, source.id),
            with: { steps: { orderBy: [asc(sequenceSteps.stepOrder)] } },
        })
        const name = (input.name ?? `${source.name} (copy)`).slice(0, 100)

        const created = await db.transaction(async (tx) => {
            const [campaign] = await tx.insert(campaigns).values({
                ...buildDuplicateCampaignValues(source),
                // Autonomy opt-ins are a human decision: a copy made by the agent never inherits them.
                agenticFollowupEnabled: false,
                aiAutonomousEnabled: false,
                name,
                agentCredentialId: principal.credentialId,
                agentIdempotencyKey: input.idempotencyKey,
            }).onConflictDoNothing({
                target: [campaigns.organizationId, campaigns.agentCredentialId, campaigns.agentIdempotencyKey],
            }).returning()
            if (!campaign) return null
            const [sequence] = await tx.insert(sequences).values({
                campaignId: campaign.id,
                name: sourceSequence?.name ?? 'Main Sequence',
                description: sourceSequence?.description ?? 'Duplicated by an outreach agent; human activation is required',
            }).returning()
            const steps = !sourceSequence || sourceSequence.steps.length === 0
                ? []
                : await tx.insert(sequenceSteps).values(sourceSequence.steps.map((step) => ({
                    sequenceId: sequence.id,
                    stepOrder: step.stepOrder,
                    type: step.type,
                    delayHours: step.delayHours,
                    // The random-wait upper bound is part of the cadence; losing it silently
                    // turns a 48-72h wait into a fixed 48h one.
                    delayHoursMax: step.delayHoursMax,
                    subject: step.subject,
                    plainBody: step.plainBody,
                    htmlBody: step.htmlBody,
                    subjectB: step.subjectB,
                    plainBodyB: step.plainBodyB,
                    htmlBodyB: step.htmlBodyB,
                    abTestEnabled: step.abTestEnabled,
                    abTestPercentage: step.abTestPercentage,
                }))).returning()
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.campaign.duplicated',
                resourceType: 'campaign',
                resourceId: campaign.id,
                metadata: {
                    sourceCampaignId: source.id,
                    sourceCampaignName: source.name,
                    newCampaignId: campaign.id,
                    stepCount: steps.length,
                    idempotencyKey: input.idempotencyKey,
                    reason: input.reason ?? null,
                },
            })
            return { campaign, sequence, steps }
        })

        if (!created) {
            const raced = await db.query.campaigns.findFirst({ where: idempotencyWhere })
            if (!raced) throw new Error('Idempotent duplicate conflict could not be resolved')
            return res.status(200).json({ campaign: { id: raced.id, name: raced.name, status: raced.status }, copiedFrom: source.id, idempotentReplay: true, activationRequired: true })
        }
        res.status(201).json({
            campaign: { id: created.campaign.id, name: created.campaign.name, status: created.campaign.status },
            copiedFrom: source.id,
            sequenceId: created.sequence.id,
            steps: created.steps.map((step) => ({
                stepOrder: step.stepOrder,
                type: step.type,
                delayHours: step.delayHours,
                delayHoursMax: step.delayHoursMax,
                subject: step.subject,
            })),
            leadsCopied: 0,
            activationRequired: true,
            idempotentReplay: false,
        })
    } catch (error) {
        handleManageError(error, res, 'campaign duplicate')
    }
})

router.post('/campaigns/:id/resume', async (req, res) => {
    try {
        const principal = requireScope(req, res, MANAGE_SCOPE)
        if (!principal) return
        const input = resumeSchema.parse(req.body ?? {})
        const campaign = await loadCampaign(principal.organizationId, req.params.id)

        if (campaign.status === 'active') {
            return res.json({ resumed: false, alreadyActive: true, campaign: { id: campaign.id, status: campaign.status } })
        }
        const verdict = await resumeVerdict(principal.organizationId, campaign)
        if (!verdict.resumable) {
            throw new ManageError(409, {
                error: verdict.reason,
                code: verdict.code,
                howToProceed: 'Use xmail_request_campaign_activation; a human approves it.',
            })
        }

        // The same gate a human activation passes (sequence, leads with an inbox, protected
        // domain, warm-up-only inboxes, warm-up ramp). A campaign that has drifted since it was
        // approved does not get to restart on the strength of an old approval.
        const issues = await validateCampaignReadyForActivation(campaign.id, principal.organizationId)
        if (issues.length > 0) {
            throw new ManageError(422, {
                error: 'Campaign is not ready to run',
                code: 'campaign_not_ready',
                issues,
                details: issues.map((issue) => issue.message),
            })
        }

        const resumed = await db.transaction(async (tx) => {
            const [current] = await tx
                .select()
                .from(campaigns)
                .where(and(eq(campaigns.id, campaign.id), eq(campaigns.organizationId, principal.organizationId)))
                .for('update')
            if (!current || current.status !== 'paused') {
                throw new ManageError(409, { error: 'Campaign state changed concurrently', code: 'campaign_state_changed' })
            }
            const [updated] = await tx
                .update(campaigns)
                .set({ status: 'active', pausedAt: null, pausedReason: null, updatedAt: new Date() })
                .where(and(
                    eq(campaigns.id, current.id),
                    eq(campaigns.organizationId, principal.organizationId),
                    eq(campaigns.status, 'paused'),
                ))
                .returning()
            if (!updated) throw new ManageError(409, { error: 'Campaign state changed concurrently', code: 'campaign_state_changed' })
            await auditManage({
                principal,
                request: req,
                executor: tx,
                action: 'agent.campaign.resumed',
                resourceType: 'campaign',
                resourceId: current.id,
                metadata: {
                    campaignId: current.id,
                    campaignName: current.name,
                    previousStatus: current.status,
                    pausedReason: current.pausedReason,
                    pausedAt: current.pausedAt,
                    activationApprovalId: current.activationApprovalId,
                    reason: input.reason ?? null,
                },
            })
            return updated
        })

        await publishOutreachEvent({
            organizationId: principal.organizationId,
            eventType: 'campaign.resumed',
            aggregateType: 'campaign',
            aggregateId: resumed.id,
            deduplicationKey: `agent:campaign.resumed:${resumed.id}:${resumed.updatedAt.getTime()}`,
            payload: { campaign_id: resumed.id, activation_approval_id: campaign.activationApprovalId },
        })
        res.json({
            resumed: true,
            campaign: { id: resumed.id, name: resumed.name, status: resumed.status },
            basedOnApproval: campaign.activationApprovalId,
        })
    } catch (error) {
        handleManageError(error, res, 'campaign resume')
    }
})

export default router
