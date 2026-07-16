import React from 'react'
import { Archive, Clock, Inbox as InboxIcon, Plus, Reply, Tag, X } from 'lucide-react'
import {
    activeFilterCount,
    activeQuickView,
    quickViewPatch,
    type InboxQuickView,
    type InboxUrlState,
} from '../../../lib/unified-inbox-url'
import type {
    InboxAccountOption,
    InboxCampaignOption,
    InboxLabel,
    InboxSyncStatusItem,
} from '../../../lib/unified-inbox-api'
import { cn } from '../../../lib/utils'
import { InboxSyncStatus } from './InboxSyncStatus'
import type { InboxRealtimeStatus } from '../../../hooks/useUnifiedInboxEvents'

interface InboxFilterRailProps {
    state: InboxUrlState
    onPatch: (patch: Partial<InboxUrlState>) => void
    onClearFilters: () => void
    unreadCount?: number
    labels: InboxLabel[]
    labelsLoading?: boolean
    campaigns: InboxCampaignOption[]
    accounts: InboxAccountOption[]
    syncStatus: InboxSyncStatusItem[]
    lastUpdatedAt: Date | null
    syncError?: boolean
    syncFetching?: boolean
    /** Near-real-time channel status (from the single SSE stream). */
    realtimeStatus?: InboxRealtimeStatus
    /** The live stream was lost — updates are delayed and the bounded polling fallback is active. */
    realtimeStale?: boolean
    /** Create a named label for this organization (labels are named operator controls). */
    onCreateLabel?: (name: string) => void
    creatingLabel?: boolean
    /** `overlay` is the tablet/mobile sheet variant; `rail` is the fixed desktop column. */
    variant?: 'rail' | 'overlay'
}

interface QuickView {
    key: InboxQuickView
    label: string
    icon: React.ReactNode
}

const QUICK_VIEWS: QuickView[] = [
    { key: 'inbox', label: 'Inbox', icon: <InboxIcon className="h-4 w-4" aria-hidden="true" /> },
    { key: 'unread', label: 'Unread', icon: <Reply className="h-4 w-4" aria-hidden="true" /> },
    { key: 'needs_reply', label: 'Needs reply', icon: <Reply className="h-4 w-4" aria-hidden="true" /> },
    { key: 'reminders', label: 'Reminders', icon: <Clock className="h-4 w-4" aria-hidden="true" /> },
    { key: 'archived', label: 'Archived', icon: <Archive className="h-4 w-4" aria-hidden="true" /> },
]

