import React from 'react'
import { AlertTriangle, Clock, Forward, Paperclip, Reply, ReplyAll, Send, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { cn, formatBytes } from '../../../lib/utils'
import type {
    CreateSendCommandInput,
    InboxAccountOption,
    InboxSendCommand,
    InboxSendMode,
    InboxSnippet,
    InboxUploadedAttachment,
} from '../../../lib/unified-inbox-api'
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './composer-draft'
import { policyHint } from './policy-labels'

// ============================================================
// Conversation composer (Phase 22 UIX-03 / UIX-05)
// ============================================================
// Replies are NEVER sent from React (locked #5). This composer POSTs a DURABLE send command; the
// server resolves recipients + RFC threading headers from the persisted thread and the long-running
// claimer dispatches it through the shared delivery-policy gate. The To/Cc/subject shown here are a
// client-side PREVIEW only; the server remains authoritative. A reply always leaves from the
// conversation's own account (the server rejects any other), so there is no From selector.
//
// Draft safety: the body is preserved on any failure or policy denial; nothing is auto-sent or
// silently rescheduled unless the operator chose scheduling. One idempotency key per distinct
// attempt makes a duplicate click return the same command, while an edited resend gets a fresh key.
// The typed text is also persisted per conversation in localStorage and restored on reopen.

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

const MODE_LABEL: Record<InboxSendMode, string> = {
    reply: 'Reply',
    reply_all: 'Reply all',
    forward: 'Forward',
}

/** Max textarea height before it scrolls internally (px). */
const BODY_MAX_HEIGHT = 192

export interface ComposerOpenRequest {
    mode: InboxSendMode
    /** Changes on every request so the same mode can be requested again (shortcuts r / a / f). */
    nonce: number
}

export interface ConversationComposerProps {
    /** Policy-eligible sending accounts; the conversation's own account is the one used. */
    accounts: InboxAccountOption[]
    defaultAccountId: string
    /** Conversation id: enables draft persistence in localStorage. */
    conversationId?: string
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
     * Optional AI draft assistant, rendered in the toolbar. It is handed an `insertDraft` callback
     * that copies a suggested body into the normal editable field (preserving the operator's text
     * behind an explicit replace confirmation). The assistant NEVER sends.
     */
    renderAiAssistant?: (insertDraft: (body: string, subject?: string | null) => void) => React.ReactNode
    /** External request to open the editor (keyboard shortcuts). Only NEW requests take effect. */
    openRequest?: ComposerOpenRequest | null
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

const TOOL_BTN =
    'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

/**
 * Explanation rendered in place of the composer when replying is not possible from this screen.
 * The composer used to vanish silently and the operator never knew why.
 */
export function ComposerUnavailable({ reason }: { reason: 'no_accounts' | 'loading' }) {
    if (reason === 'loading') {
        return (
            <div className="border-t border-border p-3 text-xs text-muted-foreground" role="status">
                Loading sending accounts…
            </div>
        )
    }
    return (
        <div className="flex items-start gap-2 border-t border-border bg-muted/30 p-3 text-xs text-foreground" role="status">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <p>
                You cannot reply from here because no sending account is available in this organization.
                Replies always leave from the account that received the conversation. Check Sending accounts.
            </p>
        </div>
    )
}

export function ConversationComposer({
    accounts,
    defaultAccountId,
    conversationId,
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
    openRequest,
}: ConversationComposerProps) {
    // Read once on mount: the composer is remounted per conversation (key in the parent).
    const [initialDraft] = React.useState(() => readComposerDraft(conversationId))
    const [mode, setMode] = React.useState<Mode>(initialDraft?.mode ?? null)
    const [body, setBody] = React.useState(initialDraft?.body ?? '')
    const [pendingDraft, setPendingDraft] = React.useState<string | null>(null)
    const [forwardTo, setForwardTo] = React.useState(initialDraft?.forwardTo ?? '')
    const [attachments, setAttachments] = React.useState<InboxUploadedAttachment[]>([])
    const [uploadError, setUploadError] = React.useState<string | null>(null)
    const [uploading, setUploading] = React.useState(false)
    const [scheduleEnabled, setScheduleEnabled] = React.useState(false)
    const [scheduledAt, setScheduledAt] = React.useState('')
    const [submitting, setSubmitting] = React.useState(false)
    const [sendError, setSendError] = React.useState<string | null>(null)
    const [confirmDiscard, setConfirmDiscard] = React.useState(false)
    const [command, setCommand] = React.useState<InboxSendCommand | null>(null)
    const [sentSnapshot, setSentSnapshot] = React.useState<{ mode: InboxSendMode; body: string; forwardTo: string } | null>(null)
    const [draftSavedAt, setDraftSavedAt] = React.useState<number | null>(initialDraft?.savedAt ?? null)

    // One key per distinct ATTEMPT: identical content reuses the key (double click, retry after a
    // network error); any edit, or a new send after a success, gets a fresh key so an edited resend
    // is never deduplicated into the old command.
    const attemptRef = React.useRef<{ fingerprint: string; key: string } | null>(null)
    const bodyRef = React.useRef<HTMLTextAreaElement | null>(null)
    const forwardRef = React.useRef<HTMLInputElement | null>(null)
    const focusOnOpenRef = React.useRef(false)
    const lastNonceRef = React.useRef<number | null>(openRequest?.nonce ?? null)

    // The account is always the conversation's own; the email is display-only.
    const accountId = defaultAccountId
    const accountEmail = accounts.find((a) => a.id === accountId)?.email ?? null

    // The parent polls the command; reconcile its latest status (e.g. scheduled -> queued -> sent,
    // or a policy denial code) into what the operator sees, without stealing focus.
    const active = polledCommand && command && polledCommand.id === command.id ? polledCommand : command
    const timezone = organizationTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone

    const openEditor = React.useCallback((next: InboxSendMode) => {
        focusOnOpenRef.current = true
        setMode(next)
        setSendError(null)
    }, [])

    // Focus the right field when the operator opens the editor by an action (never when a stored
    // draft is restored on mount, so it does not compete with the thread heading focus).
    React.useEffect(() => {
        if (mode === null || !focusOnOpenRef.current) return
        focusOnOpenRef.current = false
        const target = mode === 'forward' ? forwardRef.current : bodyRef.current
        target?.focus()
    }, [mode])

    React.useEffect(() => {
        if (!openRequest || openRequest.nonce === lastNonceRef.current) return
        lastNonceRef.current = openRequest.nonce
        if (mode === null) {
            openEditor(openRequest.mode)
        } else {
            if (mode !== openRequest.mode) setMode(openRequest.mode)
            const target = openRequest.mode === 'forward' ? forwardRef.current : bodyRef.current
            target?.focus()
        }
    }, [openRequest, mode, openEditor])

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
        setMode(null)
        setDraftSavedAt(null)
        attemptRef.current = null
        clearComposerDraft(conversationId)
    }, [conversationId])

    // --- Draft persistence (short debounce + flush on unmount) ---
    const latestRef = React.useRef({ mode, body, forwardTo })
    latestRef.current = { mode, body, forwardTo }

    React.useEffect(() => {
        if (!conversationId || mode === null) return
        const empty = body.trim().length === 0 && forwardTo.trim().length === 0
        const timer = setTimeout(() => {
            if (empty) {
                clearComposerDraft(conversationId)
                setDraftSavedAt(null)
            } else {
                const savedAt = writeComposerDraft(conversationId, { mode, body, forwardTo })
                if (savedAt) setDraftSavedAt(savedAt)
            }
        }, 500)
        return () => clearTimeout(timer)
    }, [conversationId, mode, body, forwardTo])

    React.useEffect(() => () => {
        // Switching conversation before the debounce fires must not lose what was just typed.
        const latest = latestRef.current
        if (!conversationId || latest.mode === null) return
        if (latest.body.trim().length === 0 && latest.forwardTo.trim().length === 0) return
        writeComposerDraft(conversationId, { mode: latest.mode, body: latest.body, forwardTo: latest.forwardTo })
    }, [conversationId])

    // Textarea starts small and grows up to a cap, then scrolls internally.
    React.useLayoutEffect(() => {
        const el = bodyRef.current
        if (!el) return
        el.style.height = 'auto'
        if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, BODY_MAX_HEIGHT)}px`
    }, [body, mode])

    // Copy an AI-suggested body into the editable field. If the operator has already typed a
    // different draft, ask before replacing it: their text is never silently overwritten.
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
        if (dirty) setConfirmDiscard(true)
        else resetDraft()
    }, [body, attachments.length, forwardTo, resetDraft])

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
    const bodyEmpty = body.trim().length === 0

    // A reply needs text; a forward may go without a note (the content is the original message).
    const canSubmit = mode !== null
        && !submitting
        && (mode === 'forward' ? !forwardInvalid : !bodyEmpty)
        && (!scheduleEnabled || scheduledAt.length > 0)

    const submit = React.useCallback(async () => {
        if (mode === null || submitting) return
        if (mode !== 'forward' && bodyEmpty) { setSendError('Write your reply before sending.'); return }
        if (scheduleEnabled && !scheduledAt) { setSendError('Choose a date and time to schedule this reply.'); return }
        if (mode === 'forward' && forwardInvalid) { setSendError('Enter at least one valid forward recipient.'); return }

        const fingerprint = JSON.stringify([
            mode,
            body,
            forwardTo,
            attachments.map((a) => a.id),
            scheduleEnabled ? scheduledAt : null,
        ])
        if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
            attemptRef.current = { fingerprint, key: makeIdempotencyKey() }
        }
        const idempotencyKey = attemptRef.current.key

        setSubmitting(true)
        setSendError(null)
        try {
            const input: CreateSendCommandInput = {
                emailAccountId: accountId,
                mode,
                bodyText: body,
                attachmentIds: attachments.map((a) => a.id),
                scheduledAt: scheduleEnabled && scheduledAt ? new Date(scheduledAt).toISOString() : null,
                idempotencyKey,
                ...(mode === 'forward' ? { forwardTo: forwardRecipients } : {}),
            }
            const created = await onSend(input)
            // Success: the durable command now holds the text. Reset the form, drop the local
            // draft and release the key so any new send (including edited text) gets its own key.
            // The snapshot lets the operator reopen it if the command fails later.
            setSentSnapshot({ mode, body, forwardTo })
            setCommand(created)
            setBody('')
            setForwardTo('')
            setAttachments([])
            setScheduleEnabled(false)
            setScheduledAt('')
            setPendingDraft(null)
            setConfirmDiscard(false)
            setUploadError(null)
            setDraftSavedAt(null)
            setMode(null)
            attemptRef.current = null
            clearComposerDraft(conversationId)
        } catch (error) {
            // Draft is preserved: the body/attachments/mode all remain. Surface a specific reason.
            setSendError(error instanceof Error ? error.message : 'Could not create the reply. Your draft is safe.')
        } finally {
            setSubmitting(false)
        }
    }, [mode, submitting, bodyEmpty, scheduleEnabled, scheduledAt, forwardInvalid, body, forwardTo, attachments, accountId, forwardRecipients, onSend, conversationId])

    const reopenSnapshot = React.useCallback(() => {
        if (!sentSnapshot) return
        focusOnOpenRef.current = true
        setBody(sentSnapshot.body)
        setForwardTo(sentSnapshot.forwardTo)
        setMode(sentSnapshot.mode)
        setCommand(null)
        setSentSnapshot(null)
        attemptRef.current = null
    }, [sentSnapshot])

    const showDenial = active?.status === 'scheduled' && !!active.lastPolicyCode
    const canRecover = !!sentSnapshot && (active?.status === 'failed' || active?.status === 'cancelled')

    // Command state + recoverable denial reason. Shown with the editor open or closed.
    const statusStrip = active ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-border bg-muted/30 px-2 py-1.5 text-xs" aria-live="polite">
            <span className="font-medium">{STATUS_LABEL[active.status] ?? active.status}</span>
            {showDenial && <span className="text-amber-700 dark:text-amber-400">{policyHint(active.lastPolicyCode)}</span>}
            {active.status === 'failed' && active.lastError && <span className="text-red-600 dark:text-red-400">{active.lastError}</span>}
            {(active.status === 'scheduled' || active.status === 'queued') && onCancelCommand && (
                <button type="button" onClick={() => onCancelCommand(active.id)} className="underline hover:no-underline">Cancel send</button>
            )}
            {canRecover && (
                <button type="button" onClick={reopenSnapshot} className="underline hover:no-underline">Edit and resend</button>
            )}
            <button
                type="button"
                onClick={() => { setCommand(null); setSentSnapshot(null) }}
                aria-label="Dismiss send status"
                className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
        </div>
    ) : null

    if (mode === null) {
        return (
            <div className="flex flex-col gap-2 border-t border-border bg-card p-2">
                {statusStrip}
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => openEditor('reply')}
                        aria-label="Reply"
                        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Reply className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate">Reply…</span>
                    </button>
                    <Button size="sm" variant="outline" aria-label="Reply all" onClick={() => openEditor('reply_all')}>
                        <ReplyAll className="h-4 w-4 sm:mr-1.5" aria-hidden="true" />
                        <span className="hidden sm:inline" aria-hidden="true">Reply all</span>
                    </Button>
                    <Button size="sm" variant="outline" aria-label="Forward" onClick={() => openEditor('forward')}>
                        <Forward className="h-4 w-4 sm:mr-1.5" aria-hidden="true" />
                        <span className="hidden sm:inline" aria-hidden="true">Forward</span>
                    </Button>
                </div>
            </div>
        )
    }

    const primaryLabel = scheduleEnabled ? 'Schedule reply' : (mode === 'forward' ? 'Send forward' : 'Send reply')
    const recipientsLine = replyToPreview.join(', ') || '—'
    const ccLine = mode === 'reply_all' && replyAllCcPreview.length > 0 ? replyAllCcPreview.join(', ') : ''

    return (
        <form
            className="flex flex-col gap-2 border-t border-border bg-card p-3"
            aria-label="Reply composer"
            onSubmit={(e) => { e.preventDefault(); void submit() }}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    requestClose()
                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    if (canSubmit) void submit()
                }
            }}
        >
            {statusStrip}

            {/* Compact header: mode, resolved recipients, subject and the sending account. */}
            <div className="flex items-start gap-2 text-xs">
                <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="font-semibold uppercase tracking-wide text-muted-foreground">{MODE_LABEL[mode]}</p>
                    {mode === 'forward' ? (
                        <label className="flex items-center gap-2">
                            <span className="shrink-0 text-muted-foreground">To</span>
                            <input
                                ref={forwardRef}
                                aria-label="Forward recipients"
                                value={forwardTo}
                                onChange={(e) => setForwardTo(e.target.value)}
                                placeholder="name@example.com, other@example.com"
                                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                            />
                        </label>
                    ) : (
                        <p className="truncate text-muted-foreground" title={ccLine ? `${recipientsLine} (Cc: ${ccLine})` : recipientsLine}>
                            <span className="font-medium">To:</span> {recipientsLine}
                            {ccLine && <> <span className="font-medium">Cc:</span> {ccLine}</>}
                        </p>
                    )}
                    <p className="truncate text-muted-foreground"><span className="font-medium">Subject:</span> {subjectPreview || '(no subject)'}</p>
                    <p className="truncate text-muted-foreground">
                        Sending as <span className="font-medium text-foreground">{accountEmail ?? 'the conversation account'}</span>
                        {mode !== 'forward' && ' · recipients and threading are resolved by the server'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={requestClose}
                    aria-label="Close composer"
                    className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>

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
                ref={bodyRef}
                aria-label="Reply body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                style={{ maxHeight: BODY_MAX_HEIGHT }}
                className="w-full resize-none overflow-y-auto rounded border border-border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={mode === 'forward' ? 'Add a note (optional)…' : 'Write your reply…'}
            />

            {attachments.length > 0 && (
                <ul className="space-y-1">
                    {attachments.map((a) => (
                        <li key={a.id} className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-xs">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                            <span className="shrink-0 text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
                            <button type="button" onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.filename}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                                <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {uploadError && (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>
            )}

            {/* Compact toolbar: attachment, schedule, snippets and AI. */}
            <div className="flex flex-wrap items-center gap-1.5">
                <label className={cn(TOOL_BTN, 'cursor-pointer')}>
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{uploading ? 'Uploading…' : 'Attach'}</span>
                    <input type="file" className="sr-only" aria-label="Attach file" onChange={onFilePicked} disabled={uploading} />
                </label>
                <button
                    type="button"
                    className={cn(TOOL_BTN, scheduleEnabled && 'border-primary text-foreground')}
                    aria-pressed={scheduleEnabled}
                    onClick={() => setScheduleEnabled((prev) => !prev)}
                >
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Schedule for later</span>
                </button>
                {snippets.length > 0 && (
                    <select
                        aria-label="Insert snippet"
                        value=""
                        onChange={(e) => {
                            const snippet = snippets.find((s) => s.id === e.target.value)
                            if (snippet) insertSnippet(snippet)
                            e.target.value = ''
                        }}
                        className="h-8 max-w-[10rem] rounded-md border border-border bg-background px-2 text-xs text-muted-foreground"
                    >
                        <option value="">Insert a snippet…</option>
                        {snippets.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                )}
                {renderAiAssistant?.(insertDraft)}
            </div>

            {scheduleEnabled && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    <input
                        type="datetime-local"
                        aria-label="Scheduled time"
                        value={scheduledAt}
                        onChange={(e) => setScheduledAt(e.target.value)}
                        className="rounded border border-border bg-background px-2 py-1 text-sm"
                    />
                    <span className="text-muted-foreground">{timezone}</span>
                </div>
            )}

            {sendError && (
                <p role="alert" className="flex items-start gap-1 text-xs text-red-600 dark:text-red-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {sendError}
                </p>
            )}

            <div className="flex items-center justify-end gap-2">
                {draftSavedAt !== null && (
                    <span className="mr-auto text-xs text-muted-foreground" role="status" aria-live="polite">Draft saved</span>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={requestClose}>Cancel</Button>
                <Button type="submit" size="sm" disabled={!canSubmit} title="Shortcut: Ctrl+Enter">
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
