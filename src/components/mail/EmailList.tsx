import React from 'react'
import { useCompose } from '../../hooks/useCompose'
import {
    Star,
    Paperclip,
    MoreVertical,
    Trash2,
    Mail,
    MailOpen,
    Reply,
    ReplyAll,
    Forward,
    Archive,
    RefreshCw,
    CheckSquare,
    Square,
    Loader2,
    MessageSquare,
    ShieldAlert
} from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { MailboxRealtimeStatus } from '../../hooks/useMailboxEvents'
import { LiveIndicator } from './LiveIndicator'
import { formatEmailDate, getAvatarColor, getInitials } from '../../lib/utils'
import { recipientLabel, selectRange } from './email-list-utils'
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '../ui/dropdown-menu'

export interface EmailItem {
    id: string
    subject: string
    snippet: string
    from: {
        name: string
        email: string
    }
    to: {
        name: string
        email: string
    }[]
    date: Date
    read: boolean
    starred: boolean
    hasAttachments: boolean
    labels?: string[]
    threadCount?: number
    isThread?: boolean
}

interface EmailListProps {
    emails: EmailItem[]
    selectedId?: string
    selectedEmails?: Set<string>
    onSelect: (id: string) => void
    onSelectMultiple?: (ids: string[]) => void
    onToggleRead?: (id: string) => void
    onStar?: (id: string) => void
    onDelete?: (id: string) => void
    onArchive?: (id: string) => void
    onSpam?: (id: string) => void
    /** Sent and Drafts rows show who the message went to instead of our own address. */
    showRecipient?: boolean
    /** Which reply actions the row menu offers. Folders without them (Trash, Spam, Drafts) pass 'none'. */
    replyActions?: 'all' | 'forwardOnly' | 'none'
    emptyMessage?: string
    isLoadingMore?: boolean
    hasMore?: boolean
    loadMoreRef?: React.RefObject<HTMLDivElement>
}

const NO_SELECTION: Set<string> = new Set()

