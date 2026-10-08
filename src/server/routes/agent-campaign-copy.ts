import { Router, type Request, type Response } from 'express'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../db'
import {
    campaigns,
    outreachActionApprovals,
    sequences,
    sequenceSteps,
    type OutreachAgentScope,
    type SequenceStep,
} from '../../db/schema'
import { agentHasScope, getAgentPrincipal, type AgentPrincipal } from '../lib/agent-auth'
import { writeAgentAudit } from '../lib/agent-audit'
import {
    STEP_COPY_REVERTED_ACTION,
    STEP_COPY_UPDATED_ACTION,
    VERSIONED_STEP_FIELDS,
    loadStepCopyEvents,
    pickRevertTarget,
    snapshotFields,
    summarizeStepChange,
    type StepSnapshot,
} from '../lib/agent-campaign-copy-history'
import { lintCampaignCopy } from '../lib/campaign-copy-lint'
import { validateSequenceForActivation, type SequenceValidationIssueCode } from '../lib/outreach-sequence-state'

/**
 * Hermes "read and edit campaign copy" capability.
 *
 *   GET  /campaigns/:id/sequence                                 scope campaigns:copy
 *   PUT  /campaigns/:id/sequence/steps/:stepOrder                scope campaigns:copy
 *   POST /campaigns/:id/sequence/steps/:stepOrder/revert         scope campaigns:copy
 *
 * What it can NOT do, by construction: send, activate, change campaign status, add or remove
 * steps, touch leads, or touch the A/B variant columns. An edit is rejected unless the edited
 * step would still pass the same per-step checks activation runs (`validateSequenceForActivation`:
 * non-empty content, `{{unsubscribeUrl}}` in the sent body, well-formed `{{#flag}}` blocks), so
 * this route can never move a campaign further from activation-ready than it found it.
 *
 * Every edit and revert is written to `outreach_agent_audit_log` in the SAME transaction as the
 * change, with the before/after of the changed fields; that row is also the version history the
 * revert route reads (see agent-campaign-copy-history.ts). If the audit insert fails, the edit
 * rolls back.
 */

const router = Router()

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

function isUuid(value: string): boolean {
    return z.string().uuid().safeParse(value).success
}

function parseStepOrder(value: string): number | null {
    const parsed = z.coerce.number().int().min(1).max(1000).safeParse(value)
    return parsed.success ? parsed.data : null
}

const EDITABLE_STATUSES = new Set(['draft', 'paused', 'active'])

type CopyField = 'subject' | 'plainBody' | 'htmlBody'
const COPY_FIELDS: readonly CopyField[] = ['subject', 'plainBody', 'htmlBody']

// Body edits are partial and need a real value: nothing here clears a body (the
// sequence_steps_content_valid check forbids an email step without one anyway). The subject may be
// '' on a follow-up, which sends it as a reply in the same thread (`Re: <previous subject>`);
// assertEditedStepStillValid still refuses a blank subject on the FIRST email step.
const updateStepSchema = z.object({
    subject: z.string().trim().max(500).optional(),
    plainBody: z.string().trim().min(1).max(100_000).optional(),
    htmlBody: z.string().trim().min(1).max(250_000).optional(),
    delayHours: z.number().int().min(0).max(24 * 90).optional(),
    // null clears the upper bound (fixed delay). Absent leaves delay_hours_max untouched.
    delayHoursMax: z.number().int().min(0).max(24 * 90).nullable().optional(),
    /** Why the copy is being changed; stored verbatim in the audit row. */
    reason: z.string().trim().max(500).optional(),
}).strict().refine(
    (value) => ['subject', 'plainBody', 'htmlBody', 'delayHours', 'delayHoursMax'].some(
        (key) => (value as Record<string, unknown>)[key] !== undefined,
    ),
    { message: 'Provide at least one of subject, plainBody, htmlBody, delayHours, delayHoursMax' },
)
type UpdateStepInput = z.infer<typeof updateStepSchema>

const revertStepSchema = z.object({
    reason: z.string().trim().max(500).optional(),
}).strict()

/** Raised inside a transaction to abort it with a specific HTTP answer. */
class CopyEditError extends Error {
    constructor(readonly status: number, readonly body: Record<string, unknown>) {
        super(String(body.error ?? 'Copy edit rejected'))
    }
}

interface CopyWarning {
    code: string
    message: string
    field?: string
    matches?: string[]
}

