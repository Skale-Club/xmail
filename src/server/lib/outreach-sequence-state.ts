import type { CampaignLead, Lead, SequenceStep } from '../../db/schema'
import { nextWindowStart, type SendWindow } from './outreach-send-window'
import { assessCampaignActivationCompliance, type CampaignComplianceStep } from './outreach-campaign-compliance'

/**
 * The exhaustive lead-status contract.
 *
 * `terminal` — the sequence is over for this lead; a terminal status is never reverted,
 * so whichever outcome lands first wins and later facts are recorded as bookkeeping only.
 *
 * `deliverable` — may we still put mail in front of this person at all? Distinct from
 * `terminal`: 'replied' ends the sequence but an agentic follow-up to a live human is the
 * whole point, whereas 'bounced'/'unsubscribed' mean the address must never be mailed
 * again. Suppression covers hard bounces org-wide, but a soft bounce writes no suppression
 * row and outreach-delivery-policy.ts does not consult campaign_leads.status — so without
 * this, processFollowUps would ship to a lead whose own row says bounced (W-2).
 */
export const CAMPAIGN_LEAD_PROGRESS = {
    new: { terminal: false, deliverable: true },
    contacted: { terminal: false, deliverable: true },
    replied: { terminal: true, deliverable: true },
    interested: { terminal: true, deliverable: true },
    not_interested: { terminal: true, deliverable: true },
    bounced: { terminal: true, deliverable: false },
    unsubscribed: { terminal: true, deliverable: false },
} as const satisfies Record<Lead['status'], { terminal: boolean; deliverable: boolean }>

type ProgressEntries = Array<[Lead['status'], (typeof CAMPAIGN_LEAD_PROGRESS)[Lead['status']]]>

export const TERMINAL_CAMPAIGN_LEAD_STATUSES = Object.freeze(
    (Object.entries(CAMPAIGN_LEAD_PROGRESS) as ProgressEntries)
        .filter(([, progress]) => progress.terminal)
        .map(([status]) => status),
)

/** Statuses that forbid any further outbound mail to the lead. */
export const UNDELIVERABLE_CAMPAIGN_LEAD_STATUSES = Object.freeze(
    (Object.entries(CAMPAIGN_LEAD_PROGRESS) as ProgressEntries)
        .filter(([, progress]) => !progress.deliverable)
        .map(([status]) => status),
)

export async function finalizeCampaignDispatchProgress(input: {
    freshSend: boolean
    recordFreshSend: () => Promise<void>
    advanceProgress: () => Promise<boolean>
}): Promise<boolean> {
    if (input.freshSend) await input.recordFreshSend()
    return input.advanceProgress()
}

const terminalCampaignLeadStatuses = new Set<Lead['status']>(TERMINAL_CAMPAIGN_LEAD_STATUSES)

export function isTerminalCampaignLeadStatus(status: Lead['status']): boolean {
    return terminalCampaignLeadStatuses.has(status)
}

const undeliverableCampaignLeadStatuses = new Set<Lead['status']>(UNDELIVERABLE_CAMPAIGN_LEAD_STATUSES)

export function isDeliverableCampaignLeadStatus(status: Lead['status']): boolean {
    return !undeliverableCampaignLeadStatuses.has(status)
}

export function isCampaignProgressComplete(
    progress: Array<Pick<CampaignLead, 'status' | 'completedAt'>>,
): boolean {
    return progress.length > 0
        && progress.every((lead) => lead.completedAt != null || isTerminalCampaignLeadStatus(lead.status))
}

export interface DueWorkCandidate {
    id: string
    emailAccountId: string
    nextScheduledAt: Date
}

/**
 * Mirrors the database selector's ROW_NUMBER-per-account ordering. Keeping the
 * ordering pure makes the fairness contract independently testable.
 */
export function selectFairDueCandidates<T extends DueWorkCandidate>(
    candidates: readonly T[],
    limit: number,
): T[] {
    const accountRank = new Map<string, number>()
    const orderedWithinAccount = [...candidates].sort((left, right) =>
        left.emailAccountId.localeCompare(right.emailAccountId)
        || left.nextScheduledAt.getTime() - right.nextScheduledAt.getTime()
        || left.id.localeCompare(right.id),
    )
    const ranked = orderedWithinAccount.map((candidate) => {
        const rank = (accountRank.get(candidate.emailAccountId) ?? 0) + 1
        accountRank.set(candidate.emailAccountId, rank)
        return { candidate, rank }
    })

    return ranked
        .sort((left, right) =>
            left.rank - right.rank
            || left.candidate.nextScheduledAt.getTime() - right.candidate.nextScheduledAt.getTime()
            || left.candidate.emailAccountId.localeCompare(right.candidate.emailAccountId)
            || left.candidate.id.localeCompare(right.candidate.id),
        )
        .slice(0, Math.max(0, limit))
        .map(({ candidate }) => candidate)
}

