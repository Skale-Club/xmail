import React from 'react'
import {
    Archive,
    ArchiveRestore,
    Ban,
    Check,
    CheckCircle2,
    Clock,
    Loader2,
    Mail,
    MailOpen,
    Plus,
    RotateCcw,
    Tag,
    X,
} from 'lucide-react'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { cn } from '../../../lib/utils'
import type {
    InboxConversationStatus,
    InboxConversationSummary,
    InboxLabel,
    InboxReminder,
    SuppressionPreview,
    SuppressionResult,
    SuppressionScope,
} from '../../../lib/unified-inbox-api'

// ============================================================
// Conversation operator actions (Phase 22 UIX-04 / UIX-05)
// ============================================================
// Two accessible toolbars share this module:
//   - <ConversationActions>: single-conversation controls for the thread header (read/unread,
//     archive/restore, close/reopen, labels, reminders, and the destructive block-sender/domain
//     flow gated by ConfirmDialog).
//   - <BulkActionsBar>: the bounded bulk toolbar for the CURRENTLY LOADED, explicitly-selected
//     set only. Its copy always says how many rows are selected — never "all N matching".
// Every control is prop-driven (no data fetching here) so the page owns the optimistic hooks
// and these stay unit-testable. Icon buttons carry accessible names and 44px touch targets;
// state is text + icon, never colour alone.

const ACTION_BTN = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

// ------------------------------------------------------------
// Suppression controller (server-authoritative; see useInboxSuppression)
// ------------------------------------------------------------

export interface SuppressionController {
    preview: (email: string, scope: SuppressionScope) => Promise<SuppressionPreview>
    apply: (email: string, scope: SuppressionScope) => Promise<SuppressionResult>
}

type SuppressionPhase = 'preview' | 'confirm' | 'applying' | 'error'

interface SuppressionDialogState {
    scope: SuppressionScope
    phase: SuppressionPhase
    /** Domain scope requires two explicit confirms; step 2 is the final destructive one. */
    domainStep?: 1 | 2
    preview?: SuppressionPreview
    error?: string
}

/**
 * The destructive block flow. It ALWAYS asks the server to preview the target first (exact
 * address, public-domain classification, already-suppressed, warnings), then requires an
 * explicit confirm — and a SECOND explicit confirm for a domain-scope block. A public/free-mail
 * domain can never be blocked at domain scope: the dialog offers only the safe sender scope.
 * Cancelling makes no apply call; a rejected apply keeps the dialog open with the reason.
 */
