import React from 'react'
import { AlertTriangle, Sparkles, X } from 'lucide-react'
import { Button } from '../../ui/button'
import {
    AI_SUGGESTION_TONE_GOALS,
    type AiRunPublicDto,
    type AiSuggestionResponse,
    type AiSuggestionToneGoal,
} from '../../../lib/unified-inbox-api'

// ============================================================
// AI draft assistant (Phase 23 AI-02 / AI-06)
// ============================================================
// A HUMAN-IN-THE-LOOP affordance rendered INSIDE the Phase 22 composer. It requests an editable draft
// from the persisted conversation, previews it, and — only on an explicit operator action — INSERTS
// the body into the composer's normal editable field. It NEVER sends and it NEVER mutates the
// recipient/account: sending remains the operator's separate composer action (locked #6).
//
// It renders nothing at all unless draft assistance is enabled for the organization. The preview
// shows ONLY the redacted, operator-facing draft — there is no system prompt, hidden reasoning,
// model parameters, or credential anywhere in its props or output (locked #5).

/** Human labels for the redacted run statuses shown in the compact history. */
const RUN_STATUS_LABEL: Record<string, string> = {
    pending: 'Queued',
    running: 'Generating',
    awaiting_approval: 'Draft ready',
    completed: 'No reply suggested',
    failed: 'Failed',
    deferred: 'Deferred',
    cancelled: 'Cancelled',
}

// A readable next-step for each recoverable fail-closed suggestion error code.
const ERROR_HINTS: Record<string, string> = {
    no_decider_configured: 'The draft assistant is not configured yet.',
    decider_timeout: 'The assistant timed out. You can try again.',
    decider_unreachable: 'The assistant could not be reached. You can try again.',
    decider_http_error: 'The assistant returned an error. You can try again.',
    decider_bad_response: 'The assistant returned an unusable response. You can try again.',
    unsafe_output: 'The assistant could not produce a safe draft. Please write your reply.',
    no_inbound_body: 'There is no message body to draft a reply from yet.',
    no_inbound_message: 'There is no reply to draft an answer to yet.',
}

function errorHint(code: string | null | undefined): string {
    if (!code) return 'Could not generate a draft. You can try again.'
    return ERROR_HINTS[code] ?? `Could not generate a draft (${code}). You can try again.`
}

export interface AiDraftAssistantProps {
    /** When false the assistant renders nothing (the affordance is hidden entirely). */
    enabled: boolean
    /** Request a draft. Resolves with the suggestion response; rejects on rate-limit/in-flight/etc. */
    onRequest: (toneGoal: AiSuggestionToneGoal | null) => Promise<AiSuggestionResponse>
    /** Insert the accepted draft body into the composer's editable field (never sends). */
    onInsert: (body: string, subject: string | null) => void
    /** Record the operator's explicit acceptance/approval against the run (audit only; never sends). */
    onAccept?: (runId: string) => void | Promise<void>
    toneGoals?: readonly AiSuggestionToneGoal[]
    /** Compact, redacted run history (most-recent first). */
    history?: AiRunPublicDto[]
}

type Phase =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'preview'; runId: string; subject: string | null; body: string }
    | { kind: 'no_action'; outcome: string | null }
    | { kind: 'error'; message: string }