export function InboxFilterRail({
    state,
    onPatch,
    onClearFilters,
    unreadCount,
    labels,
    labelsLoading,
    campaigns,
    accounts,
    syncStatus,
    lastUpdatedAt,
    syncError,
    syncFetching,
    realtimeStatus,
    realtimeStale,
    onCreateLabel,
    creatingLabel,
    variant = 'rail',
}: InboxFilterRailProps) {
    const currentView = activeQuickView(state)
    const filterCount = activeFilterCount(state)
    const [newLabel, setNewLabel] = React.useState('')

    const submitNewLabel = () => {
        const name = newLabel.trim()
        if (!name || !onCreateLabel) return
        onCreateLabel(name)
        setNewLabel('')
    }

    return (
        <nav
            aria-label="Conversation filters"
            className={cn(
                'flex h-full flex-col bg-card',
                variant === 'rail' ? 'w-56 border-r border-border' : 'w-full',
            )}
        >
            <div className="flex-1 overflow-y-auto p-3">
                {/* Quick views */}
                <ul className="space-y-1">
                    {QUICK_VIEWS.map((view) => {
                        const active = currentView === view.key
                        return (
                            <li key={view.key}>
                                <button
                                    type="button"
                                    onClick={() => onPatch(quickViewPatch(view.key))}
                                    aria-current={active ? 'true' : undefined}
                                    className={cn(
                                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        active
                                            ? 'bg-accent text-accent-foreground'
                                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                                    )}
                                >
                                    {view.icon}
                                    <span className="flex-1 text-left">{view.label}</span>
                                    {/* Persistent polite live region so unread-count changes
                                        (SSE/poll driven) are announced to screen readers. */}
                                    {view.key === 'unread' && (
                                        <span aria-live="polite" aria-atomic="true">
                                            {unreadCount != null && unreadCount > 0 && (
                                                <span
                                                    className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none text-primary-foreground"
                                                    aria-label={`${unreadCount} unread`}
                                                >
                                                    <span aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>
                                                </span>
                                            )}
                                        </span>
                                    )}
                                </button>
                            </li>
                        )
                    })}
                </ul>

                {/* Refinement filters */}
                <div className="mt-4 space-y-3">
                    <div>
                        <label htmlFor="inbox-filter-campaign" className="mb-1 block text-xs font-medium text-muted-foreground">
                            Campaign
                        </label>
                        <select
                            id="inbox-filter-campaign"
                            value={state.campaign ?? ''}
                            onChange={(event) => onPatch({ campaign: event.target.value || undefined })}
                            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <option value="">All campaigns</option>
                            {campaigns.map((campaign) => (
                                <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="inbox-filter-account" className="mb-1 block text-xs font-medium text-muted-foreground">
                            Sending account
                        </label>
                        <select
                            id="inbox-filter-account"
                            value={state.account ?? ''}
                            onChange={(event) => onPatch({ account: event.target.value || undefined })}
                            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <option value="">All accounts</option>
                            {accounts.map((account) => (
                                <option key={account.id} value={account.id}>{account.email}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Labels */}
                <div className="mt-4">
                    <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        <Tag className="h-3.5 w-3.5" aria-hidden="true" /> Labels
                    </p>
                    {onCreateLabel && (
                        <form
                            className="mb-2 flex items-center gap-1"
                            onSubmit={(event) => { event.preventDefault(); submitNewLabel() }}
                        >
                            <input
                                type="text"
                                value={newLabel}
                                onChange={(event) => setNewLabel(event.target.value)}
                                placeholder="New label"
                                aria-label="New label name"
                                maxLength={80}
                                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                            <button
                                type="submit"
                                aria-label="Create label"
                                disabled={creatingLabel || newLabel.trim().length === 0}
                                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                            >
                                <Plus className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </form>
                    )}
                    {labelsLoading ? (
                        <p className="px-1 text-sm text-muted-foreground">Loading labels…</p>
                    ) : labels.length === 0 ? (
                        <p className="px-1 text-sm text-muted-foreground">No labels yet</p>
                    ) : (
                        <ul className="space-y-0.5">
                            {labels.map((label) => {
                                const active = state.labels.includes(label.id)
                                return (
                                    <li key={label.id}>
                                        <button
                                            type="button"
                                            onClick={() => onPatch({ labels: active ? [] : [label.id] })}
                                            aria-pressed={active}
                                            className={cn(
                                                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                active
                                                    ? 'bg-accent text-accent-foreground'
                                                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                                            )}
                                        >
                                            <span
                                                className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
                                                style={label.color ? { backgroundColor: label.color } : undefined}
                                                aria-hidden="true"
                                            />
                                            <span className="flex-1 truncate text-left">{label.name}</span>
                                        </button>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>

                {filterCount > 0 && (
                    <button
                        type="button"
                        onClick={onClearFilters}
                        className="mt-4 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                        Clear filters ({filterCount})
                    </button>
                )}
            </div>

            <InboxSyncStatus
                syncStatus={syncStatus}
                lastUpdatedAt={lastUpdatedAt}
                isError={syncError}
                isFetching={syncFetching}
                realtimeStatus={realtimeStatus}
                realtimeStale={realtimeStale}
            />
        </nav>
    )
}

export default InboxFilterRail
