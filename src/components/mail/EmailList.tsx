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
import { formatEmailDate, getAvatarColor, getInitials } from '../../lib/utils'

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
    emptyMessage?: string
    isLoadingMore?: boolean
    hasMore?: boolean
    loadMoreRef?: React.RefObject<HTMLDivElement>
}

export function EmailList({
    emails,
    selectedId,
    selectedEmails = new Set(),
    onSelect,
    onSelectMultiple,
    onToggleRead,
    onStar,
    onDelete,
    onArchive,
    onSpam,
    emptyMessage = 'No emails',
    isLoadingMore = false,
    hasMore = false,
    loadMoreRef
}: EmailListProps) {
    const [menuOpenId, setMenuOpenId] = React.useState<string | null>(null)
    const isMobile = useIsMobile()
    const { openCompose } = useCompose()

    const handleCheckboxClick = (e: React.MouseEvent, id: string) => {
        e.preventDefault()
        e.stopPropagation()
        if (!onSelectMultiple) return

        const newSet = new Set(selectedEmails)
        if (newSet.has(id)) {
            newSet.delete(id)
        } else {
            newSet.add(id)
        }
        onSelectMultiple(Array.from(newSet))
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

    return (
        <div className="divide-y divide-border">
            {emails.map((email) => (
                <div
                    key={email.id}
                    className={`
                        group relative flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 sm:py-2.5 cursor-pointer transition-all duration-150
                        ${selectedId === email.id ? 'bg-muted' : 'bg-card hover:bg-accent/50'}
                        ${selectedEmails.has(email.id) && selectedId !== email.id ? 'bg-accent/30' : ''}
                        ${!email.read ? 'font-semibold text-foreground' : 'text-muted-foreground'}
                    `}
                    style={{
                        borderLeft: selectedId === email.id
                            ? '3px solid hsl(var(--primary))'
                            : '3px solid transparent'
                    }}
                    onClick={() => onSelect(email.id)}
                >
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${!email.read ? 'bg-primary' : 'bg-transparent'}`} />

                    {onSelectMultiple && (
                        <button
                            onClick={(e) => handleCheckboxClick(e, email.id)}
                            className={`
                                flex-shrink-0 p-1 rounded transition-colors
                                ${selectedEmails.has(email.id)
                                    ? 'text-primary'
                                    : 'text-muted-foreground/50 hover:text-muted-foreground'
                                }
                            `}
                        >
                            {selectedEmails.has(email.id) ? (
                                <CheckSquare className="w-4 h-4" />
                            ) : (
                                <Square className="w-4 h-4" />
                            )}
                        </button>
                    )}

                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onStar?.(email.id)
                        }}
                        className={`
                            flex-shrink-0 p-1 rounded-full transition-colors
                            ${email.starred
                                ? 'text-yellow-500 hover:text-yellow-600'
                                : 'text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100'
                            }
                        `}
                    >
                        <Star className={`w-4 h-4 ${email.starred ? 'fill-current' : ''}`} />
                    </button>

                    <SenderAvatar name={email.from.name} email={email.from.email} />

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                            <span className={`truncate text-sm ${!email.read ? 'text-foreground' : 'text-foreground/80'}`}>
                                {email.from.name || email.from.email}
                            </span>
                        </div>

                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="truncate text-sm text-foreground/90">
                                {email.subject}
                            </span>
                            {email.isThread && email.threadCount && email.threadCount > 1 && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded text-[10px] font-medium flex-shrink-0">
                                    <MessageSquare className="w-3 h-3" />
                                    {email.threadCount}
                                </span>
                            )}
                        </div>

                        <p className="text-xs text-muted-foreground truncate mt-0.5 hidden sm:block">
                            {email.snippet}
                        </p>

                        {email.labels && email.labels.length > 0 && (
                            <div className="flex items-center gap-1 mt-1.5">
                                {email.labels.map((label) => (
                                    <span
                                        key={label}
                                        className="px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold rounded-full bg-secondary text-secondary-foreground"
                                    >
                                        {label}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex-shrink-0 flex items-center gap-1">
                        <span className={`text-xs ${!email.read ? 'text-foreground/90' : 'text-muted-foreground'}`}>
                            {formatEmailDate(email.date)}
                        </span>

                        {/* Paperclip: visible when not hovering */}
                        {email.hasAttachments && (
                            <Paperclip className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 group-hover:hidden" />
                        )}

                        {/* Quick actions: visible on hover */}
                        <div className="hidden group-hover:flex items-center gap-0.5">
                            {onToggleRead && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); onToggleRead(email.id) }}
                                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                                    title={email.read ? 'Mark as unread' : 'Mark as read'}
                                >
                                    {email.read ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
                                </button>
                            )}
                            <button
                                onClick={(e) => { e.stopPropagation(); onDelete?.(email.id) }}
                                className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-all"
                                title="Delete"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onArchive?.(email.id) }}
                                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                                title="Archive"
                            >
                                <Archive className="w-4 h-4" />
                            </button>
                            <div className="relative">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setMenuOpenId(menuOpenId === email.id ? null : email.id)
                                    }}
                                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
                                >
                                    <MoreVertical className="w-4 h-4" />
                                </button>

                        {menuOpenId === email.id && (
                            <>
                                <div
                                    className="fixed inset-0 z-40"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setMenuOpenId(null)
                                    }}
                                />
                                <div className={`absolute ${isMobile ? 'left-0' : 'right-0'} top-full mt-1 w-48 bg-popover rounded-xl shadow-xl border border-border py-1 z-50`}>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setMenuOpenId(null)
                                            openCompose({ replyToId: email.id })
                                        }}
                                        className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                    >
                                        <Reply className="w-4 h-4" />
                                        Reply
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setMenuOpenId(null)
                                            openCompose({ replyToId: email.id, replyAll: true })
                                        }}
                                        className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                    >
                                        <ReplyAll className="w-4 h-4" />
                                        Reply All
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setMenuOpenId(null)
                                            openCompose({ forwardId: email.id })
                                        }}
                                        className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                    >
                                        <Forward className="w-4 h-4" />
                                        Forward
                                    </button>
                                    {onToggleRead && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                onToggleRead(email.id)
                                                setMenuOpenId(null)
                                            }}
                                            className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                        >
                                            {email.read ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
                                            {email.read ? 'Mark as unread' : 'Mark as read'}
                                        </button>
                                    )}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            onArchive?.(email.id)
                                            setMenuOpenId(null)
                                        }}
                                        className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                    >
                                        <Archive className="w-4 h-4" />
                                        Archive
                                    </button>
                                    {onSpam && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                onSpam(email.id)
                                                setMenuOpenId(null)
                                            }}
                                            className="flex items-center gap-3 w-full px-4 py-2 text-sm text-amber-500 hover:bg-amber-500/10"
                                        >
                                            <ShieldAlert className="w-4 h-4" />
                                            Mark as spam
                                        </button>
                                    )}
                                    <div className="border-t border-border my-1" />
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            onDelete?.(email.id)
                                            setMenuOpenId(null)
                                        }}
                                        className="flex items-center gap-3 w-full px-4 py-2 text-sm text-gray-500 hover:text-red-500 hover:bg-red-500/10"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Delete
                                    </button>
                                </div>
                            </>
                        )}
                            </div>
                        </div>
                    </div>
                </div>
            ))}

            {(isLoadingMore || hasMore) && (
                <div
                    ref={loadMoreRef as React.RefObject<HTMLDivElement>}
                    className="flex items-center justify-center py-6"
                >
                    {isLoadingMore && (
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span className="text-sm">Loading more...</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

function SenderAvatar({ name, email }: { name: string; email: string }) {
    const [imgError, setImgError] = React.useState(false)
    const domain = email.split('@')[1]
    const color = getAvatarColor(email)
    const initials = getInitials(name || email)
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null

    if (faviconUrl && !imgError) {
        return (
            <div className="w-8 h-8 rounded-full flex-shrink-0 overflow-hidden bg-muted flex items-center justify-center">
                <img
                    src={faviconUrl}
                    alt={initials}
                    className="w-5 h-5 object-contain"
                    onError={() => setImgError(true)}
                />
            </div>
        )
    }

    return (
        <div className={`w-8 h-8 rounded-full flex-shrink-0 ${color} flex items-center justify-center text-white text-xs font-semibold select-none`}>
            {initials}
        </div>
    )
}

interface EmailToolbarProps {
    selectedCount: number
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
}

export function EmailToolbar({
    selectedCount,
    totalCount,
    onSelectAll,
    onMarkRead,
    onMarkUnread,
    onDelete,
    onArchive,
    onRefresh,
    onSpam,
    spamLabel = 'Mark as spam',
    isRefreshing
}: EmailToolbarProps) {
    return (
        <div className="flex items-center justify-between px-3 sm:px-4 py-2 border-b border-border bg-background">
            <div className="flex items-center gap-2">
                {onSelectAll ? (
                    <button
                        onClick={onSelectAll}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {selectedCount > 0 
                            ? `${selectedCount} selected` 
                            : totalCount 
                                ? `Select all (${totalCount})`
                                : 'Select all'
                        }
                    </button>
                ) : (
                    <span className="text-xs font-medium text-muted-foreground">
                        {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-1">
                <button
                    onClick={onRefresh}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    title="Refresh"
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
                        >
                            <Archive className="w-4 h-4" />
                        </button>
                        {onSpam && (
                            <button
                                onClick={onSpam}
                                className="p-1.5 rounded-lg text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-colors"
                                title={spamLabel}
                            >
                                <ShieldAlert className="w-4 h-4" />
                            </button>
                        )}
                        <button
                            onClick={onDelete}
                            className="p-1.5 rounded-lg text-gray-500 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                            title="Delete"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
