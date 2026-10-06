import React from 'react'
import { Link } from 'wouter'
import {
    AlertCircle,
    Check,
    Mail,
    Plus,
    RefreshCw,
    Search,
    Settings,
    X,
} from 'lucide-react'
import { useMailbox, getProviderColor, getProviderIcon, type Mailbox } from '../../hooks/useMailbox'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { ConnectMailboxDialog } from './ConnectMailboxDialog'
import { groupMailboxes, mailboxLocalPart } from './mailbox-navigation'

interface MailboxSidebarSwitcherProps {
    collapsed: boolean
    isMobile: boolean
    onNavigate: () => void
}

interface MailboxPanelProps {
    query: string
    setQuery: (value: string) => void
    onSelect: (mailbox: Mailbox) => void
    onAdd: () => void
    onManage: () => void
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

function MailboxAvatar({ mailbox }: { mailbox: Mailbox }) {
    const color = mailbox.isNative ? domainColor(mailbox.email) : getProviderColor(mailbox.provider)

    return (
        <span
            className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white shadow-sm',
                color,
            )}
            aria-hidden="true"
        >
            {mailbox.isNative ? <Mail className="h-4 w-4" /> : getProviderIcon(mailbox.provider)}
        </span>
    )
}

function MailboxRow({
    mailbox,
    selected,
    onSelect,
}: {
    mailbox: Mailbox
    selected: boolean
    onSelect: () => void
}) {
    const localPart = mailboxLocalPart(mailbox.email)
    const label = mailbox.displayName || localPart

    return (
        <button
            type="button"
            onClick={onSelect}
            aria-current={selected ? 'page' : undefined}
            title={mailbox.email}
            className={cn(
                'group flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors',
                selected
                    ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
        >
            <MailboxAvatar mailbox={mailbox} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{mailbox.email}</span>
            </span>
            {mailbox.syncError ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-label="Synchronization error" />
            ) : selected ? (
                <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
                <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', mailbox.isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                    aria-label={mailbox.isActive ? 'Active mailbox' : 'Inactive mailbox'}
                />
            )}
        </button>
    )
}

function MailboxPanel({ query, setQuery, onSelect, onAdd, onManage }: MailboxPanelProps) {
    const { mailboxes, selectedMailbox, isLoading, refreshMailboxes } = useMailbox()
    const deferredQuery = React.useDeferredValue(query)
    const [isRefreshing, setIsRefreshing] = React.useState(false)
    const groups = React.useMemo(
        () => groupMailboxes(mailboxes, deferredQuery),
        [mailboxes, deferredQuery],
    )

    const visibleCount = React.useMemo(
        () => groups.reduce((total, group) => total + group.mailboxes.length, 0),
        [groups],
    )

    const handleRefresh = async () => {
        setIsRefreshing(true)
        try {
            await refreshMailboxes()
        } finally {
            setIsRefreshing(false)
        }
    }

    return (
        <div className="min-w-0 overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
                <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Mailboxes</p>
                    <p className="text-[11px] text-muted-foreground" aria-live="polite">
                        {query ? `${visibleCount} of ${mailboxes.length}` : `${mailboxes.length} available`}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    aria-label="Refresh mailboxes"
                    title="Refresh mailboxes"
                >
                    <RefreshCw className={cn('h-4 w-4', isRefreshing ? 'animate-spin' : '')} />
                </button>
            </div>

            <div className="px-3 pb-2">
                <label className="relative block">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search name or email"
                        aria-label="Search mailboxes"
                        className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-xs outline-none transition-shadow placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                    />
                    {query ? (
                        <button
                            type="button"
                            onClick={() => setQuery('')}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label="Clear mailbox search"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                </label>
            </div>

            <div className="max-h-[min(34vh,17rem)] overflow-y-auto overflow-x-hidden px-2 pb-2 [scrollbar-gutter:stable]">
                {isLoading ? (
                    <div className="space-y-2 px-1 py-2" aria-label="Loading mailboxes">
                        {Array.from({ length: 4 }, (_, index) => (
                            <div key={index} className="h-12 animate-pulse rounded-lg bg-muted" />
                        ))}
                    </div>
                ) : groups.length > 0 ? (
                    <div className="space-y-2">
                        {groups.map((group) => (
                            <section key={group.domain} aria-labelledby={`mailbox-domain-${group.domain}`}>
                                <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-2 py-1 backdrop-blur-sm">
                                    <span
                                        id={`mailbox-domain-${group.domain}`}
                                        className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                                    >
                                        {group.domain}
                                    </span>
                                    <span className="text-[10px] tabular-nums text-muted-foreground/70">{group.mailboxes.length}</span>
                                </div>
                                <div className="space-y-0.5">
                                    {group.mailboxes.map((mailbox) => (
                                        <MailboxRow
                                            key={mailbox.id}
                                            mailbox={mailbox}
                                            selected={selectedMailbox?.id === mailbox.id}
                                            onSelect={() => onSelect(mailbox)}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                ) : (
                    <div className="px-3 py-8 text-center">
                        <Mail className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                        <p className="text-xs font-medium text-foreground">No mailboxes found</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">Try a different name, address, or domain.</p>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-2 gap-1 border-t border-border px-2 pb-2 pt-2">
                <button
                    type="button"
                    onClick={onAdd}
                    className="flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                >
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Add mailbox</span>
                </button>
                <Link
                    href="/mail/settings"
                    onClick={onManage}
                    className="flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    <Settings className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Manage</span>
                </Link>
            </div>
        </div>
    )
}

export function MailboxSidebarSwitcher({ collapsed, isMobile, onNavigate }: MailboxSidebarSwitcherProps) {
    const { selectedMailbox, setSelectedMailbox } = useMailbox()
    const [query, setQuery] = React.useState('')
    const [popoverOpen, setPopoverOpen] = React.useState(false)
    const [connectDialogOpen, setConnectDialogOpen] = React.useState(false)

    const handleSelect = React.useCallback((mailbox: Mailbox) => {
        setSelectedMailbox(mailbox)
        setPopoverOpen(false)
        if (isMobile) onNavigate()
    }, [isMobile, onNavigate, setSelectedMailbox])

    const handleAdd = React.useCallback(() => {
        setPopoverOpen(false)
        setConnectDialogOpen(true)
    }, [])

    const panel = (
        <MailboxPanel
            query={query}
            setQuery={setQuery}
            onSelect={handleSelect}
            onAdd={handleAdd}
            onManage={() => {
                setPopoverOpen(false)
                if (isMobile) onNavigate()
            }}
        />
    )

    return (
        <>
            {collapsed ? (
                <div className="border-b border-border px-2 py-3">
                    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                className="flex w-full items-center justify-center rounded-xl p-2 transition-colors hover:bg-accent"
                                aria-label={`Choose mailbox${selectedMailbox ? `, currently ${selectedMailbox.email}` : ''}`}
                            >
                                {selectedMailbox ? <MailboxAvatar mailbox={selectedMailbox} /> : <Mail className="h-5 w-5 text-muted-foreground" />}
                            </button>
                        </PopoverTrigger>
                        <PopoverContent side="right" align="start" sideOffset={10} className="w-80 overflow-hidden p-0">
                            {panel}
                        </PopoverContent>
                    </Popover>
                </div>
            ) : (
                <section className="border-b border-border bg-card/40">{panel}</section>
            )}

            <ConnectMailboxDialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen} />
        </>
    )
}
