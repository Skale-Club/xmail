import React from 'react'
import { Link } from 'wouter'
import {
    AlertCircle,
    Check,
    ChevronDown,
    Mail,
    Pin,
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
import {
    FOCUS_MAILBOX_SEARCH_EVENT,
    buildMailboxSections,
    formatUnreadBadge,
    mailboxLocalPart,
    type MailboxGroup,
} from './mailbox-navigation'
import { useMailboxPreferences } from './useMailboxPreferences'

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
    searchInputRef: React.RefObject<HTMLInputElement>
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
    pinned,
    onSelect,
    onTogglePin,
}: {
    mailbox: Mailbox
    selected: boolean
    pinned: boolean
    onSelect: () => void
    onTogglePin: () => void
}) {
    const localPart = mailboxLocalPart(mailbox.email)
    const label = mailbox.displayName || localPart
    const unreadBadge = formatUnreadBadge(mailbox.unreadCount)
    const rowRef = React.useRef<HTMLDivElement>(null)

    // The list scrolls inside a fixed-height area: keep the active mailbox on screen.
    React.useEffect(() => {
        if (selected && typeof rowRef.current?.scrollIntoView === 'function') {
            rowRef.current.scrollIntoView({ block: 'nearest' })
        }
    }, [selected])

    return (
        <div
            ref={rowRef}
            className={cn(
                'group flex w-full min-w-0 items-center rounded-lg transition-colors',
                selected
                    ? 'bg-primary/10 text-foreground ring-1 ring-inset ring-primary/20'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
        >
            <button
                type="button"
                onClick={onSelect}
                aria-current={selected ? 'true' : undefined}
                title={mailbox.email}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <MailboxAvatar mailbox={mailbox} />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{mailbox.email}</span>
                </span>
                {mailbox.syncError ? (
                    <AlertCircle className="h-4 w-4 shrink-0 text-destructive" aria-label="Synchronization error" />
                ) : null}
                {unreadBadge ? (
                    <span
                        className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold leading-none text-primary-foreground tabular-nums"
                        aria-label={`${mailbox.unreadCount} unread`}
                    >
                        {unreadBadge}
                    </span>
                ) : null}
                {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                ) : !unreadBadge && !mailbox.syncError ? (
                    <span
                        className={cn('h-2 w-2 shrink-0 rounded-full', mailbox.isActive ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                        aria-label={mailbox.isActive ? 'Active mailbox' : 'Inactive mailbox'}
                    />
                ) : null}
            </button>
            <button
                type="button"
                onClick={onTogglePin}
                aria-pressed={pinned}
                aria-label={pinned ? `Unpin ${mailbox.email}` : `Pin ${mailbox.email}`}
                title={pinned ? 'Unpin' : 'Pin to top'}
                className={cn(
                    'mr-1 shrink-0 rounded-md p-1.5 transition-opacity hover:bg-background/60 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    pinned ? 'text-primary opacity-100' : 'text-muted-foreground opacity-0 group-hover:opacity-100',
                )}
            >
                <Pin className={cn('h-3.5 w-3.5', pinned ? 'fill-current' : '')} />
            </button>
        </div>
    )
}

function GroupHeading({ id, label, count }: { id: string; label: string; count: number }) {
    return (
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-2 py-1 backdrop-blur-sm">
            <span
                id={id}
                className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
                {label}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        </div>
    )
}

function MailboxPanel({ query, setQuery, onSelect, onAdd, onManage, searchInputRef }: MailboxPanelProps) {
    const { mailboxes, selectedMailbox, isLoading, isRefreshing, refreshMailboxes } = useMailbox()
    const { pinnedIds, togglePin, showOthers, setShowOthers } = useMailboxPreferences()
    const deferredQuery = React.useDeferredValue(query)

    const sections = React.useMemo(
        () => buildMailboxSections(mailboxes, {
            query: deferredQuery,
            pinnedIds,
            selectedId: selectedMailbox?.id ?? null,
            showOthers,
        }),
        [mailboxes, deferredQuery, pinnedIds, selectedMailbox?.id, showOthers],
    )

    const visibleCount = sections.pinned.length
        + sections.operationGroups.reduce((total, group) => total + group.mailboxes.length, 0)
        + sections.otherGroups.reduce((total, group) => total + group.mailboxes.length, 0)
    const hasAnyGroup = visibleCount > 0
    const searching = query.trim().length > 0

    const renderRow = (mailbox: Mailbox) => (
        <MailboxRow
            key={mailbox.id}
            mailbox={mailbox}
            selected={selectedMailbox?.id === mailbox.id}
            pinned={pinnedIds.has(mailbox.id)}
            onSelect={() => onSelect(mailbox)}
            onTogglePin={() => togglePin(mailbox.id)}
        />
    )

    const renderGroup = (group: MailboxGroup, idPrefix: string) => {
        // Organization names can contain spaces, which are not valid in an id reference.
        const headingId = `${idPrefix}-${group.domain.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
        return (
            <section key={headingId} aria-labelledby={headingId}>
                <GroupHeading id={headingId} label={group.domain} count={group.mailboxes.length} />
                <div className="space-y-0.5">{group.mailboxes.map(renderRow)}</div>
            </section>
        )
    }

    return (
        <div className="min-w-0 overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
                <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mailboxes</p>
                    <p className="text-xs text-muted-foreground" aria-live="polite">
                        {searching ? `${visibleCount} of ${mailboxes.length}` : `${mailboxes.length - sections.hiddenOtherCount} available`}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => { void refreshMailboxes() }}
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
                        ref={searchInputRef}
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search name or email"
                        aria-label="Search mailboxes"
                        className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
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

            <div className="max-h-[min(45vh,26rem)] overflow-y-auto overflow-x-hidden px-2 pb-2 [scrollbar-gutter:stable]">
                {isLoading ? (
                    <div className="space-y-2 px-1 py-2" aria-label="Loading mailboxes">
                        {Array.from({ length: 4 }, (_, index) => (
                            <div key={index} className="h-12 animate-pulse rounded-lg bg-muted" />
                        ))}
                    </div>
                ) : hasAnyGroup ? (
                    <div className="space-y-2">
                        {sections.pinned.length > 0 ? (
                            <section aria-labelledby="mailbox-pinned">
                                <GroupHeading id="mailbox-pinned" label="Pinned" count={sections.pinned.length} />
                                <div className="space-y-0.5">{sections.pinned.map(renderRow)}</div>
                            </section>
                        ) : null}
                        {sections.operationGroups.map(group => renderGroup(group, 'mailbox-domain'))}
                        {sections.otherGroups.length > 0 ? (
                            <div className="space-y-2 border-t border-dashed border-border pt-2">
                                <p className="px-2 text-xs text-muted-foreground">Other organizations</p>
                                {sections.otherGroups.map(group => renderGroup(group, 'mailbox-org'))}
                            </div>
                        ) : null}
                    </div>
                ) : (
                    <div className="px-3 py-8 text-center">
                        <Mail className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                        <p className="text-xs font-medium text-foreground">No mailboxes found</p>
                        <p className="mt-1 text-xs text-muted-foreground">Try a different name, address, or domain.</p>
                    </div>
                )}

                {!isLoading && !searching && sections.otherCount > 0 ? (
                    <button
                        type="button"
                        onClick={() => setShowOthers(!showOthers)}
                        aria-expanded={showOthers}
                        className="mt-2 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <span className="min-w-0">
                            {showOthers
                                ? 'Hide mailboxes from other organizations'
                                : `Show mailboxes from other organizations (${sections.hiddenOtherCount})`}
                        </span>
                        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', showOthers ? 'rotate-180' : '')} />
                    </button>
                ) : null}
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
    const searchInputRef = React.useRef<HTMLInputElement>(null)

    // "g m" (handled in MailLayout) asks the switcher to focus its search box.
    React.useEffect(() => {
        const focusSearch = () => {
            if (collapsed) {
                setPopoverOpen(true)
                window.setTimeout(() => searchInputRef.current?.focus(), 60)
            } else {
                searchInputRef.current?.focus()
                searchInputRef.current?.select()
            }
        }
        window.addEventListener(FOCUS_MAILBOX_SEARCH_EVENT, focusSearch)
        return () => window.removeEventListener(FOCUS_MAILBOX_SEARCH_EVENT, focusSearch)
    }, [collapsed])

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
            searchInputRef={searchInputRef}
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
                <section className="border-b border-border bg-card/40" aria-label="Mailbox switcher">{panel}</section>
            )}

            <ConnectMailboxDialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen} />
        </>
    )
}
