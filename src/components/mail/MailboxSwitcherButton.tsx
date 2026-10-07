import React from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { useMailbox, getProviderColor, type Mailbox } from '../../hooks/useMailbox'
import { isInsideDialog } from '../../hooks/useKeyboardShortcuts'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ConnectMailboxDialog } from './ConnectMailboxDialog'
import { MailboxSwitcherPanel } from './MailboxSwitcherPanel'
import {
    FOCUS_MAILBOX_SEARCH_EVENT,
    formatUnreadBadge,
    mailboxDomain,
    mailboxLocalPart,
} from './mailbox-navigation'

interface MailboxSwitcherButtonProps {
    /** Sidebar is collapsed to its 72px rail: only the avatar and the badge show. */
    collapsed: boolean
    isMobile: boolean
    onNavigate: () => void
}

const DOMAIN_COLORS = [
    'bg-indigo-500',
    'bg-sky-600',
    'bg-emerald-600',
    'bg-violet-600',
    'bg-amber-600',
    'bg-rose-600',
] as const

function domainColor(email: string): string {
    const domain = email.split('@')[1] || email
    let hash = 0
    for (let index = 0; index < domain.length; index += 1) {
        hash = ((hash << 5) - hash + domain.charCodeAt(index)) | 0
    }
    return DOMAIN_COLORS[Math.abs(hash) % DOMAIN_COLORS.length]
}

function MailboxAvatar({ mailbox }: { mailbox: Mailbox | null }) {
    const initial = (mailbox ? mailboxLocalPart(mailbox.email) : '?').charAt(0).toUpperCase()
    const color = !mailbox
        ? 'bg-muted-foreground/40'
        : mailbox.isNative ? domainColor(mailbox.email) : getProviderColor(mailbox.provider)

    return (
        <span
            data-testid="mailbox-avatar"
            className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white shadow-sm',
                color,
            )}
            aria-hidden="true"
        >
            {initial}
        </span>
    )
}

/**
 * Sidebar trigger for the mailbox switcher: shows the current mailbox and its unread count and
 * opens MailboxSwitcherPanel in a popover. Ctrl+K and "g m" open the panel with the search focused.
 */
export function MailboxSwitcherButton({ collapsed, isMobile, onNavigate }: MailboxSwitcherButtonProps) {
    const { selectedMailbox, setSelectedMailbox } = useMailbox()
    const [open, setOpen] = React.useState(false)
    const [connectDialogOpen, setConnectDialogOpen] = React.useState(false)
    const searchInputRef = React.useRef<HTMLInputElement>(null)

    const focusSearch = React.useCallback(() => {
        const input = searchInputRef.current
        if (!input) return
        input.focus()
        input.select()
    }, [])

    // Open (or, when already open, refocus the search) from the keyboard.
    const openFromKeyboard = React.useCallback(() => {
        setOpen(true)
        // The panel mounts on the next render when it was closed; when open already, focus now.
        window.setTimeout(focusSearch, 0)
    }, [focusSearch])

    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return
            if (event.altKey || event.shiftKey) return
            // The compose window, its editor and other dialogs own Ctrl+K (insert link, ...). Our own
            // panel is a popover (role=dialog too), so a second Ctrl+K inside it just refocuses the search.
            const target = event.target as HTMLElement | null
            if (target?.isContentEditable || target?.closest?.('[data-compose-window]')) return
            if (isInsideDialog(target) && !target?.closest('[data-mailbox-switcher]')) return
            event.preventDefault()
            openFromKeyboard()
        }
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener(FOCUS_MAILBOX_SEARCH_EVENT, openFromKeyboard)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
            window.removeEventListener(FOCUS_MAILBOX_SEARCH_EVENT, openFromKeyboard)
        }
    }, [openFromKeyboard])

    const handleSelect = React.useCallback((mailbox: Mailbox) => {
        // Only the mailbox changes: the route (and so the open folder) stays where it is.
        setSelectedMailbox(mailbox)
        setOpen(false)
        if (isMobile) onNavigate()
    }, [isMobile, onNavigate, setSelectedMailbox])

    const handleAdd = React.useCallback(() => {
        setOpen(false)
        setConnectDialogOpen(true)
    }, [])

    const handleManage = React.useCallback(() => {
        setOpen(false)
        if (isMobile) onNavigate()
    }, [isMobile, onNavigate])

    const unreadBadge = formatUnreadBadge(selectedMailbox?.unreadCount)
    const unreadCount = selectedMailbox?.unreadCount ?? 0
    const label = selectedMailbox
        ? `${selectedMailbox.email}${unreadCount > 0 ? `, ${unreadCount} unread` : ''}. Switch mailbox`
        : 'Choose mailbox'

    return (
        <>
            <div className={cn('border-b border-border', collapsed ? 'px-2 py-2' : 'px-3 py-2')}>
                <Popover open={open} onOpenChange={setOpen}>
                    <PopoverTrigger asChild>
                        {collapsed ? (
                            <button
                                type="button"
                                aria-label={label}
                                title={`${selectedMailbox?.email ?? 'Choose mailbox'} (Ctrl+K)`}
                                className="relative flex w-full items-center justify-center rounded-xl p-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <MailboxAvatar mailbox={selectedMailbox} />
                                {unreadBadge ? (
                                    <span
                                        className="absolute right-0.5 top-0 min-w-[1.1rem] rounded-full bg-primary px-1 py-0.5 text-center text-[10px] font-semibold leading-none text-primary-foreground tabular-nums"
                                        aria-label={`${selectedMailbox?.unreadCount} unread`}
                                    >
                                        {unreadBadge}
                                    </span>
                                ) : null}
                            </button>
                        ) : (
                            <button
                                type="button"
                                aria-label={label}
                                title="Switch mailbox (Ctrl+K)"
                                className="flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <MailboxAvatar mailbox={selectedMailbox} />
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {selectedMailbox ? (
                                        <>
                                            <span className="font-semibold text-foreground">{mailboxLocalPart(selectedMailbox.email)}</span>
                                            <span className="text-muted-foreground">@{mailboxDomain(selectedMailbox.email)}</span>
                                        </>
                                    ) : (
                                        <span className="text-muted-foreground">Choose mailbox</span>
                                    )}
                                </span>
                                {unreadBadge ? (
                                    <span
                                        className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold leading-none text-primary-foreground tabular-nums"
                                        aria-label={`${selectedMailbox?.unreadCount} unread`}
                                    >
                                        {unreadBadge}
                                    </span>
                                ) : null}
                                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            </button>
                        )}
                    </PopoverTrigger>
                    <PopoverContent
                        data-mailbox-switcher=""
                        side={collapsed ? 'right' : 'bottom'}
                        align="start"
                        sideOffset={collapsed ? 10 : 6}
                        collisionPadding={8}
                        className="w-[360px] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
                        onOpenAutoFocus={(event) => {
                            // Land on the search box, not on the first button.
                            event.preventDefault()
                            focusSearch()
                        }}
                    >
                        <MailboxSwitcherPanel
                            searchInputRef={searchInputRef}
                            onSelect={handleSelect}
                            onAdd={handleAdd}
                            onManage={handleManage}
                        />
                    </PopoverContent>
                </Popover>
            </div>

            <ConnectMailboxDialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen} />
        </>
    )
}
