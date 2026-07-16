import React from 'react'
import { AlertTriangle, Clock, Paperclip, Send, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { formatBytes } from '../../../lib/utils'
import type {
    CreateSendCommandInput,
    InboxAccountOption,
    InboxSendCommand,
    InboxSendMode,
    InboxSnippet,
    InboxUploadedAttachment,
} from '../../../lib/unified-inbox-api'

// ============================================================
// Conversation composer (Phase 22 UIX-03 / UIX-05)
// ============================================================
// Replies are NEVER sent from React (locked #5). This composer POSTs a DURABLE send command;
// the server resolves recipients + RFC threading headers from the persisted thread and the
// long-running claimer dispatches it through the shared delivery-policy gate. The To/Cc/subject
// shown here are a client-side PREVIEW only — the server remains authoritative.
//
// Draft safety: the body is preserved on any failure or policy denial; nothing is auto-sent or
// silently rescheduled unless the operator chose scheduling. One idempotency key per user intent
// makes a duplicate click return the same command.

/** Human labels for the durable command lifecycle the operator can see in the thread. */
const STATUS_LABEL: Record<string, string> = {
    draft: 'Draft',
    scheduled: 'Scheduled',
    queued: 'Queued',
    sending: 'Sending',
    sent: 'Sent',
    failed: 'Failed',
    cancelled: 'Cancelled',
    held: 'Needs review',
}

// A readable next-step for each recoverable delivery-policy denial code.
const POLICY_HINTS: Record<string, string> = {
    organization_disabled: 'Outreach is paused for this organization. It will send when re-enabled.',
    campaign_inactive: 'The linked campaign is not active.',
    account_not_verified: 'The sending account is not verified.',
    account_cross_organization: 'That account belongs to another organization.',
    recipient_suppressed: 'The recipient is on the suppression list.',
    lead_unsubscribed: 'The recipient has unsubscribed.',
    outside_send_window: 'Outside the account send window — it will send in-window.',
    daily_limit_exhausted: 'The account hit its daily limit — it will resume tomorrow.',
    warmup_limit_exhausted: 'The account is warming up — it will resume as warm-up allows.',
    account_spacing: 'Waiting for the minimum spacing between sends.',
}

function policyHint(code: string | null): string {
    if (!code) return ''
    return POLICY_HINTS[code] ?? `Delivery is paused (${code}).`
}

export interface ConversationComposerProps {
    /** Policy-eligible sending accounts; the resolved account is the conversation's own by default. */
    accounts: InboxAccountOption[]
    defaultAccountId: string
    /** DISPLAY-ONLY preview of the server-resolved recipients (server re-derives on send). */
    replyToPreview: string[]
    replyAllCcPreview: string[]
    /** DISPLAY-ONLY resolved subject preview. */
    subjectPreview: string
    snippets: InboxSnippet[]
    organizationTimezone?: string
    /** Create the durable command. Returns the persisted command (never sends inline). */
    onSend: (input: CreateSendCommandInput) => Promise<InboxSendCommand>
    /** Upload one bounded attachment (raw bytes; server-validated). */
    onUploadAttachment: (file: File) => Promise<InboxUploadedAttachment>
    onRemoveAttachment?: (attachmentId: string) => Promise<void> | void
    /** Cancel a still-cancellable command (scheduled/queued). */
    onCancelCommand?: (commandId: string) => void
    /** Latest polled state of the active command, pushed by the parent (status/denial reconcile). */
    polledCommand?: InboxSendCommand | null
    /**
     * Optional AI draft assistant, rendered inside the open editor. It is handed an `insertDraft`
     * callback that copies a suggested body into the normal editable field (preserving the
     * operator's text behind an explicit replace confirmation). The assistant NEVER sends — the
     * subsequent send is still the operator's Phase 22 action below.
     */
    renderAiAssistant?: (insertDraft: (body: string, subject?: string | null) => void) => React.ReactNode
}

type Mode = InboxSendMode | null

function makeIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `inbox-ui:${crypto.randomUUID()}`
    return `inbox-ui:${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function parseRecipients(raw: string): { address: string; name: string | null }[] {
    return raw
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((address) => ({ address, name: null }))
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ConversationComposer({
    accounts,
    defaultAccountId,
    replyToPreview,
    replyAllCcPreview,
    subjectPreview,
    snippets,
    organizationTimezone,
    onSend,
    onUploadAttachment,
    onRemoveAttachment,
    onCancelCommand,
    polledCommand,
    renderAiAssistant,
}: ConversationComposerProps) {
    const [mode, setMode] = React.useState<Mode>(null)
    const [accountId, setAccountId] = React.useState(defaultAccountId)
    const [body, setBody] = React.useState('')
    const [pendingDraft, setPendingDraft] = React.useState<string | null>(null)
    const [forwardTo, setForwardTo] = React.useState('')
    const [attachments, setAttachments] = React.useState<InboxUploadedAttachment[]>([])
    const [uploadError, setUploadError] = React.useState<string | null>(null)
    const [uploading, setUploading] = React.useState(false)
    const [scheduleEnabled, setScheduleEnabled] = React.useState(false)
    const [scheduledAt, setScheduledAt] = React.useState('')
    const [submitting, setSubmitting] = React.useState(false)
    const [sendError, setSendError] = React.useState<string | null>(null)
    const [confirmDiscard, setConfirmDiscard] = React.useState(false)
    const [command, setCommand] = React.useState<InboxSendCommand | null>(null)
    const idempotencyKeyRef = React.useRef<string>('')

    React.useEffect(() => { setAccountId(defaultAccountId) }, [defaultAccountId])

    // The parent polls the command; reconcile its latest status (e.g. scheduled -> queued -> sent,
    // or a policy denial code) into what the operator sees, without stealing focus.
    const active = polledCommand && command && polledCommand.id === command.id ? polledCommand : command
    const timezone = organizationTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone

    const openEditor = React.useCallback((next: InboxSendMode) => {
        setMode(next)
        idempotencyKeyRef.current = makeIdempotencyKey()
        setSendError(null)
    }, [])

    const resetDraft = React.useCallback(() => {
        setBody('')
        setForwardTo('')
        setAttachments([])
        setUploadError(null)
        setSendError(null)
        setScheduleEnabled(false)
        setScheduledAt('')
        setConfirmDiscard(false)
        setPendingDraft(null)
        setCommand(null)
        setMode(null)
    }, [])

    // Copy an AI-suggested body into the editable field. If the operator has already typed a
    // different draft, ask before replacing it — their text is never silently overwritten.
    const insertDraft = React.useCallback((draftBody: string) => {
        setBody((prev) => {
            if (prev.trim().length > 0 && prev !== draftBody) {
                setPendingDraft(draftBody)
                return prev
            }
            return draftBody
        })
    }, [])

    const confirmReplaceDraft = React.useCallback(() => {
        setPendingDraft((draft) => {
            if (draft !== null) setBody(draft)
            return null
        })
    }, [])

    const requestClose = React.useCallback(() => {
        // Escape/Cancel must not silently drop unsaved content.
        const dirty = body.trim().length > 0 || attachments.length > 0 || forwardTo.trim().length > 0
        if (dirty && !command) setConfirmDiscard(true)
        else resetDraft()
    }, [body, attachments.length, forwardTo, command, resetDraft])

    const insertSnippet = React.useCallback((snippet: InboxSnippet) => {
        setBody((prev) => (prev ? `${prev}\n${snippet.body}` : snippet.body))
    }, [])

    const onFilePicked = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = '' // allow re-selecting the same file after a failure
        if (!file) return
        setUploadError(null)
        setUploading(true)
        try {
            const uploaded = await onUploadAttachment(file)
            setAttachments((prev) => [...prev, uploaded])
        } catch (error) {
            setUploadError(error instanceof Error ? error.message : 'Attachment upload failed')
        } finally {
            setUploading(false)
        }
    }, [onUploadAttachment])

    const removeAttachment = React.useCallback(async (attachmentId: string) => {
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
        try {
            await onRemoveAttachment?.(attachmentId)
        } catch {
            /* best-effort; the row is a lifecycle-cleaned orphan if this fails */
        }
    }, [onRemoveAttachment])

    const forwardRecipients = React.useMemo(() => parseRecipients(forwardTo), [forwardTo])
    const forwardInvalid = mode === 'forward'
        && (forwardRecipients.length === 0 || forwardRecipients.some((r) => !EMAIL_RE.test(r.address)))

    const canSubmit = mode !== null
        && !submitting
        && (mode !== 'forward' || !forwardInvalid)
        && (!scheduleEnabled || scheduledAt.length > 0)

    const submit = React.useCallback(async () => {
        if (mode === null || submitting) return
        if (scheduleEnabled && !scheduledAt) { setSendError('Choose a date and time to schedule this reply.'); return }
        if (mode === 'forward' && forwardInvalid) { setSendError('Enter at least one valid forward recipient.'); return }
        setSubmitting(true)
        setSendError(null)
        try {
            const input: CreateSendCommandInput = {
                emailAccountId: accountId,
                mode,
                bodyText: body,
                attachmentIds: attachments.map((a) => a.id),
                scheduledAt: scheduleEnabled && scheduledAt ? new Date(scheduledAt).toISOString() : null,
                idempotencyKey: idempotencyKeyRef.current || makeIdempotencyKey(),
                ...(mode === 'forward' ? { forwardTo: forwardRecipients } : {}),
            }
            const created = await onSend(input)
            setCommand(created)
        } catch (error) {
            // Draft is preserved: the body/attachments/mode all remain. Surface a specific reason.
            setSendError(error instanceof Error ? error.message : 'Could not create the reply. Your draft is safe.')
        } finally {
            setSubmitting(false)
        }
    }, [mode, submitting, scheduleEnabled, scheduledAt, forwardInvalid, accountId, body, attachments, forwardRecipients, onSend])

    if (mode === null) {
        return (
            <div className="flex flex-wrap gap-2 border-t border-border p-3">
                <Button size="sm" onClick={() => openEditor('reply')}>Reply</Button>
                <Button size="sm" variant="outline" onClick={() => openEditor('reply_all')}>Reply all</Button>
                <Button size="sm" variant="outline" onClick={() => openEditor('forward')}>Forward</Button>
            </div>
        )
    }

    const primaryLabel = scheduleEnabled ? 'Schedule reply' : (mode === 'forward' ? 'Send forward' : 'Send reply')
    const showDenial = active?.status === 'scheduled' && !!active.lastPolicyCode

    return (
        <form
            className="flex flex-col gap-2 border-t border-border p-3"
            aria-label="Reply composer"
            onSubmit={(e) => { e.preventDefault(); void submit() }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); requestClose() } }}
        >
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {mode === 'reply' ? 'Reply' : mode === 'reply_all' ? 'Reply all' : 'Forward'}
                </span>
                <button type="button" onClick={requestClose} aria-label="Close composer" className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <X className="h-4 w-4" />
                </button>
            </div>

            {/* From account (policy-eligible only). */}
            <label className="flex items-center gap-2 text-xs">
                <span className="w-14 shrink-0 text-muted-foreground">From</span>
                <select
                    aria-label="From account"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                >
                    {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.email}</option>
                    ))}
                </select>
            </label>

            {/* Recipients: resolved preview for reply modes; editable for forward. */}
            {mode === 'forward' ? (
                <label className="flex items-start gap-2 text-xs">
                    <span className="w-14 shrink-0 pt-1.5 text-muted-foreground">To</span>
                    <input
                        aria-label="Forward recipients"
                        value={forwardTo}
                        onChange={(e) => setForwardTo(e.target.value)}
                        placeholder="name@example.com, other@example.com"
                        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                    />
                </label>
            ) : (
                <div className="text-xs text-muted-foreground">
                    <p className="truncate"><span className="font-medium">To:</span> {replyToPreview.join(', ') || '—'}</p>
                    {mode === 'reply_all' && replyAllCcPreview.length > 0 && (
                        <p className="truncate"><span className="font-medium">Cc:</span> {replyAllCcPreview.join(', ')}</p>
                    )}
                    <p className="mt-0.5 text-[0.7rem] italic">Recipients and threading are resolved by the server.</p>
                </div>
            )}

            <p className="truncate text-xs text-muted-foreground"><span className="font-medium">Subject:</span> {subjectPreview || '(no subject)'}</p>

            {/* AI draft assistant (optional). It can only insert into the body below — never send. */}
            {renderAiAssistant?.(insertDraft)}

            {/* Replace-draft confirmation: an inserted suggestion never overwrites typed text silently. */}
            {pendingDraft !== null && (
                <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950/40" role="alertdialog" aria-label="Replace your draft?">
                    <p className="mb-1 font-medium">Replace your current draft with the suggestion?</p>
                    <div className="flex gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setPendingDraft(null)}>Keep mine</Button>
                        <Button type="button" size="sm" onClick={confirmReplaceDraft}>Replace</Button>
                    </div>
                </div>
            )}

            <textarea
                aria-label="Reply body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                className="w-full resize-y rounded border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Write your reply…"
            />

            {/* Snippets. */}
            {snippets.length > 0 && (
                <label className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Snippet</span>
                    <select
                        aria-label="Insert snippet"
                        value=""
                        onChange={(e) => {
                            const snippet = snippets.find((s) => s.id === e.target.value)
                            if (snippet) insertSnippet(snippet)
                            e.target.value = ''
                        }}
                        className="rounded border border-border bg-background px-2 py-1 text-sm"
                    >
                        <option value="">Insert a snippet…</option>
                        {snippets.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </label>
            )}

            {/* Attachments. */}
            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                        Attach file
                        <input type="file" className="sr-only" aria-label="Attach file" onChange={onFilePicked} disabled={uploading} />
                    </label>
                    {uploading && <span className="text-xs text-muted-foreground" role="status">Uploading…</span>}
                </div>
                {uploadError && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>
                )}
                {attachments.length > 0 && (
                    <ul className="space-y-1">
                        {attachments.map((a) => (
                            <li key={a.id} className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-xs">
                                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                                <span className="shrink-0 text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
                                <button type="button" onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.filename}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Schedule. */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.target.checked)} />
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    Schedule for later
                </label>
                {scheduleEnabled && (
                    <>
                        <input
                            type="datetime-local"
                            aria-label="Scheduled time"
                            value={scheduledAt}
                            onChange={(e) => setScheduledAt(e.target.value)}
                            className="rounded border border-border bg-background px-2 py-1 text-sm"
                        />
                        <span className="text-muted-foreground">{timezone}</span>
                    </>
                )}
            </div>

            {/* Command state + recoverable denial reason. Body is never cleared automatically. */}
            {active && (
                <div className="rounded border border-border bg-muted/30 px-2 py-1.5 text-xs" aria-live="polite">
                    <span className="font-medium">{STATUS_LABEL[active.status] ?? active.status}</span>
                    {showDenial && <span className="ml-1 text-amber-700 dark:text-amber-400">— {policyHint(active.lastPolicyCode)}</span>}
                    {active.status === 'failed' && active.lastError && <span className="ml-1 text-red-600 dark:text-red-400">— {active.lastError}</span>}
                    {(active.status === 'scheduled' || active.status === 'queued') && onCancelCommand && (
                        <button type="button" onClick={() => onCancelCommand(active.id)} className="ml-2 underline hover:no-underline">Cancel send</button>
                    )}
                </div>
            )}

            {sendError && (
                <p role="alert" className="flex items-start gap-1 text-xs text-red-600 dark:text-red-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {sendError}
                </p>
            )}

            <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={requestClose}>Cancel</Button>
                <Button type="submit" size="sm" disabled={!canSubmit}>
                    <Send className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {submitting ? 'Sending…' : primaryLabel}
                </Button>
            </div>

            {/* Unsaved-exit confirmation (never destroys a draft on a stray Escape/Cancel). */}
            {confirmDiscard && (
                <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950/40" role="alertdialog" aria-label="Discard draft?">
                    <p className="mb-1 font-medium">Discard this draft?</p>
                    <div className="flex gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
                        <Button type="button" size="sm" variant="destructive" onClick={resetDraft}>Discard</Button>
                    </div>
                </div>
            )}
        </form>
    )
}

export default ConversationComposer
