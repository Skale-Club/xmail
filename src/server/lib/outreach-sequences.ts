import { z } from 'zod'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    campaigns,
    sequences,
    sequenceSteps,
    campaignLeads,
    outreachEmails,
    type Sequence,
    type SequenceStep,
} from '../../db/schema'

/**
 * Canonical sequence contract (Phase 20, CONS-01/CONS-07).
 *
 * A campaign has exactly ONE sequence (enforced by sequences_campaign_id_unique). The public write
 * contract replaces the entire ordered step set transactionally: step order is derived from array
 * position (one-based, contiguous), email steps require a subject and at least one body, and
 * non-email steps cannot carry sendable content. These invariants are mirrored in the running
 * PostgreSQL schema (migration 040) and src/db/schema.ts.
 */

const emailStepSchema = z
    .object({
        type: z.literal('email'),
        delayHours: z.number().int().min(0).default(0),
        subject: z.string().trim().min(1, 'Email steps require a subject'),
        plainBody: z.string().optional(),
        htmlBody: z.string().optional(),
        subjectB: z.string().optional(),
        plainBodyB: z.string().optional(),
        htmlBodyB: z.string().optional(),
        abTestEnabled: z.boolean().default(false),
        abTestPercentage: z.number().int().min(0).max(100).default(50),
    })
    .strict()

const delayStepSchema = z
    .object({
        type: z.literal('delay'),
        delayHours: z.number().int().min(0),
    })
    .strict()

// Condition steps are accepted as an explicitly documented, content-free shape. Branching is not
// executable yet (the processor quarantines them), so they carry no sendable content and no
// undocumented payload — matching the "explicitly validated" locked decision.
const conditionStepSchema = z
    .object({
        type: z.literal('condition'),
        delayHours: z.number().int().min(0).default(0),
    })
    .strict()

export const sequenceStepInputSchema = z.discriminatedUnion('type', [
    emailStepSchema,
    delayStepSchema,
    conditionStepSchema,
])

export const sequencePayloadSchema = z
    .object({
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(1000).nullish(),
        steps: z
            .array(sequenceStepInputSchema)
            .min(1, 'A sequence needs at least one step')
            .max(50, 'A sequence cannot exceed 50 steps'),
    })
    .superRefine((payload, ctx) => {
        payload.steps.forEach((step, index) => {
            if (step.type === 'email') {
                const hasBody = Boolean(step.plainBody?.trim() || step.htmlBody?.trim())
                if (!hasBody) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['steps', index, 'plainBody'],
                        message: 'Email steps require a plain-text or HTML body',
                    })
                }
                if (step.abTestEnabled) {
                    if (!step.subjectB?.trim()) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            path: ['steps', index, 'subjectB'],
                            message: 'Enabled A/B tests require a Variant B subject',
                        })
                    }
                    if (!step.plainBodyB?.trim() && !step.htmlBodyB?.trim()) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            path: ['steps', index, 'plainBodyB'],
                            message: 'Enabled A/B tests require a Variant B body',
                        })
                    }
                }
            }
        })
    })

export type SequenceStepInput = z.infer<typeof sequenceStepInputSchema>
export type SequencePayload = z.infer<typeof sequencePayloadSchema>

export type CanonicalSequence = Sequence & { steps: SequenceStep[] }

export type ReplaceSequenceResult =
    | { ok: true; sequence: CanonicalSequence }
    | { ok: false; reason: 'campaign_not_found' }
    | { ok: false; reason: 'campaign_not_editable'; status: string }
    | { ok: false; reason: 'history_conflict'; conflicts: Array<{ stepId: string; stepOrder: number }> }

const EDITABLE_CAMPAIGN_STATUSES = new Set(['draft', 'paused'])

function emptyToNull(value: string | undefined | null): string | null {
    if (value == null) return null
    return value.trim() ? value : null
}