export function AiDraftAssistant({
    enabled,
    onRequest,
    onInsert,
    onAccept,
    toneGoals = AI_SUGGESTION_TONE_GOALS,
    history = [],
}: AiDraftAssistantProps) {
    const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' })
    const [tone, setTone] = React.useState<AiSuggestionToneGoal | ''>('')
    // A monotonically increasing token so a cancelled/superseded request cannot resolve into the UI.
    const requestToken = React.useRef(0)

    const request = React.useCallback(async () => {
        const token = ++requestToken.current
        setPhase({ kind: 'loading' })
        try {
            const response = await onRequest(tone === '' ? null : tone)
            if (token !== requestToken.current) return // cancelled / superseded
            if (response.suggestion) {
                setPhase({ kind: 'preview', runId: response.suggestion.runId, subject: response.suggestion.subject, body: response.suggestion.body })
            } else if (response.run && response.run.status === 'failed') {
                setPhase({ kind: 'error', message: errorHint(response.run.errorCode) })
            } else if (response.run) {
                setPhase({ kind: 'no_action', outcome: response.run.outputOutcome })
            } else {
                setPhase({ kind: 'idle' })
            }
        } catch (error) {
            if (token !== requestToken.current) return
            const code = (error as { code?: string; message?: string })?.code
            setPhase({ kind: 'error', message: code ? errorHint(code) : ((error as Error)?.message || errorHint(null)) })
        }
    }, [onRequest, tone])

    const cancel = React.useCallback(() => {
        // Abandon the in-flight UI wait (the run continues + is auditable server-side).
        requestToken.current += 1
        setPhase({ kind: 'idle' })
    }, [])

    const insert = React.useCallback(() => {
        if (phase.kind !== 'preview') return
        onInsert(phase.body, phase.subject)
        void onAccept?.(phase.runId)
        setPhase({ kind: 'idle' })
    }, [phase, onInsert, onAccept])

    const discard = React.useCallback(() => setPhase({ kind: 'idle' }), [])

    if (!enabled) return null

    return (
        <section
            aria-label="AI draft assistant"
            className="rounded border border-dashed border-border bg-muted/20 p-2 text-xs"
        >
            {phase.kind === 'idle' && (
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => void request()}>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Suggest draft
                    </Button>
                    <label className="flex items-center gap-1 text-muted-foreground">
                        <span className="sr-only">Tone</span>
                        <select
                            aria-label="Draft tone"
                            value={tone}
                            onChange={(e) => setTone(e.target.value as AiSuggestionToneGoal | '')}
                            className="rounded border border-border bg-background px-1.5 py-1"
                        >
                            <option value="">Default tone</option>
                            {toneGoals.map((t) => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                    </label>
                    <span className="text-[0.7rem] italic text-muted-foreground">The assistant drafts a reply for you to edit — it never sends.</span>
                </div>
            )}

            {phase.kind === 'loading' && (
                <div className="flex items-center gap-2" role="status" aria-live="polite">
                    <Sparkles className="h-3.5 w-3.5 animate-pulse text-muted-foreground" aria-hidden="true" />
                    <span>Generating a draft…</span>
                    <button type="button" onClick={cancel} className="ml-1 underline hover:no-underline">Cancel</button>
                </div>
            )}

            {phase.kind === 'preview' && (
                <div className="flex flex-col gap-2" aria-live="polite">
                    <div className="flex items-center justify-between">
                        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Suggested draft</span>
                        <button type="button" onClick={discard} aria-label="Discard suggestion" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    {phase.subject && (
                        <p className="truncate text-muted-foreground"><span className="font-medium">Suggested subject:</span> {phase.subject}</p>
                    )}
                    <div
                        aria-label="AI draft preview"
                        className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-background p-2"
                    >
                        {phase.body}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button type="button" size="sm" onClick={insert}>Insert into reply</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={discard}>Discard</Button>
                    </div>
                    <p className="text-[0.7rem] italic text-muted-foreground">Review and edit before sending. Inserting does not send.</p>
                </div>
            )}

            {phase.kind === 'no_action' && (
                <div className="flex items-center gap-2" aria-live="polite">
                    <span className="text-muted-foreground">The assistant did not suggest a reply{phase.outcome ? ` (${phase.outcome})` : ''}.</span>
                    <button type="button" onClick={discard} className="underline hover:no-underline">Dismiss</button>
                </div>
            )}

            {phase.kind === 'error' && (
                <div className="flex flex-col gap-1">
                    <p role="alert" className="flex items-start gap-1 text-red-600 dark:text-red-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {phase.message}
                    </p>
                    <div>
                        <Button type="button" size="sm" variant="outline" onClick={() => void request()}>Try again</Button>
                    </div>
                </div>
            )}

            {history.length > 0 && phase.kind === 'idle' && (
                <ul className="mt-2 space-y-0.5 border-t border-border pt-1.5 text-[0.7rem] text-muted-foreground">
                    {history.slice(0, 3).map((run) => (
                        <li key={run.id} className="flex items-center justify-between gap-2">
                            <span>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
                            <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

export default AiDraftAssistant