/** @deprecated Use `SendWindow` from `./outreach-send-window` — kept as an alias so existing
 * imports of the type name keep working. */
export type SequenceSchedule = SendWindow

export type SequenceQuarantineReason =
    | 'invalid_email_content'
    | 'unsupported_condition_step'
    | 'current_step_not_in_sequence'
    // No minute within the search horizon satisfies the campaign's send window (e.g. a
    // misconfigured start >= end). The old behaviour here was to send anyway with whatever
    // out-of-window candidate the search loop last held — a silent violation of the campaign's
    // own schedule. Now the lead is held (like any other quarantine reason) instead of shipped.
    | 'invalid_send_window'

export type SequenceAction =
    | {
        type: 'send_email'
        step: SequenceStep
        content: { subject: string; plainBody: string | null; htmlBody: string | null }
        nextStep: SequenceStep | null
        nextScheduledAt: Date | null
    }
    | {
        type: 'advance_without_send'
        fromStep: SequenceStep
        nextStep: SequenceStep
        nextScheduledAt: Date
    }
    | { type: 'complete'; completedAt: Date }
    | { type: 'quarantine'; reason: SequenceQuarantineReason; step: SequenceStep }

export type SequenceValidationIssueCode =
    | 'invalid_step_order'
    | 'duplicate_step_order'
    | 'invalid_email_content'
    | 'unsupported_condition_step'
    | 'sequence_missing_email'
    | 'missing_unsubscribe_placeholder'

export interface SequenceValidationIssue {
    code: SequenceValidationIssueCode
    message: string
    stepId?: string
}

/**
 * The candidate instant `delayHours` after `now`, rolled forward to the next minute the
 * schedule actually allows — or `'invalid'` when no minute within the search horizon (14 days)
 * satisfies the schedule at all (a misconfigured window, e.g. start >= end). The caller MUST
 * treat `'invalid'` as "do not send" (see `resolveSequenceAction` below): the previous
 * implementation returned the out-of-window candidate anyway, a silent send-window violation.
 */
function scheduleAfterDelay(now: Date, delayHours: number, schedule: SendWindow): Date | 'invalid' {
    const candidate = new Date(now.getTime() + Math.max(0, delayHours) * 60 * 60 * 1000)
    const next = nextWindowStart(candidate, schedule, { horizonDays: 14 })
    return next ?? 'invalid'
}

function isValidEmailStep(step: SequenceStep): boolean {
    const hasSubject = Boolean(step.subject?.trim())
    const hasBody = Boolean(step.plainBody?.trim() || step.htmlBody?.trim())
    return step.type === 'email' && hasSubject && hasBody
}

function orderedSteps(steps: SequenceStep[]): SequenceStep[] {
    return [...steps].sort((left, right) => left.stepOrder - right.stepOrder)
}

function nextStepAfter(steps: SequenceStep[], currentStep: SequenceStep): SequenceStep | null {
    return orderedSteps(steps).find((step) => step.stepOrder > currentStep.stepOrder) ?? null
}

export function resolveSequenceAction(
    steps: SequenceStep[],
    currentStep: SequenceStep | null,
    now: Date,
    schedule: SequenceSchedule,
): SequenceAction {
    if (!currentStep) {
        return { type: 'complete', completedAt: new Date(now) }
    }

    if (!steps.some((step) => step.id === currentStep.id)) {
        return { type: 'quarantine', reason: 'current_step_not_in_sequence', step: currentStep }
    }

    if (currentStep.type === 'condition') {
        return { type: 'quarantine', reason: 'unsupported_condition_step', step: currentStep }
    }

    const nextStep = nextStepAfter(steps, currentStep)

    if (currentStep.type === 'delay') {
        if (!nextStep) {
            return { type: 'complete', completedAt: new Date(now) }
        }

        const nextScheduledAt = scheduleAfterDelay(now, currentStep.delayHours, schedule)
        if (nextScheduledAt === 'invalid') {
            return { type: 'quarantine', reason: 'invalid_send_window', step: currentStep }
        }

        return {
            type: 'advance_without_send',
            fromStep: currentStep,
            nextStep,
            nextScheduledAt,
        }
    }

    if (!isValidEmailStep(currentStep)) {
        return { type: 'quarantine', reason: 'invalid_email_content', step: currentStep }
    }

    // Explicit delay rows own their wait. They become due immediately and, when resolved,
    // schedule the following row after their delayHours.
    //
    // If that next schedule turns out to have no valid slot at all (an impossible campaign
    // window), we quarantine here rather than send this step with a schedule we cannot honor
    // for the one after it: sending now and leaving the lead pointed at a step with no
    // computable `nextScheduledAt` would silently strand it mid-sequence with no error anyone
    // would see. Quarantining the whole row instead makes the misconfiguration visible via the
    // same `sequence_configuration_error` log line every other quarantine reason already uses.
    let nextScheduledAt: Date | null = null
    if (nextStep) {
        if (nextStep.type === 'email') {
            const candidate = scheduleAfterDelay(now, nextStep.delayHours, schedule)
            if (candidate === 'invalid') {
                return { type: 'quarantine', reason: 'invalid_send_window', step: currentStep }
            }
            nextScheduledAt = candidate
        } else {
            nextScheduledAt = new Date(now)
        }
    }

    return {
        type: 'send_email',
        step: currentStep,
        content: {
            subject: currentStep.subject as string,
            plainBody: currentStep.plainBody,
            htmlBody: currentStep.htmlBody,
        },
        nextStep,
        nextScheduledAt,
    }
}

