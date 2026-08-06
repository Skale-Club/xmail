import { Archive, Inbox, Mail, MailOpen, ShieldAlert, Star, Trash2, Sun, Moon } from 'lucide-react'
import { cn, getAvatarColor, getInitials } from '../../lib/utils'
import { SenderAuthBadge } from './SenderAuthBadge'
import type { SenderAuthStatus } from '../../lib/mail-auth-status'

interface EmailParticipant {
    name?: string | null
    email: string
}

interface EmailMessageHeaderProps {
    from: EmailParticipant
    to: EmailParticipant[]
    date: Date
    className?: string
    read?: boolean
    starred?: boolean
    isSpam?: boolean
    onToggleRead?: () => void
    onArchive?: () => void
    onSpam?: () => void
    onDelete?: () => void
    onStar?: () => void
    archiveTitle?: string
    archiveAriaLabel?: string
    archiveIcon?: 'archive' | 'inbox'
    emailDarkMode?: boolean
    onToggleEmailDarkMode?: () => void
    authStatus?: SenderAuthStatus
}

export function EmailMessageHeader({
    from,
    to,
    date,
    className,
    read,
    starred,
    isSpam,
    onToggleRead,
    onArchive,
    onSpam,
    onDelete,
    onStar,
    archiveTitle = 'Archive',
    archiveAriaLabel = 'Archive',
    archiveIcon = 'archive',
    emailDarkMode,
    onToggleEmailDarkMode,
    authStatus,
}: EmailMessageHeaderProps) {
    const avatarColor = getAvatarColor(from.email)
    const initials = getInitials(from.name || from.email)
    const recipientLabel = to.map((recipient) => recipient.name || recipient.email).join(', ')
    const hasActions = Boolean(onToggleRead || onArchive || onSpam || onDelete || onStar || onToggleEmailDarkMode)
    const ArchiveActionIcon = archiveIcon === 'inbox' ? Inbox : Archive

    return (
        <div className={cn(`grid items-center gap-x-3 pt-1.5 pb-4 border-b border-border mb-3 ${
            hasActions ? 'grid-cols-[auto,minmax(0,1fr),auto,auto]' : 'grid-cols-[auto,minmax(0,1fr),auto]'
        }`, className)}>
            <div
                className={`w-7 h-7 rounded-full ${avatarColor} flex items-center justify-center text-white font-medium text-xs flex-shrink-0`}
            >
                {initials}
            </div>
            <div className="min-w-0 self-center">
                <p className="flex items-center gap-1.5 text-sm font-semibold leading-tight text-foreground truncate">
                    <span className="truncate">{from.name || from.email}</span>
                    {authStatus && <SenderAuthBadge status={authStatus} className="flex-shrink-0" />}
                </p>
                <p className="text-xs leading-tight text-muted-foreground truncate">
                    To: {recipientLabel}
                </p>
            </div>
            {hasActions && (
                <div className="flex items-center gap-1 self-center">
                    {onToggleRead && (
                        <button
                            type="button"
                            onClick={onToggleRead}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title={read ? 'Mark as unread' : 'Mark as read'}
                            aria-label={read ? 'Mark as unread' : 'Mark as read'}
                        >
                            {read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
                        </button>
                    )}
                    {onArchive && (
                        <button
                            type="button"
                            onClick={onArchive}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title={archiveTitle}
                            aria-label={archiveAriaLabel}
                        >
                            <ArchiveActionIcon className="h-4 w-4" />
                        </button>
                    )}
                    {onSpam && (
                        <button
                            type="button"
                            onClick={onSpam}
                            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                                isSpam
                                    ? 'text-primary hover:bg-primary/10 hover:text-primary'
                                    : 'text-muted-foreground hover:bg-amber-500/10 hover:text-amber-500'
                            }`}
                            title={isSpam ? 'Not spam' : 'Mark as spam'}
                            aria-label={isSpam ? 'Not spam' : 'Mark as spam'}
                        >
                            <ShieldAlert className="h-4 w-4" />
                        </button>
                    )}
                    {onDelete && (
                        <button
                            type="button"
                            onClick={onDelete}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
                            title="Move to trash"
                            aria-label="Move to trash"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    )}
                    {onStar && (
                        <button
                            type="button"
                            onClick={onStar}
                            className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
                                starred
                                    ? 'text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-600'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                            }`}
                            title={starred ? 'Remove from favorites' : 'Add to favorites'}
                            aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                        >
                            <Star className={`h-4 w-4 ${starred ? 'fill-current' : ''}`} />
                        </button>
                    )}
                    {onToggleEmailDarkMode && (
                        <button
                            type="button"
                            onClick={onToggleEmailDarkMode}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title={emailDarkMode ? 'Light mode' : 'Dark mode'}
                            aria-label={emailDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                        >
                            {emailDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                        </button>
                    )}
                </div>
            )}
            <p className="text-xs text-muted-foreground flex-shrink-0 self-center">
                {date.toLocaleString()}
            </p>
        </div>
    )
}