export function EmailList({
    emails,
    selectedId,
    selectedEmails = NO_SELECTION,
    onSelect,
    onSelectMultiple,
    onToggleRead,
    onStar,
    onDelete,
    onArchive,
    onSpam,
    showRecipient = false,
    replyActions = 'all',
    emptyMessage = 'No emails',
    isLoadingMore = false,
    hasMore = false,
    loadMoreRef
}: EmailListProps) {
    const isMobile = useIsMobile()
    const { openCompose } = useCompose()
    // Anchor for shift-click range selection.
    const lastCheckedId = React.useRef<string | null>(null)

    const handleCheckboxClick = (e: React.MouseEvent, id: string) => {
        e.preventDefault()
        e.stopPropagation()
        if (!onSelectMultiple) return

        const orderedIds = emails.map(email => email.id)
        const next = e.shiftKey
            ? selectRange(orderedIds, lastCheckedId.current, id, selectedEmails)
            : (() => {
                const toggled = new Set(selectedEmails)
                if (toggled.has(id)) toggled.delete(id)
                else toggled.add(id)
                return toggled
            })()

        lastCheckedId.current = id
        onSelectMultiple(Array.from(next))
    }

    if (emails.length === 0 && !isLoadingMore) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-20">
                <Mail className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-lg font-medium text-foreground">{emptyMessage}</p>
                <p className="text-sm mt-1">Your folder is empty</p>
            </div>
        )
    }

    const hasMenuActions = replyActions !== 'none' || !!onToggleRead || !!onArchive || !!onSpam || !!onDelete

    return (
        <>
            <ul className="divide-y divide-border" aria-label="Messages">
                {emails.map((email) => {
                    const isSelected = selectedId === email.id
                    const isChecked = selectedEmails.has(email.id)
                    const counterpart = showRecipient ? recipientLabel(email.to) : ''
                    const senderLabel = showRecipient
                        ? `To: ${counterpart || '(no recipient)'}`
                        : email.from.name || email.from.email
                    const avatarName = showRecipient ? (email.to[0]?.name || email.to[0]?.email || '') : (email.from.name || email.from.email)
                    const avatarEmail = showRecipient ? (email.to[0]?.email || avatarName) : email.from.email

                    return (
                        <li
                            key={email.id}
                            className={`
                                group relative flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 cursor-pointer transition-all duration-150
                                ${isSelected ? 'bg-muted' : 'bg-card hover:bg-accent/50'}
                                ${isChecked && !isSelected ? 'bg-accent/30' : ''}
                                ${!email.read ? 'font-semibold text-foreground' : 'text-muted-foreground'}
                            `}
                            style={{
                                borderLeft: isSelected
                                    ? '3px solid hsl(var(--primary))'
                                    : '3px solid transparent'
                            }}
                            onClick={() => onSelect(email.id)}
                        >
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${!email.read ? 'bg-primary' : 'bg-transparent'}`} aria-hidden="true" />

                            {onSelectMultiple && (
                                <button
                                    type="button"
                                    role="checkbox"
                                    aria-checked={isChecked}
                                    aria-label={`Select message: ${email.subject || '(No subject)'}`}
                                    onClick={(e) => handleCheckboxClick(e, email.id)}
                                    className={`
                                        flex-shrink-0 p-1 rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
                                        ${isChecked
                                            ? 'text-primary'
                                            : 'text-muted-foreground/50 hover:text-muted-foreground'
                                        }
                                    `}
                                >
                                    {isChecked ? (
                                        <CheckSquare className="w-4 h-4" />
                                    ) : (
                                        <Square className="w-4 h-4" />
                                    )}
                                </button>
                            )}

                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    onStar?.(email.id)
                                }}
                                aria-label={email.starred ? 'Unstar' : 'Star'}
                                aria-pressed={email.starred}
                                className={`
                                    flex-shrink-0 p-1 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
                                    ${email.starred
                                        ? 'text-yellow-500 hover:text-yellow-600'
                                        : 'text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100'
                                    }
                                `}
                            >
                                <Star className={`w-4 h-4 ${email.starred ? 'fill-current' : ''}`} />
                            </button>

                            <SenderAvatar name={avatarName} email={avatarEmail} />

                            {/* Primary control: focusable, Enter/Space opens the message. The row's own
                                click handler does the work (the button's click bubbles to it). */}
                            <button
                                type="button"
                                aria-current={isSelected ? 'true' : undefined}
                                className="flex-1 min-w-0 text-left bg-transparent p-0 font-[inherit] text-[inherit] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            >
                                {/* Sender and date share the first line; the date never shrinks, the sender
                                    takes the leftover width and truncates. */}
                                <span className="flex items-center gap-2 min-w-0">
                                    {!email.read && <span className="sr-only">Unread. </span>}
                                    <span className={`min-w-0 flex-1 truncate text-sm ${!email.read ? 'text-foreground' : 'text-foreground/80'}`}>
                                        {senderLabel}
                                    </span>
                                    <span className={`shrink-0 whitespace-nowrap text-xs ${!email.read ? 'text-foreground/90' : 'text-muted-foreground'}`}>
                                        {formatEmailDate(email.date)}
                                    </span>
                                </span>

                                <span className="flex items-center gap-2 min-w-0 mt-0.5">
                                    <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                                        {email.subject}
                                    </span>
                                    {email.isThread && email.threadCount && email.threadCount > 1 && (
                                        <span className="flex items-center gap-1 px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded text-xs font-medium flex-shrink-0">
                                            <MessageSquare className="w-3 h-3" />
                                            {email.threadCount}
                                        </span>
                                    )}
                                    {email.hasAttachments && (
                                        <Paperclip
                                            className="w-3.5 h-3.5 shrink-0 text-muted-foreground"
                                            aria-label="Has attachments"
                                        />
                                    )}
                                </span>

                                <span className="hidden sm:block text-xs text-muted-foreground truncate mt-0.5 font-normal">
                                    {email.snippet}
                                </span>

                                {email.labels && email.labels.length > 0 && (
                                    <span className="flex items-center gap-1 mt-1.5">
                                        {email.labels.map((label) => (
                                            <span
                                                key={label}
                                                className="px-2 py-0.5 text-xs uppercase tracking-wider font-semibold rounded-full bg-secondary text-secondary-foreground"
                                            >
                                                {label}
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </button>

                            {/* Quick actions float over the date on hover/focus instead of taking row width,
                                so the text column never shrinks when the pointer enters a row. Only actions
                                that exist in the current folder are rendered. */}
                            <div className="absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg border border-border bg-card px-1 shadow-sm group-hover:flex group-focus-within:flex">
                                    {onToggleRead && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); onToggleRead(email.id) }}
                                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                                            title={email.read ? 'Mark as unread' : 'Mark as read'}
                                            aria-label={email.read ? 'Mark as unread' : 'Mark as read'}
                                        >
                                            {email.read ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
                                        </button>
                                    )}
                                    {onDelete && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); onDelete(email.id) }}
                                            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                                            title="Delete"
                                            aria-label="Delete"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                    {onArchive && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); onArchive(email.id) }}
                                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                                            title="Archive"
                                            aria-label="Archive"
                                        >
                                            <Archive className="w-4 h-4" />
                                        </button>
                                    )}
                                    {hasMenuActions && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    onClick={(e) => e.stopPropagation()}
                                                    aria-label="More actions"
                                                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                                                >
                                                    <MoreVertical className="w-4 h-4" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align={isMobile ? 'start' : 'end'} className="w-48" onClick={(e) => e.stopPropagation()}>
                                                {replyActions === 'all' && (
                                                    <>
                                                        <DropdownMenuItem onClick={() => openCompose({ replyToId: email.id })}>
                                                            <Reply className="w-4 h-4" />
                                                            Reply
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem onClick={() => openCompose({ replyToId: email.id, replyAll: true })}>
                                                            <ReplyAll className="w-4 h-4" />
                                                            Reply All
                                                        </DropdownMenuItem>
                                                    </>
                                                )}
                                                {replyActions !== 'none' && (
                                                    <DropdownMenuItem onClick={() => openCompose({ forwardId: email.id })}>
                                                        <Forward className="w-4 h-4" />
                                                        Forward
                                                    </DropdownMenuItem>
                                                )}
                                                {onToggleRead && (
                                                    <DropdownMenuItem onClick={() => onToggleRead(email.id)}>
                                                        {email.read ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
                                                        {email.read ? 'Mark as unread' : 'Mark as read'}
                                                    </DropdownMenuItem>
                                                )}
                                                {onArchive && (
                                                    <DropdownMenuItem onClick={() => onArchive(email.id)}>
                                                        <Archive className="w-4 h-4" />
                                                        Archive
                                                    </DropdownMenuItem>
                                                )}
                                                {onSpam && (
                                                    <DropdownMenuItem
                                                        onClick={() => onSpam(email.id)}
                                                        className="text-amber-500 focus:bg-amber-500/10 focus:text-amber-500"
                                                    >
                                                        <ShieldAlert className="w-4 h-4" />
                                                        Mark as spam
                                                    </DropdownMenuItem>
                                                )}
                                                {onDelete && (
                                                    <>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem
                                                            onClick={() => onDelete(email.id)}
                                                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                            Delete
                                                        </DropdownMenuItem>
                                                    </>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                </div>
                        </li>
                    )
                })}
            </ul>

            {(isLoadingMore || hasMore) && (
                <div
                    ref={loadMoreRef as React.RefObject<HTMLDivElement>}
                    className="flex items-center justify-center py-6"
                >
                    {isLoadingMore && (
                        <div className="flex items-center gap-2 text-muted-foreground" role="status">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-sm">Loading more...</span>
                        </div>
                    )}
                </div>
            )}
        </>
    )
}

// Initials only: fetching a favicon per sender from a third-party service would tell that
// service which domains this mailbox hears from.
function SenderAvatar({ name, email }: { name: string; email: string }) {
    const color = getAvatarColor(email || name)
    const initials = getInitials(name || email || '?')

    return (
        <div
            className={`w-8 h-8 rounded-full flex-shrink-0 ${color} flex items-center justify-center text-white text-xs font-semibold select-none`}
            aria-hidden="true"
        >
            {initials}
        </div>
    )
}

interface EmailToolbarProps {
    selectedCount: number
    /** Messages currently loaded in the list (what "select all" really selects). */
    loadedCount?: number
    /** Messages in the folder on the server. */
    totalCount?: number
    onSelectAll?: () => void
    onMarkRead: () => void
    onMarkUnread: () => void
    onDelete: () => void
    onArchive: () => void
    onRefresh: () => void
    onSpam?: () => void
    spamLabel?: string
    isRefreshing?: boolean
    /** Live push-stream state; when given, a small "Live" / "Reconnecting…" marker sits by the refresh button. */
    realtimeStatus?: MailboxRealtimeStatus
}

export function EmailToolbar({
    selectedCount,
    loadedCount,
    totalCount,
    onSelectAll,
    onMarkRead,
    onMarkUnread,
    onDelete,
    onArchive,
    onRefresh,
    onSpam,
    spamLabel = 'Mark as spam',
    isRefreshing,
    realtimeStatus
}: EmailToolbarProps) {
    // "Select all" only reaches what is loaded; say so instead of promising the folder total.
    const loaded = loadedCount ?? 0
    const partial = totalCount !== undefined && loaded > 0 && totalCount > loaded
    const selectAllLabel = loaded > 0
        ? `Select all ${loaded}${partial ? ` loaded (of ${totalCount})` : ''}`
        : 'Select all'

    return (
        <div className="flex items-center justify-between px-3 sm:px-4 py-2 border-b border-border bg-background">
            <div className="flex items-center gap-2">
                {onSelectAll ? (
                    <button
                        onClick={onSelectAll}
                        title={partial ? 'Selects the messages loaded so far. Scroll down to load more.' : undefined}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {selectedCount > 0 ? `${selectedCount} selected` : selectAllLabel}
                    </button>
                ) : (
                    <span className="text-xs font-medium text-muted-foreground">
                        {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-1">
                {realtimeStatus && <LiveIndicator status={realtimeStatus} />}
                <button
                    onClick={onRefresh}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title="Refresh"
                    aria-label="Refresh"
                >
                    <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </button>
                {selectedCount > 0 && (
                    <>
                        <button
                            onClick={onMarkRead}
                            className="inline-flex items-center gap-2 px-2.5 py-1 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            title="Mark as read"
                        >
                            <MailOpen className="w-4 h-4" />
                            Mark as read
                        </button>
                        <button
                            onClick={onMarkUnread}
                            className="inline-flex items-center gap-2 px-2.5 py-1 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            title="Mark as unread"
                        >
                            <Mail className="w-4 h-4" />
                            Mark as unread
                        </button>
                        <button
                            onClick={onArchive}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            title="Archive"
                            aria-label="Archive"
                        >
                            <Archive className="w-4 h-4" />
                        </button>
                        {onSpam && (
                            <button
                                onClick={onSpam}
                                className="p-1.5 rounded-lg text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-colors"
                                title={spamLabel}
                                aria-label={spamLabel}
                            >
                                <ShieldAlert className="w-4 h-4" />
                            </button>
                        )}
                        <button
                            onClick={onDelete}
                            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            title="Delete"
                            aria-label="Delete"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