function stepToColumns(step: SequenceStepInput, order: number, now: Date) {
    if (step.type === 'email') {
        return {
            stepOrder: order,
            type: 'email' as const,
            delayHours: step.delayHours,
            subject: step.subject,
            plainBody: emptyToNull(step.plainBody),
            htmlBody: emptyToNull(step.htmlBody),
            subjectB: emptyToNull(step.subjectB),
            plainBodyB: emptyToNull(step.plainBodyB),
            htmlBodyB: emptyToNull(step.htmlBodyB),
            abTestEnabled: step.abTestEnabled,
            abTestPercentage: step.abTestPercentage,
            updatedAt: now,
        }
    }
    // delay / condition: never carry sendable content (matches sequence_steps_content_valid).
    return {
        stepOrder: order,
        type: step.type,
        delayHours: step.delayHours,
        subject: null,
        plainBody: null,
        htmlBody: null,
        subjectB: null,
        plainBodyB: null,
        htmlBodyB: null,
        abTestEnabled: false,
        abTestPercentage: null,
        updatedAt: now,
    }
}

/**
 * Resolve the single canonical sequence for a campaign, scoped through the campaign's organization.
 * Returns null when the campaign does not exist or belongs to another organization. Uniqueness is
 * database-enforced, so this never depends on first-row ordering to disambiguate.
 */
export async function getCanonicalSequence(
    campaignId: string,
    organizationId: string,
): Promise<CanonicalSequence | null> {
    const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
        columns: { id: true },
    })
    if (!campaign) return null

    const sequence = await db.query.sequences.findFirst({
        where: eq(sequences.campaignId, campaignId),
        orderBy: [asc(sequences.createdAt), asc(sequences.id)],
        with: {
            steps: {
                orderBy: (step, { asc: ascending }) => [ascending(step.stepOrder)],
            },
        },
    })

    return (sequence as CanonicalSequence | undefined) ?? null
}

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function findReferencedStepIds(tx: TransactionClient, stepIds: string[]): Promise<Set<string>> {
    if (stepIds.length === 0) return new Set()
    const referenced = new Set<string>()

    const leadRefs = await tx
        .select({ id: campaignLeads.currentStepId })
        .from(campaignLeads)
        .where(inArray(campaignLeads.currentStepId, stepIds))
    for (const row of leadRefs) if (row.id) referenced.add(row.id)

    const emailRefs = await tx
        .select({ id: outreachEmails.sequenceStepId })
        .from(outreachEmails)
        .where(inArray(outreachEmails.sequenceStepId, stepIds))
    for (const row of emailRefs) if (row.id) referenced.add(row.id)

    return referenced
}

/**
 * Transactionally replace the campaign's complete ordered step set.
 *
 * - Locks the campaign row (organization-scoped) and only proceeds for draft/paused campaigns.
 * - Preserves the ids of existing positions (idempotent for an identical payload) so historical
 *   outreach_email / campaign_lead references stay valid.
 * - Refuses to delete a trailing step that still has send history or a current lead pointer,
 *   returning a `history_conflict` instead of orphaning it. All work happens after the conflict
 *   gate, so a rejected or failed edit never leaves a partial change.
 */