function appliesTo(status: string): string {
    // Active and paused campaigns have already started: what was sent stays sent, and the live
    // step row is read at send time, so the edit reaches only mail that has not gone out yet.
    return status === 'draft' ? 'all sends once the campaign is activated' : 'future sends only'
}

function toStepView(step: SequenceStep) {
    return {
        id: step.id,
        stepOrder: step.stepOrder,
        type: step.type,
        delayHours: step.delayHours,
        delayHoursMax: step.delayHoursMax,
        subject: step.subject,
        plainBody: step.plainBody,
        htmlBody: step.htmlBody,
        abTestEnabled: step.abTestEnabled,
        abTestPercentage: step.abTestPercentage,
        subjectB: step.subjectB,
        plainBodyB: step.plainBodyB,
        htmlBodyB: step.htmlBodyB,
        totalSent: step.totalSent,
        totalOpens: step.totalOpens,
        totalClicks: step.totalClicks,
        totalReplies: step.totalReplies,
        updatedAt: step.updatedAt,
    }
}

function campaignView(campaign: { id: string; name: string; status: string }) {
    return { id: campaign.id, name: campaign.name, status: campaign.status }
}

async function loadCampaignWithSteps(organizationId: string, campaignId: string) {
    const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
    })
    if (!campaign) return null
    const sequence = await db.query.sequences.findFirst({
        where: eq(sequences.campaignId, campaign.id),
        with: { steps: { orderBy: [asc(sequenceSteps.stepOrder)] } },
    })
    return { campaign, sequence: sequence ?? null, steps: (sequence?.steps ?? []) as SequenceStep[] }
}

async function hasPendingActivationApproval(organizationId: string, campaignId: string): Promise<boolean> {
    const pending = await db.query.outreachActionApprovals.findFirst({
        where: and(
            eq(outreachActionApprovals.organizationId, organizationId),
            eq(outreachActionApprovals.actionKind, 'campaign_activation'),
            eq(outreachActionApprovals.resourceType, 'campaign'),
            eq(outreachActionApprovals.resourceId, campaignId),
            eq(outreachActionApprovals.status, 'requested'),
        ),
        columns: { id: true },
        orderBy: [desc(outreachActionApprovals.requestedAt)],
    })
    return Boolean(pending)
}

// The per-step subset of validateSequenceForActivation an edit has to keep passing. Anything else
// it reports (duplicate order, missing email step...) is about the sequence, not about this edit.
const BLOCKING_ISSUE_CODES = new Set<SequenceValidationIssueCode>([
    'invalid_email_content',
    'missing_unsubscribe_placeholder',
    'malformed_template_block',
])

function assertEditedStepStillValid(steps: SequenceStep[], edited: SequenceStep): void {
    const candidate = steps.map((step) => (step.id === edited.id ? edited : step))
    const issues = validateSequenceForActivation(candidate)
        .filter((issue) => issue.stepId === edited.id && BLOCKING_ISSUE_CODES.has(issue.code))
    if (issues.length > 0) {
        throw new CopyEditError(422, {
            error: `Step ${edited.stepOrder} would fail the activation checks after this change; nothing was saved`,
            code: 'step_validation_failed',
            issues: issues.map((issue) => ({ code: issue.code, message: issue.message })),
        })
    }
    // validateSequenceForActivation looks at plain + HTML together, so a link left in only one of
    // them passes. Found in production on 2026-10-07: an edit that dropped {{unsubscribeUrl}} from the
    // plain body of a step whose HTML still had it was saved. Every non-empty body must carry it.
    const missing = (['plainBody', 'htmlBody'] as const).filter((field) => {
        const body = edited[field]?.trim()
        return Boolean(body) && !body!.includes(UNSUBSCRIBE_TOKEN)
    })
    if (missing.length > 0) {
        throw new CopyEditError(422, {
            error: `Step ${edited.stepOrder} would lose the unsubscribe link in ${missing.join(' and ')}; nothing was saved`,
            code: 'step_validation_failed',
            issues: missing.map((field) => ({
                code: 'missing_unsubscribe_placeholder',
                message: `${field} must render {{unsubscribeUrl}} (CAN-SPAM).`,
            })),
        })
    }
}

const UNSUBSCRIBE_TOKEN = '{{unsubscribeUrl}}'

