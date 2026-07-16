import type { CampaignLead, Lead, SequenceStep } from '../../db/schema'

export const CAMPAIGN_LEAD_PROGRESS = {
    new: { terminal: false },
    contacted: { terminal: false },
    replied: { terminal: true },
    interested: { terminal: true },
    not_interested: { terminal: true },
    bounced: { terminal: true },
    unsubscribed: { terminal: true },
} as const satisfies Record<Lead['status'], { terminal: boolean }>

export const TERMINAL_CAMPAIGN_LEAD_STATUSES = Object.freeze(
    (Object.entries(CAMPAIGN_LEAD_PROGRESS) as Array<[
        Lead['status'],
        (typeof CAMPAIGN_LEAD_PROGRESS)[Lead['status']],
    ]>)
        .filter(([, progress]) => progress.terminal)
        .map(([status]) => status),
)

const terminalCampaignLeadStatuses = new Set<Lead['status']>(TERMINAL_CAMPAIGN_LEAD_STATUSES)

export function isTerminalCampaignLeadStatus(status: Lead['status']): boolean {
    return terminalCampaignLeadStatuses.has(status)
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

export interface SequenceSchedule {
    timezone: string
    sendStartTime: string
    sendEndTime: string
    sendOnWeekends: boolean
}

export type SequenceQuarantineReason =
    | 'invalid_email_content'
    | 'unsupported_condition_step'
    | 'current_step_not_in_sequence'

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

export interface SequenceValidationIssue {
    code: SequenceValidationIssueCode
    message: string
    stepId?: string
}

interface ZonedDateParts {
    weekday: number
    hour: number
    minute: number
}

function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
    let parts: Intl.DateTimeFormatPart[]
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    } catch {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    }

    const value = (type: string) => parts.find((part) => part.type === type)?.value
    const weekdays: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    }

    return {
        weekday: weekdays[value('weekday') || 'Sun'] ?? 0,
        hour: Number(value('hour') || 0),
        minute: Number(value('minute') || 0),
    }
}

function parseTime(value: string): number {
    const [hours, minutes] = value.split(':').map(Number)
    return hours * 60 + (minutes || 0)
}

function isWithinSchedule(date: Date, schedule: SequenceSchedule): boolean {
    const zoned = getZonedDateParts(date, schedule.timezone)
    const isWeekend = zoned.weekday === 0 || zoned.weekday === 6
    if (isWeekend && !schedule.sendOnWeekends) return false

    const currentMinutes = zoned.hour * 60 + zoned.minute
    return currentMinutes >= parseTime(schedule.sendStartTime)
        && currentMinutes <= parseTime(schedule.sendEndTime)
}

function scheduleAfterDelay(now: Date, delayHours: number, schedule: SequenceSchedule): Date {
    const candidate = new Date(now.getTime() + Math.max(0, delayHours) * 60 * 60 * 1000)
    candidate.setUTCSeconds(0, 0)

    const maxMinutes = 14 * 24 * 60
    for (let minute = 0; minute <= maxMinutes; minute++) {
        if (isWithinSchedule(candidate, schedule)) return new Date(candidate)
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)
    }

    return candidate
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

        return {
            type: 'advance_without_send',
            fromStep: currentStep,
            nextStep,
            nextScheduledAt: scheduleAfterDelay(now, currentStep.delayHours, schedule),
        }
    }

    if (!isValidEmailStep(currentStep)) {
        return { type: 'quarantine', reason: 'invalid_email_content', step: currentStep }
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
        // Explicit delay rows own their wait. They become due immediately and,
        // when resolved, schedule the following row after their delayHours.
        nextScheduledAt: nextStep
            ? nextStep.type === 'email'
                ? scheduleAfterDelay(now, nextStep.delayHours, schedule)
                : new Date(now)
            : null,
    }
}

export function validateSequenceForActivation(steps: SequenceStep[]): SequenceValidationIssue[] {
    const issues: SequenceValidationIssue[] = []
    const seenOrders = new Set<number>()
    let hasValidEmail = false

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
