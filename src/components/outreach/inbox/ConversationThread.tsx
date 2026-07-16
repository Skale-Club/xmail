import { useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Download, Paperclip, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { Skeleton } from '../../ui/Skeleton'
import { EmailHtmlViewer } from '../../mail/EmailHtmlViewer'
import { formatBytes, formatRelativeDate } from '../../../lib/utils'
import type {
    InboxConversationDetail,
    InboxMessage,
} from '../../../lib/unified-inbox-api'

export interface ConversationThreadProps {
    detail: InboxConversationDetail | undefined
    isLoading: boolean
    isError: boolean
    onRetry: () => void
    onBack: () => void
    onClose: () => void
    providerByAccount: Record<string, string>
    campaignNameById: Record<string, string>
    /** Operator action toolbar (ConversationActions), rendered in the thread header. */
    actions?: ReactNode
    /** Reply/forward composer (ConversationComposer), rendered as a sticky thread footer. */
    composer?: ReactNode
}

const NOT_LINKED = 'Not linked'

function directionLabel(message: InboxMessage): string {
    return message.direction === 'outbound' ? 'Sent' : 'Received'
}

function messageTimestamp(message: InboxMessage): string | null {
    const iso = message.receivedAt ?? message.sentAt ?? message.createdAt
    return iso ? new Date(iso).toLocaleString() : null
}

function MessageCard({ message, initiallyExpanded }: { message: InboxMessage; initiallyExpanded: boolean }) {
    const [expanded, setExpanded] = useState(initiallyExpanded)
    const from = message.fromName || message.fromAddress || 'Unknown sender'
    const exact = messageTimestamp(message)
    const relative = message.receivedAt ?? message.sentAt ?? message.createdAt

    return (
        <article className="rounded-lg border border-border bg-card">
            <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                aria-expanded={expanded}
                className="flex w-full items-start gap-2 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
                {expanded ? (
                    <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : (
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{from}</span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                            {directionLabel(message)}
                        </span>
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] capitalize text-muted-foreground">
                            {message.provider}
                        </span>
                        {relative && (
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={exact ?? undefined}>
                                {formatRelativeDate(relative)}
                            </span>
                        )}
                    </div>
                    {!expanded && message.plainBody && (
                        <p className="mt-1 truncate text-xs text-muted-foreground">{message.plainBody}</p>
                    )}
                </div>
            </button>

            {expanded && (
                <div className="border-t border-border px-4 py-3">
                    <div className="mb-2 space-y-0.5 text-xs text-muted-foreground">
                        {message.toAddresses.length > 0 && (
                            <p className="truncate">
                                <span className="font-medium">To:</span>{' '}
                                {message.toAddresses.map((a) => a.name || a.address).join(', ')}
                            </p>
                        )}
                        {message.ccAddresses.length > 0 && (
                            <p className="truncate">
                                <span className="font-medium">Cc:</span>{' '}
                                {message.ccAddresses.map((a) => a.name || a.address).join(', ')}
                            </p>
                        )}
                    </div>

                    <EmailHtmlViewer html={message.htmlBody} plainText={message.plainBody} />

                    {message.attachments.length > 0 && (
                        <ul className="mt-3 space-y-1.5">
                            {message.attachments.map((attachment, index) => (
                                <li
                                    key={attachment.providerId ?? `${attachment.name}-${index}`}
                                    className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
                                >
                                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="min-w-0 flex-1 truncate text-foreground">{attachment.name || 'attachment'}</span>
                                    <span className="shrink-0 text-muted-foreground">
                                        {attachment.mimeType?.split('/')[0] ?? 'file'}
                                        {attachment.size != null ? ` · ${formatBytes(attachment.size)}` : ''}
                                    </span>
                                    <button
                                        type="button"
                                        disabled
                                        aria-disabled="true"
                                        title="Attachment download is coming in a later update"
                                        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-50"
                                    >
                                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                        <span className="sr-only">Download {attachment.name || 'attachment'}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </article>
    )
}

export function ConversationThread({
    detail,
    isLoading,
    isError,
    onRetry,
    onBack,
    onClose,
    providerByAccount,
    campaignNameById,
    actions,
    composer,
}: ConversationThreadProps) {
    // Latest message always expands; the latest inbound also expands so a new reply is
    // readable immediately. Older messages collapse behind a keyboard-operable toggle.
    const initiallyExpanded = useMemo(() => {
        const set = new Set<string>()
        const messages = detail?.messages ?? []
        if (messages.length > 0) set.add(messages[messages.length - 1].id)
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i].direction === 'inbound') {
                set.add(messages[i].id)
                break
            }
        }
        return set
    }, [detail])

    if (isLoading) {
        return (
            <div className="flex h-full flex-col">
                <ThreadHeaderBar title="Loading…" onBack={onBack} onClose={onClose} />
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-28 w-full" />
                    <Skeleton className="h-28 w-full" />
                </div>
            </div>
        )
    }

    if (isError || !detail) {
        return (
            <div className="flex h-full flex-col">
                <ThreadHeaderBar title="Conversation" onBack={onBack} onClose={onClose} />
                <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
                    <div>
                        <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                        <p className="mb-3 text-sm text-muted-foreground">Couldn’t load this conversation.</p>
                        <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
                    </div>
                </div>
            </div>
        )
    }

    const { conversation, participants, messages } = detail
    const counterparty = participants.find((p) => p.role === 'from') ?? participants[0]
    const campaignName = conversation.campaignId ? campaignNameById[conversation.campaignId] : undefined
    const provider = providerByAccount[conversation.emailAccountId]
    const firstActivity = conversation.lastOutboundAt || messages[0]?.sentAt || messages[0]?.receivedAt || messages[0]?.createdAt || null
    const lastActivity = conversation.lastMessageAt || messages[messages.length - 1]?.createdAt || null

    return (
        <div className="flex h-full flex-col">
            <ThreadHeaderBar
                title={conversation.subject || '(No subject)'}
                subtitle={counterparty ? (counterparty.name ? `${counterparty.name} · ${counterparty.address}` : counterparty.address) : undefined}
                status={conversation.status}
                labels={conversation.labels.map((l) => l.name)}
                onBack={onBack}
                onClose={onClose}
                actions={actions}
            />

            {/* Attribution strip */}
            <dl className="flex flex-wrap gap-x-6 gap-y-1 border-b border-border bg-muted/30 px-4 py-2 text-xs">
                <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Campaign:</dt>
                    <dd className={campaignName ? 'text-foreground' : 'text-muted-foreground italic'}>
                        {campaignName ?? (conversation.campaignId ? 'Linked' : NOT_LINKED)}
                    </dd>
                </div>
                <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Account:</dt>
                    <dd className="capitalize text-foreground">{provider ?? conversation.emailAccountId.slice(0, 8)}</dd>
                </div>
                <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Lead:</dt>
                    <dd className={conversation.leadId ? 'text-foreground' : 'text-muted-foreground italic'}>
                        {conversation.leadId ? (counterparty?.address ?? 'Linked') : NOT_LINKED}
                    </dd>
                </div>
                {firstActivity && (
                    <div className="flex items-center gap-1.5">
                        <dt className="text-muted-foreground">First activity:</dt>
                        <dd className="text-foreground" title={new Date(firstActivity).toLocaleString()}>{formatRelativeDate(firstActivity)}</dd>
                    </div>
                )}
                {lastActivity && (
                    <div className="flex items-center gap-1.5">
                        <dt className="text-muted-foreground">Last activity:</dt>
                        <dd className="text-foreground" title={new Date(lastActivity).toLocaleString()}>{formatRelativeDate(lastActivity)}</dd>
                    </div>
                )}
            </dl>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                {messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">This conversation has no messages yet.</p>
                ) : (
                    messages.map((message) => (
                        <MessageCard
                            key={message.id}
                            message={message}
                            initiallyExpanded={initiallyExpanded.has(message.id)}
                        />
                    ))
                )}
            </div>

            {composer && <div className="shrink-0">{composer}</div>}
        </div>
    )
}

function ThreadHeaderBar({
    title,
    subtitle,
    status,
    labels,
    onBack,
    onClose,
    actions,
}: {
    title: string
    subtitle?: string
    status?: 'open' | 'closed'
    labels?: string[]
    onBack: () => void
    onClose: () => void
    actions?: ReactNode
}) {
    return (
        <div className="border-b border-border p-3">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                >
                    <ArrowLeft className="h-4 w-4" /> Back
                </button>
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
                    {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
                </div>
                {status === 'closed' && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">Closed</span>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close thread"
                    className="hidden shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            {labels && labels.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                    {labels.map((label) => (
                        <span key={label} className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">{label}</span>
                    ))}
                </div>
            )}
            {actions && <div className="mt-2">{actions}</div>}
        </div>
    )
}

export default ConversationThread