export async function replaceCanonicalSequence(input: {
    campaignId: string
    organizationId: string
    payload: SequencePayload
}): Promise<ReplaceSequenceResult> {
    const { campaignId, organizationId, payload } = input

    return db.transaction(async (tx): Promise<ReplaceSequenceResult> => {
        const lockedCampaign = (
            await tx.execute(sql`
                SELECT id, status::text AS status
                FROM campaigns
                WHERE id = ${campaignId}::uuid AND organization_id = ${organizationId}::uuid
                FOR UPDATE
            `)
        ) as unknown as Array<{ id: string; status: string }> | { rows?: Array<{ id: string; status: string }> }

        const campaignRows = Array.isArray(lockedCampaign)
            ? lockedCampaign
            : lockedCampaign.rows ?? []
        const campaign = campaignRows[0]
        if (!campaign) return { ok: false, reason: 'campaign_not_found' }
        if (!EDITABLE_CAMPAIGN_STATUSES.has(campaign.status)) {
            return { ok: false, reason: 'campaign_not_editable', status: campaign.status }
        }

        const existingSequence = await tx.query.sequences.findFirst({
            where: eq(sequences.campaignId, campaignId),
            orderBy: [asc(sequences.createdAt), asc(sequences.id)],
        })
        const existingSteps = existingSequence
            ? await tx.query.sequenceSteps.findMany({
                where: eq(sequenceSteps.sequenceId, existingSequence.id),
                orderBy: [asc(sequenceSteps.stepOrder)],
            })
            : []

        // Positions removed by this edit — refuse if any still carry history (do this before any
        // write so a conflict never commits a partial change).
        const surplusSteps = existingSteps.slice(payload.steps.length)
        if (surplusSteps.length > 0) {
            const referenced = await findReferencedStepIds(tx, surplusSteps.map((step) => step.id))
            if (referenced.size > 0) {
                return {
                    ok: false,
                    reason: 'history_conflict',
                    conflicts: surplusSteps
                        .filter((step) => referenced.has(step.id))
                        .map((step) => ({ stepId: step.id, stepOrder: step.stepOrder })),
                }
            }
        }

        const now = new Date()

        // Resolve (or create) the canonical sequence row.
        let sequenceRow: Sequence
        if (existingSequence) {
            if (payload.name || payload.description !== undefined) {
                const [updated] = await tx
                    .update(sequences)
                    .set({
                        ...(payload.name ? { name: payload.name } : {}),
                        ...(payload.description !== undefined ? { description: payload.description ?? null } : {}),
                        updatedAt: now,
                    })
                    .where(eq(sequences.id, existingSequence.id))
                    .returning()
                sequenceRow = updated
            } else {
                sequenceRow = existingSequence
            }
        } else {
            const [created] = await tx
                .insert(sequences)
                .values({
                    campaignId,
                    name: payload.name ?? 'Main Sequence',
                    description: payload.description ?? null,
                })
                .returning()
            sequenceRow = created
        }

        // Remove the (verified-unreferenced) trailing steps first so in-place updates never collide
        // on sequence_step_order_unique.
        if (surplusSteps.length > 0) {
            await tx.delete(sequenceSteps).where(inArray(sequenceSteps.id, surplusSteps.map((step) => step.id)))
        }

        const resultSteps: SequenceStep[] = []
        for (let index = 0; index < payload.steps.length; index++) {
            const values = stepToColumns(payload.steps[index], index + 1, now)
            const existing = existingSteps[index]
            if (existing) {
                const [updated] = await tx
                    .update(sequenceSteps)
                    .set(values)
                    .where(eq(sequenceSteps.id, existing.id))
                    .returning()
                resultSteps.push(updated)
            } else {
                const [inserted] = await tx
                    .insert(sequenceSteps)
                    .values({ sequenceId: sequenceRow.id, ...values })
                    .returning()
                resultSteps.push(inserted)
            }
        }

        return { ok: true, sequence: { ...sequenceRow, steps: resultSteps } }
    })
}

export type DeleteSequenceStepResult =
    | { ok: true }
    | { ok: false; reason: 'step_not_found' }
    | { ok: false; reason: 'step_referenced'; stepId: string; stepOrder: number }

/**
 * Hard-delete a single sequence step, but ONLY when it carries no send history and no active lead
 * pointer. A referenced step (any `outreach_emails.sequence_step_id` or
 * `campaign_leads.current_step_id` pointing at it) is refused with `step_referenced` — the SAME
 * history-preservation gate `replaceCanonicalSequence` enforces, reusing `findReferencedStepIds`
 * so the check is never duplicated. Without this gate the `ON DELETE CASCADE` on
 * `outreach_emails.sequence_step_id` (schema.ts) would silently destroy sent-mail records.
 *
 * The step is resolved and deleted inside one transaction, scoped through its campaign
 * organization; a missing or cross-tenant step returns `step_not_found`.
 */
export async function deleteSequenceStep(input: {
    stepId: string
    organizationId: string
}): Promise<DeleteSequenceStepResult> {
    const { stepId, organizationId } = input

    return db.transaction(async (tx): Promise<DeleteSequenceStepResult> => {
        const step = await tx.query.sequenceSteps.findFirst({
            where: eq(sequenceSteps.id, stepId),
            columns: { id: true, stepOrder: true },
            with: {
                sequence: {
                    columns: { id: true },
                    with: { campaign: { columns: { organizationId: true } } },
                },
            },
        })
        if (!step || step.sequence.campaign.organizationId !== organizationId) {
            return { ok: false, reason: 'step_not_found' }
        }

        const referenced = await findReferencedStepIds(tx, [stepId])
        if (referenced.has(stepId)) {
            return { ok: false, reason: 'step_referenced', stepId, stepOrder: step.stepOrder }
        }

        await tx.delete(sequenceSteps).where(eq(sequenceSteps.id, stepId))
        return { ok: true }
    })
}
