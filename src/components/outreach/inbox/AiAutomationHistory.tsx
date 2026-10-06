import { History } from 'lucide-react'
import type { AiRunPublicDto } from '../../../lib/unified-inbox-api'
import { formatDateTime } from '../../../lib/inbox-relative-time'
import {
    RUN_ACTION_LABEL,
    RUN_KIND_LABEL,
    RUN_STATUS_LABEL,
    runOutcomeLabel,
    runOutcomeSummary,
    type RunTone,
} from './ai-run-labels'

// ============================================================
// AI automation causal history (Phase 23 AI-05 / AI-06)
// ============================================================
// A REDACTED, read-only ledger of what the AI did and why. Its ONLY input is the server's redacted
// public DTO (toPublicAiRun): a run's kind/status, prompt version + model LABEL, trigger message
// REFERENCE + time, the decision, the approval actor/time, the policy code, and the command/send
// outcome or failure code. It is structurally incapable of leaking a secret because the DTO carries
// none (locked #5).
//
// This is the ONLY place the history renders (at the end of the thread). Model, prompt version,
// trigger message id and approver id live under "Technical details", collapsed by default.

const TONE_CLASS: Record<RunTone, string> = {
    good: 'text-emerald-700 dark:text-emerald-400',
    bad: 'text-red-600 dark:text-red-400',
    warn: 'text-amber-700 dark:text-amber-400',
    muted: 'text-muted-foreground',
}

function statusTone(status: string): string {
    switch (status) {
        case 'completed':
            return TONE_CLASS.good
        case 'failed':
            return TONE_CLASS.bad
        case 'deferred':
            return TONE_CLASS.warn
        default:
            return 'text-foreground'
    }
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
                        const outcome = runOutcomeSummary(run)
                        const decision = runOutcomeLabel(run.outputOutcome)
                        const approved = run.approvedByUserId && run.approvedAt
                        const hasTechnical = Boolean(
                            run.promptVersion || run.model || run.triggerMessageId || run.approvedByUserId || run.errorCode || run.policyCode || run.outputOutcome,
                        )
                        return (
                            <li key={run.id} className="rounded border border-border bg-card/60 p-2 text-xs">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                                        {RUN_KIND_LABEL[run.runKind] ?? run.runKind}
                                    </span>
                                    <span className={`font-medium ${statusTone(run.status)}`}>
                                        {RUN_STATUS_LABEL[run.status] ?? run.status}
                                    </span>
                                    {run.action && (
                                        <span className="text-muted-foreground">· {RUN_ACTION_LABEL[run.action] ?? run.action}</span>
                                    )}
                                    {decision && <span className="text-muted-foreground">· {decision}</span>}
                                    <time dateTime={run.createdAt} className="ml-auto shrink-0 text-muted-foreground">
                                        {formatDateTime(run.createdAt)}
                                    </time>
                                </div>
                                {(outcome || approved) && (
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        {outcome && <span className={TONE_CLASS[outcome.tone]}>{outcome.label}</span>}
                                        {approved && (
                                            <span className="text-muted-foreground">
                                                {outcome ? '· ' : ''}Approved by a person on {formatDateTime(run.approvedAt as string)}
                                            </span>
                                        )}
                                    </div>
                                )}
                                {hasTechnical && (
                                    <details className="mt-1">
                                        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                                            Technical details
                                        </summary>
                                        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
                                            {run.promptVersion && (<><dt>Prompt version</dt><dd className="break-all text-foreground">{run.promptVersion}</dd></>)}
                                            {run.model && (<><dt>Model</dt><dd className="break-all text-foreground">{run.model}</dd></>)}
                                            {run.outputOutcome && (<><dt>Outcome</dt><dd className="break-all text-foreground">{run.outputOutcome}</dd></>)}
                                            {run.triggerMessageId && (<><dt>Trigger message</dt><dd className="break-all text-foreground">#{run.triggerMessageId.slice(0, 8)}</dd></>)}
                                            {run.approvedByUserId && (<><dt>Approved by</dt><dd className="break-all text-foreground">{run.approvedByUserId.slice(0, 8)}</dd></>)}
                                            {run.policyCode && (<><dt>Policy code</dt><dd className="break-all text-foreground">{run.policyCode}</dd></>)}
                                            {run.errorCode && (<><dt>Error code</dt><dd className="break-all text-foreground">{run.errorCode}</dd></>)}
                                        </dl>
                                    </details>
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