/**
 * Reject activation when any email step's body does not render `{{unsubscribeUrl}}`.
 *
 * This is deliberately the SAME detection `outreach-campaign-compliance.ts` uses for the
 * human-approval preview (Fase 37 / audit finding 2), reused here rather than reimplemented —
 * the rule (case-sensitive token, checked across plain/HTML body and both A/B variants when
 * A/B testing is on) lives in exactly one place. The difference is what each caller DOES with
 * the finding: there it is informational, shown to the human reviewer without blocking
 * anything (`campaigns.ts` / G9 owns the actual activation gate). HERE it is a hard block —
 * `validateSequenceForActivation` IS part of that gate, so a campaign whose steps lack the
 * placeholder cannot be activated at all. That is intentional (CAN-SPAM compliance; this closes
 * the audit-2026-08-15 finding #6, "nothing exists at all" for the unsubscribe link), not a
 * regression to work around.
 */
export function validateSequenceForActivation(steps: SequenceStep[]): SequenceValidationIssue[] {
    const issues: SequenceValidationIssue[] = []
    const seenOrders = new Set<number>()
    let hasValidEmail = false

    const complianceSteps: CampaignComplianceStep[] = orderedSteps(steps).map((step) => ({
        stepOrder: step.stepOrder,
        type: step.type,
        subject: step.subject,
        plainBody: step.plainBody,
        htmlBody: step.htmlBody,
        subjectB: step.subjectB,
        plainBodyB: step.plainBodyB,
        htmlBodyB: step.htmlBodyB,
        abTestEnabled: step.abTestEnabled,
    }))
    const stepOrdersMissingUnsubscribe = new Set(
        assessCampaignActivationCompliance(complianceSteps).stepsMissingUnsubscribe,
    )

    for (const step of orderedSteps(steps)) {
        if (step.stepOrder < 1) {
            issues.push({
                code: 'invalid_step_order',
                message: 'Sequence step order must be a positive integer.',
                stepId: step.id,
            })
        }

        if (step.type === 'email') {
            if (isValidEmailStep(step)) {
                hasValidEmail = true
                // Only checked once the step already has real content — an empty step is
                // already flagged by invalid_email_content above and would trivially "miss" the
                // placeholder too, which would just be noise on top of the real problem.
                if (stepOrdersMissingUnsubscribe.has(step.stepOrder)) {
                    issues.push({
                        code: 'missing_unsubscribe_placeholder',
                        message: 'Email steps must render {{unsubscribeUrl}} in the sent body (CAN-SPAM compliance).',
                        stepId: step.id,
                    })
                }
            } else {
                issues.push({
                    code: 'invalid_email_content',
                    message: 'Email steps require a non-empty subject and plain-text or HTML body.',
                    stepId: step.id,
                })
            }
        } else if (step.type === 'condition') {
            issues.push({
                code: 'unsupported_condition_step',
                message: 'Condition steps cannot be activated until branching targets are supported.',
                stepId: step.id,
            })
        }

        if (seenOrders.has(step.stepOrder)) {
            issues.push({
                code: 'duplicate_step_order',
                message: `Sequence step order ${step.stepOrder} is duplicated.`,
                stepId: step.id,
            })
        }
        seenOrders.add(step.stepOrder)
    }

    if (!hasValidEmail) {
        issues.push({
            code: 'sequence_missing_email',
            message: 'Sequence requires at least one valid email step.',
        })
    }

    return issues
}