function SuppressionFlow({
    open,
    email,
    initialScope,
    controller,
    onClose,
    onSuppressed,
}: {
    open: boolean
    email: string
    initialScope: SuppressionScope
    controller: SuppressionController
    onClose: () => void
    onSuppressed: (result: SuppressionResult) => void
}) {
    const [state, setState] = React.useState<SuppressionDialogState | null>(null)
    const requestRef = React.useRef(0)

    const beginPreview = React.useCallback(
        async (scope: SuppressionScope) => {
            const token = ++requestRef.current
            setState({ scope, phase: 'preview', domainStep: scope === 'domain' ? 1 : undefined })
            try {
                const preview = await controller.preview(email, scope)
                if (requestRef.current !== token) return
                setState({ scope: preview.scope, phase: 'confirm', preview, domainStep: preview.scope === 'domain' ? 1 : undefined })
            } catch (error) {
                if (requestRef.current !== token) return
                setState({ scope, phase: 'error', error: messageFor(error) })
            }
        },
        [controller, email],
    )

    // Reset + kick off the preview for the chosen scope whenever the flow opens.
    React.useEffect(() => {
        if (open) {
            void beginPreview(initialScope)
        } else {
            requestRef.current += 1
            setState(null)
        }
    }, [open, initialScope, beginPreview])

    if (!open || !state) {
        return (
            <ConfirmDialog
                open={open}
                onOpenChange={(next) => { if (!next) onClose() }}
                title="Block sender"
                description="Preparing…"
                confirmLabel="Block"
                variant="danger"
                loading
                onConfirm={() => undefined}
            />
        )
    }

    const domain = state.preview?.domain ?? email.split('@')[1] ?? ''
    const alreadySuppressed = state.preview?.alreadySuppressed
    const publicDomain = state.preview?.isPublicDomain

    const applying = state.phase === 'applying'

    const apply = async (scope: SuppressionScope) => {
        setState((prev) => (prev ? { ...prev, phase: 'applying' } : prev))
        try {
            const result = await controller.apply(email, scope)
            onSuppressed(result)
            onClose()
        } catch (error) {
            setState((prev) => (prev ? { ...prev, scope, phase: 'error', error: messageFor(error) } : prev))
        }
    }

    // --- Error surface: keep the dialog open, selection + focus intact, offer a retry. ---
    if (state.phase === 'error') {
        return (
            <ConfirmDialog
                open
                onOpenChange={(next) => { if (!next) onClose() }}
                title="Could not block"
                description={state.error ?? 'The block could not be completed. Your selection is unchanged.'}
                confirmLabel="Retry"
                cancelLabel="Cancel"
                variant="danger"
                onConfirm={() => void apply(state.scope)}
            />
        )
    }

    // --- Domain scope, public/free-mail: refuse domain block, offer the safe sender scope. ---
    if (state.scope === 'domain' && publicDomain) {
        return (
            <ConfirmDialog
                open
                onOpenChange={(next) => { if (!next) onClose() }}
                title="Domain block not allowed"
                description={`${domain} is a public or free-mail provider. Blocking the entire domain would suppress unrelated recipients, so it is not permitted. You can block just ${email} instead.`}
                confirmLabel="Block this sender only"
                cancelLabel="Cancel"
                variant="danger"
                loading={applying}
                onConfirm={() => void apply('sender')}
            />
        )
    }

    // --- Domain scope, safe domain: two explicit confirms. ---
    if (state.scope === 'domain') {
        if (state.domainStep === 2) {
            return (
                <ConfirmDialog
                    open
                    onOpenChange={(next) => { if (!next) onClose() }}
                    title="Confirm domain block"
                    description={`This permanently stops all future outreach from this organization to EVERY address at ${domain}. This affects the whole domain.`}
                    confirmLabel="Block domain"
                    cancelLabel="Back"
                    variant="danger"
                    loading={applying}
                    onConfirm={() => void apply('domain')}
                />
            )
        }
        return (
            <ConfirmDialog
                open
                onOpenChange={(next) => { if (!next) onClose() }}
                title={`Block domain ${domain}?`}
                description={describeScope('domain', email, domain, state.preview)}
                confirmLabel="Continue"
                cancelLabel="Cancel"
                variant="danger"
                loading={state.phase === 'preview'}
                onConfirm={() => setState((prev) => (prev ? { ...prev, domainStep: 2 } : prev))}
            />
        )
    }

    // --- Sender scope. ---
    return (
        <ConfirmDialog
            open
            onOpenChange={(next) => { if (!next) onClose() }}
            title={`Block sender ${email}?`}
            description={
                alreadySuppressed
                    ? `${email} is already suppressed for this organization. Confirming re-affirms the block.`
                    : describeScope('sender', email, domain, state.preview)
            }
            confirmLabel="Block sender"
            cancelLabel="Cancel"
            variant="danger"
            loading={applying || state.phase === 'preview'}
            onConfirm={() => void apply('sender')}
        />
    )
}

function describeScope(scope: SuppressionScope, email: string, domain: string, preview?: SuppressionPreview): string {
    const warnings = preview?.warnings?.length ? ` ${preview.warnings.join(' ')}` : ''
    if (scope === 'domain') {
        return `Blocking ${domain} stops future outreach to every address at that domain, organization-wide.${warnings}`
    }
    return `Blocking ${email} stops all future outreach from this organization to this address.${warnings}`
}

function messageFor(error: unknown): string {
    const code = (error as { details?: { error?: string }; message?: string })?.details?.error
        ?? (error as { message?: string })?.message
    if (code === 'suppression_public_domain') return 'That domain is a public/free-mail provider and cannot be blocked at domain scope.'
    if (typeof code === 'string' && code) return `Blocked: ${code}. Your selection is unchanged.`
    return 'The block could not be completed. Your selection is unchanged.'
}

// ------------------------------------------------------------
// Single-conversation actions
// ------------------------------------------------------------

export interface ConversationActionsProps {
    conversation: InboxConversationSummary
    labels: InboxLabel[]
    reminders?: InboxReminder[]
    counterpartyEmail?: string | null
    suppression?: SuppressionController
    onToggleRead: (read: boolean) => void
    onToggleArchive: (archived: boolean) => void
    onSetStatus?: (status: InboxConversationStatus) => void
    onAttachLabel: (label: InboxLabel) => void
    onDetachLabel: (labelId: string) => void
    onCreateReminder?: (remindAt: string, note: string | null) => void
    busy?: boolean
}