function buildWarnings(input: {
    before: SequenceStep
    after: SequenceStep
    patch: StepSnapshot
    pendingActivationApproval: boolean
}): CopyWarning[] {
    const { before, after, patch } = input
    const copyChanged = COPY_FIELDS.some((field) => field in patch)
    const warnings: CopyWarning[] = []
    if (!copyChanged) return warnings

    warnings.push(...lintCampaignCopy({
        subject: 'subject' in patch ? after.subject : undefined,
        plainBody: 'plainBody' in patch ? after.plainBody : undefined,
        htmlBody: 'htmlBody' in patch ? after.htmlBody : undefined,
    }))

    const plainEdited = 'plainBody' in patch
    const htmlEdited = 'htmlBody' in patch
    if (plainEdited !== htmlEdited) {
        const edited = plainEdited ? 'plainBody' : 'htmlBody'
        const untouched = plainEdited ? 'htmlBody' : 'plainBody'
        if (before[untouched]?.trim()) {
            warnings.push({
                code: 'body_left_unchanged',
                field: untouched,
                message: `Only ${edited} was edited; ${untouched} was left unchanged and may now say something different. Edit both together, or confirm that is intended.`,
            })
        }
    }

    const plain = after.plainBody?.trim()
    const html = after.htmlBody?.trim()
    if (plain && html && plain.includes(UNSUBSCRIBE_TOKEN) !== html.includes(UNSUBSCRIBE_TOKEN)) {
        warnings.push({
            code: 'unsubscribe_missing_in_one_body',
            field: plain.includes(UNSUBSCRIBE_TOKEN) ? 'htmlBody' : 'plainBody',
            message: 'Only one of plainBody and htmlBody renders {{unsubscribeUrl}}. Recipients who read the other version get no unsubscribe link.',
        })
    }

    if (after.abTestEnabled) {
        warnings.push({
            code: 'ab_variant_b_unchanged',
            message: 'A/B testing is on for this step. Only variant A was edited; subjectB/plainBodyB/htmlBodyB were not touched.',
        })
    }

    if (input.pendingActivationApproval) {
        warnings.push({
            code: 'pending_activation_approval',
            message: 'An activation approval is waiting for this campaign. Vanildo will approve whatever copy exists when he clicks approve, so tell him the copy changed.',
        })
    }

    return warnings
}

type StepRow = SequenceStep

/** Lock the step row so two writers cannot both build their "before" from the same state. */
async function lockStep(tx: Pick<typeof db, 'select'>, sequenceId: string, stepId: string): Promise<StepRow> {
    const [current] = await tx
        .select()
        .from(sequenceSteps)
        .where(and(eq(sequenceSteps.id, stepId), eq(sequenceSteps.sequenceId, sequenceId)))
        .for('update')
    if (!current) throw new CopyEditError(404, { error: 'Step not found' })
    return current as StepRow
}

function currentSnapshot(step: StepRow, fields: readonly string[]): StepSnapshot {
    return snapshotFields(step as unknown as Record<string, unknown>, fields as typeof VERSIONED_STEP_FIELDS)
}

function sameValue(left: unknown, right: unknown): boolean {
    return (left ?? null) === (right ?? null)
}

function planUpdate(current: StepRow, steps: SequenceStep[], input: UpdateStepInput) {
    const wantsCopy = COPY_FIELDS.some((field) => input[field] !== undefined)
    if (wantsCopy && current.type !== 'email') {
        throw new CopyEditError(422, {
            error: `Step ${current.stepOrder} is a ${current.type} step and carries no email copy`,
            code: 'not_an_email_step',
        })
    }

    const patch: StepSnapshot = {}
    for (const field of COPY_FIELDS) {
        const value = input[field]
        if (value !== undefined && !sameValue(value, current[field])) patch[field] = value
    }
    if (input.delayHours !== undefined && input.delayHours !== current.delayHours) patch.delayHours = input.delayHours
    // delay_hours_max is only ever written when the payload names it.
    if (input.delayHoursMax !== undefined && !sameValue(input.delayHoursMax, current.delayHoursMax)) {
        patch.delayHoursMax = input.delayHoursMax
    }
    if (Object.keys(patch).length === 0) return { changed: false as const, current }

    const minimum = patch.delayHours ?? current.delayHours
    const maximum = 'delayHoursMax' in patch ? patch.delayHoursMax : current.delayHoursMax
    if (maximum != null && maximum < minimum) {
        throw new CopyEditError(422, {
            error: 'delayHoursMax must be greater than or equal to delayHours',
            code: 'invalid_delay_range',
            delayHours: minimum,
            delayHoursMax: maximum,
        })
    }

    const edited = { ...current, ...patch } as StepRow
    if (COPY_FIELDS.some((field) => field in patch)) assertEditedStepStillValid(steps, edited)

    return { changed: true as const, current, edited, patch }
}

