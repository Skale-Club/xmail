import type { SequenceStep } from '../../db/schema'

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

export function resolveSequenceAction(
    _steps: SequenceStep[],
    _currentStep: SequenceStep | null,
    now: Date,
    _schedule: SequenceSchedule,
): SequenceAction {
    return { type: 'complete', completedAt: now }
}

export function validateSequenceForActivation(_steps: SequenceStep[]): SequenceValidationIssue[] {
    return []
}