export function ConversationActions({
    conversation,
    labels,
    reminders,
    counterpartyEmail,
    suppression,
    onToggleRead,
    onToggleArchive,
    onSetStatus,
    onAttachLabel,
    onDetachLabel,
    onCreateReminder,
    busy,
}: ConversationActionsProps) {
    const [blockScope, setBlockScope] = React.useState<SuppressionScope | null>(null)
    const [blockNotice, setBlockNotice] = React.useState<string | null>(null)
    const attachedIds = new Set(conversation.labels.map((l) => l.id))
    const scheduled = (reminders ?? []).filter((r) => r.status === 'scheduled')
    const counterpartyDomain = counterpartyEmail?.split('@')[1] ?? ''

    return (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Conversation actions">
            <button
                type="button"
                className={ACTION_BTN}
                disabled={busy}
                onClick={() => onToggleRead(conversation.unread)}
            >
                {conversation.unread ? <MailOpen className="h-3.5 w-3.5" aria-hidden="true" /> : <Mail className="h-3.5 w-3.5" aria-hidden="true" />}
                {conversation.unread ? 'Mark read' : 'Mark unread'}
            </button>

            <button
                type="button"
                className={ACTION_BTN}
                disabled={busy}
                onClick={() => onToggleArchive(!conversation.archived)}
            >
                {conversation.archived ? <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" /> : <Archive className="h-3.5 w-3.5" aria-hidden="true" />}
                {conversation.archived ? 'Restore' : 'Archive'}
            </button>

            {onSetStatus && (
                <button
                    type="button"
                    className={ACTION_BTN}
                    disabled={busy}
                    onClick={() => onSetStatus(conversation.status === 'closed' ? 'open' : 'closed')}
                >
                    {conversation.status === 'closed' ? <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    {conversation.status === 'closed' ? 'Reopen' : 'Close'}
                </button>
            )}

            {/* Labels — named controls in a native disclosure (keyboard-operable). */}
            <details className="relative">
                <summary className={cn(ACTION_BTN, 'cursor-pointer list-none')}>
                    <Tag className="h-3.5 w-3.5" aria-hidden="true" /> Labels
                </summary>
                <div className="absolute left-0 z-20 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
                    {labels.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">No labels yet. Create one in the filter rail.</p>
                    ) : (
                        <ul className="max-h-56 overflow-y-auto">
                            {labels.map((label) => {
                                const attached = attachedIds.has(label.id)
                                return (
                                    <li key={label.id}>
                                        <button
                                            type="button"
                                            role="menuitemcheckbox"
                                            aria-checked={attached}
                                            disabled={busy}
                                            onClick={() => (attached ? onDetachLabel(label.id) : onAttachLabel(label))}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        >
                                            <span className="flex h-4 w-4 items-center justify-center rounded border border-border">
                                                {attached && <Check className="h-3 w-3" aria-hidden="true" />}
                                            </span>
                                            <span
                                                className="h-2 w-2 rounded-full border border-border"
                                                style={label.color ? { backgroundColor: label.color } : undefined}
                                                aria-hidden="true"
                                            />
                                            <span className="flex-1 truncate">{label.name}</span>
                                        </button>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            </details>

            {/* Reminders — durable (server-scheduled), never a browser timer. */}
            {onCreateReminder && (
                <details className="relative">
                    <summary className={cn(ACTION_BTN, 'cursor-pointer list-none')}>
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        {scheduled.length > 0 ? `Reminder (${scheduled.length})` : 'Remind me'}
                    </summary>
                    <div className="absolute left-0 z-20 mt-1 w-64 rounded-md border border-border bg-popover p-2 shadow-md">
                        <ReminderForm onCreate={onCreateReminder} busy={busy} />
                        {scheduled.length > 0 && (
                            <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                                {scheduled.map((r) => (
                                    <li key={r.id}>Scheduled for {new Date(r.remindAt).toLocaleString()}</li>
                                ))}
                            </ul>
                        )}
                    </div>
                </details>
            )}

            {/* Block sender / domain — destructive, always confirmed server-side. The operator
                explicitly chooses the scope; the server rejects a public/free-mail domain block. */}
            {suppression && counterpartyEmail && (
                <details className="relative">
                    <summary className={cn(ACTION_BTN, 'cursor-pointer list-none text-destructive')}>
                        <Ban className="h-3.5 w-3.5" aria-hidden="true" /> Block
                    </summary>
                    <div className="absolute left-0 z-20 mt-1 w-60 rounded-md border border-border bg-popover p-1 shadow-md">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => { setBlockNotice(null); setBlockScope('sender') }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate">Block sender ({counterpartyEmail})</span>
                        </button>
                        <button
                            type="button"
                            disabled={busy || !counterpartyDomain}
                            onClick={() => { setBlockNotice(null); setBlockScope('domain') }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate">Block domain ({counterpartyDomain})</span>
                        </button>
                    </div>
                </details>
            )}

            {blockNotice && (
                <span role="status" className="text-xs text-muted-foreground">{blockNotice}</span>
            )}

            {suppression && counterpartyEmail && (
                <SuppressionFlow
                    open={blockScope !== null}
                    email={counterpartyEmail}
                    initialScope={blockScope ?? 'sender'}
                    controller={suppression}
                    onClose={() => setBlockScope(null)}
                    onSuppressed={(result) =>
                        setBlockNotice(
                            result.alreadySuppressed
                                ? `${result.email} was already blocked.`
                                : result.scope === 'domain'
                                    ? `Blocked the ${result.domain} domain.`
                                    : `Blocked ${result.email}.`,
                        )
                    }
                />
            )}
        </div>
    )
}

function ReminderForm({ onCreate, busy }: { onCreate: (remindAt: string, note: string | null) => void; busy?: boolean }) {
    const [when, setWhen] = React.useState('')
    const [note, setNote] = React.useState('')
    const inputId = React.useId()
    const noteId = React.useId()

    const submit = () => {
        if (!when) return
        const iso = new Date(when).toISOString()
        onCreate(iso, note.trim() || null)
        setWhen('')
        setNote('')
    }

    return (
        <div className="space-y-2">
            <div>
                <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-muted-foreground">Remind at</label>
                <input
                    id={inputId}
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            </div>
            <div>
                <label htmlFor={noteId} className="mb-1 block text-xs font-medium text-muted-foreground">Note (optional)</label>
                <input
                    id={noteId}
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={1000}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
            </div>
            <button
                type="button"
                onClick={submit}
                disabled={busy || !when}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Set reminder
            </button>
        </div>
    )
}

// ------------------------------------------------------------
// Bounded bulk actions bar
// ------------------------------------------------------------

export interface BulkActionsBarProps {
    selectedCount: number
    /** The hard bulk ceiling (mirrors the server's BULK_CONVERSATION_LIMIT). */
    limit: number
    labels: InboxLabel[]
    onBulkReadState: (read: boolean) => void
    onBulkArchive: () => void
    onBulkAddLabel: (label: InboxLabel) => void
    onSelectAllLoaded: () => void
    onClear: () => void
    onExit: () => void
    busy?: boolean
}

export function BulkActionsBar({
    selectedCount,
    limit,
    labels,
    onBulkReadState,
    onBulkArchive,
    onBulkAddLabel,
    onSelectAllLoaded,
    onClear,
    onExit,
    busy,
}: BulkActionsBarProps) {
    const overLimit = selectedCount > limit
    const disabled = busy || selectedCount === 0 || overLimit

    return (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/40 p-2" role="group" aria-label="Bulk actions">
            <span className="mr-1 text-xs font-medium text-foreground" aria-live="polite">
                {/* Honest: the count is the explicitly-selected, loaded rows — never "all matching". */}
                {selectedCount} selected
            </span>

            <button type="button" className={ACTION_BTN} onClick={onSelectAllLoaded} disabled={busy}>
                Select loaded
            </button>
            <button type="button" className={ACTION_BTN} onClick={onClear} disabled={busy || selectedCount === 0}>
                Clear
            </button>

            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

            <button type="button" className={ACTION_BTN} onClick={() => onBulkReadState(true)} disabled={disabled}>
                <MailOpen className="h-3.5 w-3.5" aria-hidden="true" /> Mark read
            </button>
            <button type="button" className={ACTION_BTN} onClick={() => onBulkReadState(false)} disabled={disabled}>
                <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Mark unread
            </button>
            <button type="button" className={ACTION_BTN} onClick={onBulkArchive} disabled={disabled}>
                <Archive className="h-3.5 w-3.5" aria-hidden="true" /> Archive
            </button>

            <details className="relative">
                <summary className={cn(ACTION_BTN, 'cursor-pointer list-none', disabled && 'pointer-events-none opacity-50')}>
                    <Tag className="h-3.5 w-3.5" aria-hidden="true" /> Label
                </summary>
                <div className="absolute left-0 z-20 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md">
                    {labels.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">No labels yet.</p>
                    ) : (
                        <ul className="max-h-56 overflow-y-auto">
                            {labels.map((label) => (
                                <li key={label.id}>
                                    <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => onBulkAddLabel(label)}
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <Plus className="h-3 w-3" aria-hidden="true" />
                                        <span className="flex-1 truncate">{label.name}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </details>

            <button type="button" className={cn(ACTION_BTN, 'ml-auto')} onClick={onExit} disabled={busy}>
                <X className="h-3.5 w-3.5" aria-hidden="true" /> Done
            </button>

            {overLimit && (
                <p role="alert" className="w-full text-xs text-destructive">
                    Selection exceeds the {limit}-conversation limit. Deselect some to continue.
                </p>
            )}
            {busy && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Working…
                </span>
            )}
        </div>
    )
}

export default ConversationActions
