import type { AiRunPublicDto, AiRunStatus } from '../../../lib/unified-inbox-api'
import { policyHint } from './policy-labels'

// ============================================================
// AI run labels in operator language
// ============================================================
// One label set for the draft assistant and the history, which used to disagree
// ("Queued/Generating/No reply suggested" vs "Working/Completed"). Technical codes (decider error,
// policy, outcome) become sentences; the raw code only appears under "Technical details".

export const RUN_STATUS_LABEL: Record<AiRunStatus, string> = {
    pending: 'Queued',
    running: 'In progress',
    awaiting_approval: 'Draft ready for review',
    completed: 'Completed',
    failed: 'Failed',
    deferred: 'On hold',
    cancelled: 'Cancelled',
}

export const RUN_ACTION_LABEL: Record<string, string> = {
    draft: 'Drafted a reply',
    wait: 'Chose to wait',
    complete: 'Marked as resolved',
    escalate: 'Handed off to a person',
    none: 'No action',
}

export const RUN_KIND_LABEL: Record<string, string> = {
    draft: 'Suggestion',
    autonomous: 'Automatic',
}

/** Recoverable assistant errors, as operator-facing sentences. */
export const RUN_ERROR_LABEL: Record<string, string> = {
    no_decider_configured: 'The draft assistant is not configured yet.',
    decider_timeout: 'The assistant timed out. You can try again.',
    decider_unreachable: 'The assistant could not be reached. You can try again.',
    decider_http_error: 'The assistant returned an error. You can try again.',
    decider_bad_response: 'The assistant returned an unusable response. You can try again.',
    unsafe_output: 'The assistant could not produce a safe draft. Please write your reply.',
    no_inbound_body: 'There is no message body to draft a reply from yet.',
    no_inbound_message: 'There is no reply to draft an answer to yet.',
}

/** Known outcomes the assistant records. Unknown ones only appear under technical details. */
export const RUN_OUTCOME_LABEL: Record<string, string> = {
    interested: 'Lead is interested',
    not_interested: 'Lead is not interested',
    needs_human: 'Needs a person',
    out_of_office: 'Out-of-office auto reply',
    unsubscribe: 'Asked to be removed',
    question: 'Lead asked a question',
}

export function runErrorLabel(code: string | null | undefined): string {
    if (!code) return 'Could not generate a draft. You can try again.'
    return RUN_ERROR_LABEL[code] ?? 'Could not generate a draft. You can try again.'
}

export function runOutcomeLabel(outcome: string | null | undefined): string | null {
    if (!outcome) return null
    return RUN_OUTCOME_LABEL[outcome] ?? null
}

export type RunTone = 'good' | 'bad' | 'warn' | 'muted'

/**
 * Describe the send outcome of a run WITHOUT leaking anything: an autonomous run that produced an
 * outreach email is "Sent"; a linked-but-unsent command is "Queued"; a policy stop shows the policy
 * sentence; a failure shows the error sentence.
 */
export function runOutcomeSummary(run: AiRunPublicDto): { label: string; tone: RunTone } | null {
    if (run.outreachEmailId) return { label: 'Sent through the policy gate', tone: 'good' }
    if (run.status === 'failed' && run.errorCode) {
        return { label: RUN_ERROR_LABEL[run.errorCode] ?? 'Failed with an unexpected error.', tone: 'bad' }
    }
    if (run.policyCode) return { label: policyHint(run.policyCode), tone: 'warn' }
    if (run.sendCommandId) return { label: 'Reply queued, not sent yet', tone: 'muted' }
    return null
}
