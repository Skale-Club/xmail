import React from 'react'
import { Link } from 'wouter'
import { AlertTriangle, Sparkles, X } from 'lucide-react'
import { Button } from '../../ui/button'
import {
    AI_SUGGESTION_TONE_GOALS,
    type AiSuggestionResponse,
    type AiSuggestionToneGoal,
} from '../../../lib/unified-inbox-api'
import { runErrorLabel, runOutcomeLabel } from './ai-run-labels'

// ============================================================
// AI draft assistant (Phase 23 AI-02 / AI-06)
// ============================================================
// A HUMAN-IN-THE-LOOP affordance rendered in the Phase 22 composer toolbar. It requests an editable
// draft from the persisted conversation, previews it, and, only on an explicit operator action,
// INSERTS the body into the composer's normal editable field. It NEVER sends and it NEVER mutates
// the recipient/account: sending remains the operator's separate composer action (locked #6).
//
// When draft assistance is disabled for the organization it renders a compact disabled state with
// the way to turn it on (it used to disappear, so nobody knew the feature existed). The preview
// shows ONLY the redacted, operator-facing draft: no system prompt, hidden reasoning, model
// parameters, or credential anywhere in its props or output (locked #5). Run history lives only at
// the end of the thread (AiAutomationHistory), not here.

const TONE_LABEL: Record<AiSuggestionToneGoal, string> = {
    neutral: 'Neutral',
    warm: 'Warm',
    concise: 'Concise',
    formal: 'Formal',
    friendly: 'Friendly',
}

const SETTINGS_HREF = '/outreach/settings'

export interface AiDraftAssistantProps {
    /** When false a compact disabled state with a link to Settings is shown. */
    enabled: boolean
    /** Request a draft. Resolves with the suggestion response; rejects on rate-limit/in-flight/etc. */
    onRequest: (toneGoal: AiSuggestionToneGoal | null) => Promise<AiSuggestionResponse>
    /** Insert the accepted draft body into the composer's editable field (never sends). */
    onInsert: (body: string, subject: string | null) => void
    /** Record the operator's explicit acceptance/approval against the run (audit only; never sends). */
    onAccept?: (runId: string) => void | Promise<void>
    toneGoals?: readonly AiSuggestionToneGoal[]
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
                setPhase({ kind: 'error', message: runErrorLabel(response.run.errorCode) })
            } else if (response.run) {
                setPhase({ kind: 'no_action', outcome: response.run.outputOutcome })
            } else {
                setPhase({ kind: 'idle' })
            }
        } catch (error) {
            if (token !== requestToken.current) return
            const code = (error as { code?: string; message?: string })?.code
            setPhase({ kind: 'error', message: code ? runErrorLabel(code) : ((error as Error)?.message || runErrorLabel(null)) })
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

    if (!enabled) {
        return (
            <p
                aria-label="AI draft assistant is off"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                    AI suggestions off{' — '}
                    <Link
                        href={SETTINGS_HREF}
                        className="font-medium text-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        enable in Settings
                    </Link>
                </span>
            </p>
        )
    }

    // Idle the assistant is one compact inline group inside the toolbar; every other phase takes the
    // full row so the preview has room.
    const compact = phase.kind === 'idle'

    return (
        <section
            aria-label="AI draft assistant"
            className={compact
                ? 'inline-flex flex-wrap items-center gap-1.5 text-xs'
                : 'w-full basis-full rounded border border-dashed border-border bg-muted/20 p-2 text-xs'}
        >
            {phase.kind === 'idle' && (
                <>
                    <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => void request()}>
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        Suggest draft
                    </Button>
                    <label className="flex items-center gap-1 text-muted-foreground">
                        <span className="sr-only">Tone</span>
                        <select
                            aria-label="Draft tone"
                            value={tone}
                            onChange={(e) => setTone(e.target.value as AiSuggestionToneGoal | '')}
                            className="h-8 rounded-md border border-border bg-background px-1.5 text-xs"
                        >
                            <option value="">Default tone</option>
                            {toneGoals.map((t) => (
                                <option key={t} value={t}>{TONE_LABEL[t] ?? t}</option>
                            ))}
                        </select>
                    </label>
                </>
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
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    {phase.subject && (
                        <p className="truncate text-muted-foreground"><span className="font-medium">Suggested subject:</span> {phase.subject}</p>
                    )}
                    <div
                        aria-label="AI draft preview"
                        className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-background p-2"
                    >
                        {phase.body}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" onClick={insert}>Insert into reply</Button>
                        <Button type="button" size="sm" variant="ghost" onClick={discard}>Discard</Button>
                        <span className="text-xs italic text-muted-foreground">Review and edit before sending. Inserting does not send.</span>
                    </div>
                </div>
            )}

            {phase.kind === 'no_action' && (
                <div className="flex items-center gap-2" aria-live="polite">
                    <span className="text-muted-foreground">
                        The assistant did not suggest a reply{runOutcomeLabel(phase.outcome) ? ` (${runOutcomeLabel(phase.outcome)})` : ''}.
                    </span>
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
        </section>
    )
}

export default AiDraftAssistant
