import { History } from 'lucide-react'
import type { AiRunPublicDto } from '../../../lib/unified-inbox-api'

// ============================================================
// AI automation causal history (Phase 23 AI-05 / AI-06)
// ============================================================
// A REDACTED, read-only ledger of what the AI did and why. Its ONLY input is the server's redacted
// public DTO (toPublicAiRun): a run's kind/status, prompt version + model LABEL, trigger message
// REFERENCE + time, the decision, the approval actor/time, the policy code, and the command/send
// outcome or failure code. It is structurally incapable of leaking a secret because the DTO carries
// none — there is no system/hidden prompt, model parameters, credential, lease token, raw error
// detail, idempotency key, or cross-tenant body anywhere in its props (locked #5).

/** Human labels for each redacted run status. */
const RUN_STATUS_LABEL: Record<string, string> = {
    pending: 'Queued',
    running: 'Working',
    awaiting_approval: 'Draft ready',
    completed: 'Completed',
    failed: 'Failed',
    deferred: 'Held / deferred',
    cancelled: 'Cancelled',
}

/** Human labels for the redacted model decision (action). */
const RUN_ACTION_LABEL: Record<string, string> = {
    draft: 'Drafted a reply',
    wait: 'Chose to wait',
    complete: 'Marked complete',
    escalate: 'Escalated to a human',
    none: 'No action',
}

const KIND_LABEL: Record<string, string> = {
    draft: 'Suggestion',
    autonomous: 'Autonomous',
}

function statusTone(status: string): string {
    switch (status) {
        case 'completed':
            return 'text-emerald-700 dark:text-emerald-400'
        case 'failed':
            return 'text-red-600 dark:text-red-400'
        case 'deferred':
            return 'text-amber-700 dark:text-amber-400'
        default:
            return 'text-muted-foreground'
    }
}

/**
 * Describe the command/send outcome of a run WITHOUT leaking anything: an autonomous run that produced
 * an outreach email is "Sent"; a linked-but-unsent command is "Queued to send"; a policy stop shows the
 * policy code; a failure shows the coarse machine error code.
 */
function outcomeSummary(run: AiRunPublicDto): { label: string; tone: string } | null {
    if (run.outreachEmailId) return { label: 'Sent through the policy gate', tone: 'text-emerald-700 dark:text-emerald-400' }
    if (run.status === 'failed' && run.errorCode) return { label: `Failed: ${run.errorCode}`, tone: 'text-red-600 dark:text-red-400' }
    if (run.policyCode) return { label: `Policy: ${run.policyCode}`, tone: 'text-amber-700 dark:text-amber-400' }
    if (run.sendCommandId) return { label: 'Command queued (not yet sent)', tone: 'text-muted-foreground' }
    return null
}

export interface AiAutomationHistoryProps {
    runs: AiRunPublicDto[] | undefined
    /** Section heading. */
    title?: string
    /** Copy for the empty state. */
    emptyLabel?: string
    className?: string
}

export function AiAutomationHistory({
    runs,
    title = 'AI automation history',
    emptyLabel = 'No AI activity on this conversation yet.',
    className,
}: AiAutomationHistoryProps) {
    const items = runs ?? []
    return (
        <section aria-label={title} className={className}>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <History className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{title}</span>
            </div>
            {items.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">{emptyLabel}</p>
            ) : (
                <ul className="space-y-1.5">
                    {items.map((run) => {
                        const outcome = outcomeSummary(run)
                        const approved = run.approvedByUserId && run.approvedAt
                        return (
                            <li key={run.id} className="rounded border border-border bg-card/60 p-2 text-xs">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                                        {KIND_LABEL[run.runKind] ?? run.runKind}
                                    </span>
                                    <span className={`font-medium ${statusTone(run.status)}`}>
                                        {RUN_STATUS_LABEL[run.status] ?? run.status}
                                    </span>
                                    {run.action && (
                                        <span className="text-muted-foreground">· {RUN_ACTION_LABEL[run.action] ?? run.action}</span>
                                    )}
                                    <time dateTime={run.createdAt} className="ml-auto shrink-0 text-muted-foreground">
                                        {new Date(run.createdAt).toLocaleString()}
                                    </time>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem] text-muted-foreground">
                                    {run.promptVersion && <span title="Prompt version">{run.promptVersion}</span>}
                                    {run.model && <span title="Model">· {run.model}</span>}
                                    {run.outputOutcome && <span>· {run.outputOutcome}</span>}
                                    {run.triggerMessageId && (
                                        <span title="Triggering message reference">· trigger #{run.triggerMessageId.slice(0, 8)}</span>
                                    )}
                                </div>
                                {(outcome || approved) && (
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.7rem]">
                                        {outcome && <span className={outcome.tone}>{outcome.label}</span>}
                                        {approved && (
                                            <span className="text-muted-foreground">
                                                · Approved by {run.approvedByUserId!.slice(0, 8)}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}
        </section>
    )
}

export default AiAutomationHistory