/** The fields the audit row and the response show: only what changed, from the locked row. */
function beforeAfter(current: StepRow, patch: StepSnapshot) {
    const fields = Object.keys(patch)
    return { before: currentSnapshot(current, fields), after: { ...patch } as StepSnapshot }
}

router.get('/campaigns/:id/sequence', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:copy')
        if (!principal) return
        if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Campaign not found' })
        const loaded = await loadCampaignWithSteps(principal.organizationId, req.params.id)
        if (!loaded) return res.status(404).json({ error: 'Campaign not found' })
        const editable = EDITABLE_STATUSES.has(loaded.campaign.status)
        res.json({
            campaign: campaignView(loaded.campaign),
            sequenceId: loaded.sequence?.id ?? null,
            editable,
            appliesTo: editable ? appliesTo(loaded.campaign.status) : null,
            steps: loaded.steps.map((step) => ({
                ...toStepView(step),
                lint: step.type === 'email'
                    ? lintCampaignCopy({ subject: step.subject, plainBody: step.plainBody, htmlBody: step.htmlBody })
                    : [],
            })),
        })
    } catch (error) {
        console.error('Agent campaign sequence read failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.put('/campaigns/:id/sequence/steps/:stepOrder', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:copy')
        if (!principal) return
        const stepOrder = parseStepOrder(req.params.stepOrder)
        if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Campaign not found' })
        if (stepOrder === null) return res.status(404).json({ error: 'Step not found' })
        const input = updateStepSchema.parse(req.body)

        const loaded = await loadCampaignWithSteps(principal.organizationId, req.params.id)
        if (!loaded) return res.status(404).json({ error: 'Campaign not found' })
        const { campaign, sequence, steps } = loaded
        if (!EDITABLE_STATUSES.has(campaign.status)) {
            return res.status(409).json({ error: `Copy of a ${campaign.status} campaign cannot be edited`, code: 'campaign_not_editable' })
        }
        const target = steps.find((step) => step.stepOrder === stepOrder)
        if (!sequence || !target) return res.status(404).json({ error: 'Step not found' })
        const pendingActivationApproval = await hasPendingActivationApproval(principal.organizationId, campaign.id)

        const outcome = await db.transaction(async (tx) => {
            const current = await lockStep(tx, sequence.id, target.id)
            const plan = planUpdate(current, steps, input)
            if (!plan.changed) return { changed: false as const, step: current }

            const { before, after } = beforeAfter(current, plan.patch)
            const warnings = buildWarnings({
                before: current,
                after: plan.edited,
                patch: plan.patch,
                pendingActivationApproval,
            })
            const summary = summarizeStepChange(before, after)
            const [updated] = await tx.update(sequenceSteps)
                .set({ ...plan.patch, updatedAt: new Date() })
                .where(and(eq(sequenceSteps.id, current.id), eq(sequenceSteps.sequenceId, sequence.id)))
                .returning()
            await writeAgentAudit({
                principal,
                request: req,
                action: STEP_COPY_UPDATED_ACTION,
                resourceType: 'campaign',
                resourceId: campaign.id,
                executor: tx,
                metadata: {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    campaignStatus: campaign.status,
                    stepOrder: current.stepOrder,
                    stepId: current.id,
                    appliesTo: appliesTo(campaign.status),
                    reason: input.reason ?? null,
                    changedFields: Object.keys(plan.patch),
                    summary: summary.text,
                    diff: summary.fields,
                    warningCodes: warnings.map((warning) => warning.code),
                    before,
                    after,
                },
            })
            return { changed: true as const, step: updated, before, after, warnings }
        })

        if (!outcome.changed) {
            return res.json({
                campaign: campaignView(campaign),
                changed: false,
                changedFields: [],
                step: toStepView(outcome.step),
                appliesTo: appliesTo(campaign.status),
                warnings: [],
                versionStored: false,
                note: 'The payload matches what is already saved; nothing was written.',
            })
        }
        res.json({
            campaign: campaignView(campaign),
            changed: true,
            changedFields: Object.keys(outcome.after),
            before: outcome.before,
            after: outcome.after,
            step: toStepView(outcome.step),
            appliesTo: appliesTo(campaign.status),
            alreadySent: outcome.step.totalSent,
            warnings: outcome.warnings,
            versionStored: true,
            activationRequired: campaign.status !== 'active',
            revert: { method: 'POST', path: `/campaigns/${campaign.id}/sequence/steps/${stepOrder}/revert` },
        })
    } catch (error) {
        if (error instanceof CopyEditError) return res.status(error.status).json(error.body)
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign step update failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.post('/campaigns/:id/sequence/steps/:stepOrder/revert', async (req, res) => {
    try {
        const principal = requireScope(req, res, 'campaigns:copy')
        if (!principal) return
        const stepOrder = parseStepOrder(req.params.stepOrder)
        if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Campaign not found' })
        if (stepOrder === null) return res.status(404).json({ error: 'Step not found' })
        const input = revertStepSchema.parse(req.body ?? {})

        const loaded = await loadCampaignWithSteps(principal.organizationId, req.params.id)
        if (!loaded) return res.status(404).json({ error: 'Campaign not found' })
        const { campaign, sequence, steps } = loaded
        if (!EDITABLE_STATUSES.has(campaign.status)) {
            return res.status(409).json({ error: `Copy of a ${campaign.status} campaign cannot be edited`, code: 'campaign_not_editable' })
        }
        const target = steps.find((step) => step.stepOrder === stepOrder)
        if (!sequence || !target) return res.status(404).json({ error: 'Step not found' })

        const outcome = await db.transaction(async (tx) => {
            const current = await lockStep(tx, sequence.id, target.id)
            const events = await loadStepCopyEvents(tx, {
                organizationId: principal.organizationId,
                campaignId: campaign.id,
                stepOrder,
            })
            const lastEdit = pickRevertTarget(events)
            if (!lastEdit) {
                throw new CopyEditError(409, {
                    error: `No agent edit of step ${stepOrder} is left to revert`,
                    code: 'nothing_to_revert',
                })
            }

            // Never overwrite a human: if the step no longer holds what the agent's edit left
            // there, someone changed it since and a blind restore would destroy that change.
            const drifted = Object.keys(lastEdit.after).filter((field) => (
                !sameValue((current as unknown as Record<string, unknown>)[field], (lastEdit.after as Record<string, unknown>)[field])
            ))
            if (drifted.length > 0) {
                throw new CopyEditError(409, {
                    error: `Step ${stepOrder} was changed after the last agent edit (${drifted.join(', ')}); revert refused so that change is not lost`,
                    code: 'step_changed_since_agent_edit',
                    fields: drifted,
                })
            }

            const restore: StepSnapshot = {}
            for (const field of Object.keys(lastEdit.after) as Array<keyof StepSnapshot>) {
                if (field in lastEdit.before) (restore as Record<string, unknown>)[field] = lastEdit.before[field]
            }
            const restoredFields = Object.keys(restore)
            if (restoredFields.length === 0) {
                throw new CopyEditError(409, { error: 'The recorded version holds no fields to restore', code: 'nothing_to_revert' })
            }
            const edited = { ...current, ...restore } as StepRow
            if (COPY_FIELDS.some((field) => field in restore)) assertEditedStepStillValid(steps, edited)

            const { before, after } = beforeAfter(current, restore)
            const warnings = buildWarnings({ before: current, after: edited, patch: restore, pendingActivationApproval: false })
            const summary = summarizeStepChange(before, after)
            const [updated] = await tx.update(sequenceSteps)
                .set({ ...restore, updatedAt: new Date() })
                .where(and(eq(sequenceSteps.id, current.id), eq(sequenceSteps.sequenceId, sequence.id)))
                .returning()
            await writeAgentAudit({
                principal,
                request: req,
                action: STEP_COPY_REVERTED_ACTION,
                resourceType: 'campaign',
                resourceId: campaign.id,
                executor: tx,
                metadata: {
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    campaignStatus: campaign.status,
                    stepOrder: current.stepOrder,
                    stepId: current.id,
                    appliesTo: appliesTo(campaign.status),
                    reason: input.reason ?? null,
                    changedFields: restoredFields,
                    summary: summary.text,
                    diff: summary.fields,
                    warningCodes: warnings.map((warning) => warning.code),
                    before,
                    after,
                },
            })
            return { step: updated, before, after, restoredFields, warnings }
        })

        res.json({
            campaign: campaignView(campaign),
            reverted: true,
            restoredFields: outcome.restoredFields,
            before: outcome.before,
            after: outcome.after,
            step: toStepView(outcome.step),
            appliesTo: appliesTo(campaign.status),
            alreadySent: outcome.step.totalSent,
            warnings: outcome.warnings,
            versionStored: true,
        })
    } catch (error) {
        if (error instanceof CopyEditError) return res.status(error.status).json(error.body)
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Agent campaign step revert failed:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
