import type { MailboxRealtimeStatus } from '../../hooks/useMailboxEvents'

interface LiveIndicatorProps {
    status: MailboxRealtimeStatus
}

/**
 * Tiny live-updates marker for the folder toolbar. Text plus a dot (never colour alone). The label
 * collapses to the dot on narrow toolbars; the title and the screen-reader text carry the meaning.
 */
export function LiveIndicator({ status }: LiveIndicatorProps) {
    const live = status === 'live'
    const label = live ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
    const title = live
        ? 'Live: new mail appears as soon as it arrives.'
        : 'Live updates are paused. This list still checks for new mail every 30 seconds.'

    return (
        <span
            className="inline-flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
            title={title}
            data-testid="mailbox-live-indicator"
            data-status={status}
        >
            <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`}
            />
            <span className="hidden sm:inline">{label}</span>
            <span className="sr-only sm:hidden">{label}</span>
        </span>
    )
}
