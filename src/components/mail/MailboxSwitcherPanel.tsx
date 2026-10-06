import React from 'react'
import { Link } from 'wouter'
import { AlertCircle, Check, ChevronDown, ChevronRight, Mail, Pin, Plus, Search, Settings, X } from 'lucide-react'
import { useMailbox, type Mailbox } from '../../hooks/useMailbox'
import { cn } from '../../lib/utils'
import {
    buildMailboxSections,
    formatUnreadBadge,
    mailboxDomain,
    mailboxLocalPart,
} from './mailbox-navigation'
import { useMailboxPreferences } from './useMailboxPreferences'

export interface MailboxSwitcherPanelProps {
    onSelect: (mailbox: Mailbox) => void
    onAdd: () => void
    onManage: () => void
    searchInputRef: React.RefObject<HTMLInputElement>
}

function MailboxOptionRow({
    id,
    mailbox,
    selected,
    active,
    pinned,
    onSelect,
    onTogglePin,
}: {
    id: string
    mailbox: Mailbox
    selected: boolean
    active: boolean
    pinned: boolean
    onSelect: () => void
    onTogglePin: () => void
}) {
    const unreadBadge = formatUnreadBadge(mailbox.unreadCount)
    const domain = mailboxDomain(mailbox.email)

    return (
        <div className="group flex min-w-0 items-center">
            <div
                id={id}
                role="option"
                aria-selected={selected}
                data-active={active ? 'true' : undefined}
                title={mailbox.displayName ? `${mailbox.displayName} <${mailbox.email}>` : mailbox.email}
                onClick={onSelect}
                className={cn(
                    'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                    selected && 'bg-primary/10 ring-1 ring-inset ring-primary/20',
                    active && !selected && 'bg-accent',
                    !selected && !active && 'hover:bg-accent/60',
                )}
            >
                <span className="min-w-0 flex-1 truncate">
                    <span className="font-semibold text-foreground">{mailboxLocalPart(mailbox.email)}</span>
                    <span className="text-muted-foreground">@{domain}</span>
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
                {selected ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
            </div>
            <button
                type="button"
                tabIndex={-1}
                onClick={onTogglePin}
                aria-pressed={pinned}
                aria-label={pinned ? `Unpin ${mailbox.email}` : `Pin ${mailbox.email}`}
                title={pinned ? 'Unpin' : 'Pin to top'}
                className={cn(
                    'ml-0.5 shrink-0 rounded-md p-1.5 transition-opacity hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    pinned ? 'text-primary opacity-100' : 'text-muted-foreground opacity-0 group-hover:opacity-100',
                )}
            >
                <Pin className={cn('h-3.5 w-3.5', pinned && 'fill-current')} />
            </button>
        </div>
    )
}

function SectionHeading({ id, label, count }: { id: string; label: string; count: number }) {
    return (
        <div className="flex items-center gap-2 px-2 pb-1 pt-2">
            <span id={id} className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">({count})</span>
        </div>
    )
}

function CollapsibleHeading({
    id,
    label,
    count,
    open,
    lockedOpen,
    onToggle,
}: {
    id: string
    label: string
    count: number
    open: boolean
    /** A search is running: the section is forced open and the toggle goes away. */
    lockedOpen: boolean
    onToggle: () => void
}) {
    if (lockedOpen) {
        return <SectionHeading id={id} label={label} count={count} />
    }
    const Chevron = open ? ChevronDown : ChevronRight
    return (
        <button
            type="button"
            id={id}
            onClick={onToggle}
            aria-expanded={open}
            className="flex w-full items-center gap-2 rounded-md px-2 pb-1 pt-2 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">({count})</span>
            <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                {open ? 'Hide' : 'Show'}
                <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
        </button>
    )
}

export function MailboxSwitcherPanel({ onSelect, onAdd, onManage, searchInputRef }: MailboxSwitcherPanelProps) {
    const { mailboxes, selectedMailbox, isLoading } = useMailbox()
    const { pinnedIds, togglePin, showOthers, setShowOthers, showWarmup, setShowWarmup } = useMailboxPreferences()
    const [query, setQuery] = React.useState('')
    const [activeId, setActiveId] = React.useState<string | null>(null)
    const idPrefix = React.useId()
    const listRef = React.useRef<HTMLDivElement>(null)
    const searching = query.trim().length > 0

    const sections = React.useMemo(
        () => buildMailboxSections(mailboxes, { query, pinnedIds, showWarmup, showOthers }),
        [mailboxes, query, pinnedIds, showWarmup, showOthers],
    )

    const visibleWarmup = sections.warmupOpen ? sections.warmup : []
    const visibleOther = sections.otherOpen ? sections.other : []
    // Render order = keyboard order.
    const visible = [...sections.pinned, ...sections.work, ...visibleWarmup, ...visibleOther]

    // Without a search the arrow keys start from the current mailbox; with one, from the best match.
    const selectedVisible = !searching && visible.some(item => item.id === selectedMailbox?.id)
    const defaultActiveId = (selectedVisible ? selectedMailbox?.id : visible[0]?.id) ?? null
    const effectiveActiveId = activeId && visible.some(item => item.id === activeId) ? activeId : defaultActiveId

    const optionId = (mailbox: Mailbox) => `${idPrefix}-option-${mailbox.id}`

    // Typing starts a new result list: forget the arrow-key position.
    React.useEffect(() => { setActiveId(null) }, [query])

    // Keep the active row (the selected mailbox on open) on screen inside the scroll area.
    React.useEffect(() => {
        if (!effectiveActiveId) return
        const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
        if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
    }, [effectiveActiveId, visible.length])

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (visible.length === 0) return
            const current = visible.findIndex(item => item.id === effectiveActiveId)
            const next = event.key === 'ArrowDown'
                ? Math.min(current + 1, visible.length - 1)
                : Math.max(current - 1, 0)
            setActiveId(visible[next].id)
        } else if (event.key === 'Enter') {
            event.preventDefault()
            const target = visible.find(item => item.id === effectiveActiveId)
            if (target) onSelect(target)
        }
    }

    const renderRow = (mailbox: Mailbox) => (
        <MailboxOptionRow
            key={mailbox.id}
            id={optionId(mailbox)}
            mailbox={mailbox}
            selected={selectedMailbox?.id === mailbox.id}
            active={effectiveActiveId === mailbox.id}
            pinned={pinnedIds.has(mailbox.id)}
            onSelect={() => onSelect(mailbox)}
            onTogglePin={() => togglePin(mailbox.id)}
        />
    )

    const activeMailbox = visible.find(item => item.id === effectiveActiveId)
    const listId = `${idPrefix}-list`

    return (
        <div className="flex max-h-[70vh] min-w-0 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-border p-2">
                <label className="relative block">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                        ref={searchInputRef}
                        type="text"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls={listId}
                        aria-activedescendant={activeMailbox ? optionId(activeMailbox) : undefined}
                        aria-autocomplete="list"
                        autoComplete="off"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Search mailboxes…"
                        aria-label="Search mailboxes"
                        className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-16 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                    />
                    {query ? (
                        <button
                            type="button"
                            onClick={() => { setQuery(''); searchInputRef.current?.focus() }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label="Clear mailbox search"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    ) : (
                        <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground">
                            Ctrl+K
                        </kbd>
                    )}
                </label>
            </div>

            <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label="Mailboxes"
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2 [scrollbar-gutter:stable]"
            >
                {isLoading ? (
                    <div className="space-y-1.5 px-1 py-2" aria-label="Loading mailboxes">
                        {Array.from({ length: 4 }, (_, index) => (
                            <div key={index} className="h-8 animate-pulse rounded-md bg-muted" />
                        ))}
                    </div>
                ) : (
                    <>
                        {sections.pinned.length > 0 ? (
                            <section aria-labelledby={`${idPrefix}-pinned`}>
                                <SectionHeading id={`${idPrefix}-pinned`} label="Pinned" count={sections.pinned.length} />
                                {sections.pinned.map(renderRow)}
                            </section>
                        ) : null}

                        {sections.work.length > 0 ? (
                            <section aria-labelledby={`${idPrefix}-work`}>
                                <SectionHeading id={`${idPrefix}-work`} label="Work" count={sections.work.length} />
                                {sections.work.map(renderRow)}
                            </section>
                        ) : null}

                        {sections.warmupCount > 0 ? (
                            <section aria-labelledby={`${idPrefix}-warmup`}>
                                <CollapsibleHeading
                                    id={`${idPrefix}-warmup`}
                                    label="Warm-up"
                                    count={sections.warmupCount}
                                    open={sections.warmupOpen}
                                    lockedOpen={searching}
                                    onToggle={() => setShowWarmup(!showWarmup)}
                                />
                                {visibleWarmup.map(renderRow)}
                            </section>
                        ) : null}

                        {sections.otherCount > 0 ? (
                            <section aria-labelledby={`${idPrefix}-other`}>
                                <CollapsibleHeading
                                    id={`${idPrefix}-other`}
                                    label="Other organizations"
                                    count={sections.otherCount}
                                    open={sections.otherOpen}
                                    lockedOpen={searching}
                                    onToggle={() => setShowOthers(!showOthers)}
                                />
                                {visibleOther.map(renderRow)}
                            </section>
                        ) : null}

                        {visible.length === 0 && (searching || mailboxes.length === 0) ? (
                            <div className="px-3 py-8 text-center">
                                <Mail className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                                <p className="text-xs font-medium text-foreground">No mailboxes found</p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {searching ? 'Try a different name, address, or domain.' : 'Add a mailbox to get started.'}
                                </p>
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            <div className="grid shrink-0 grid-cols-2 gap-1 border-t border-border p-1.5">
                <button
                    type="button"
                    onClick={onAdd}
                    className="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                >
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Add mailbox</span>
                </button>
                <Link
                    href="/mail/settings"
                    onClick={onManage}
                    className="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    <Settings className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Manage mailboxes</span>
                </Link>
            </div>
        </div>
    )
}
