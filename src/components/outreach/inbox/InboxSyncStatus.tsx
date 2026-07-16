import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { formatRelativeDate } from '../../../lib/utils'
import type { InboxSyncStatusItem } from '../../../lib/unified-inbox-api'
import type { InboxRealtimeStatus } from '../../../hooks/useUnifiedInboxEvents'

interface InboxSyncStatusProps {
    syncStatus: InboxSyncStatusItem[]
    lastUpdatedAt: Date | null
    /** The list request itself failed (network/server) — degrade to an explicit stale marker. */
    isError?: boolean
    isFetching?: boolean
    /** Near-real-time channel status (from the single SSE stream). */
    realtimeStatus?: InboxRealtimeStatus
    /** The live stream was lost — updates are delayed and the bounded polling fallback is active. */
    realtimeStale?: boolean
}

const CATEGORY_LABEL: Record<string, string> = {
    auth: 'Reconnect required',
    rate_limit: 'Provider rate limited',
    network: 'Network issue',
    provider_cursor: 'Sync reset needed',
    provider: 'Provider error',
}

/**
 * Sync-health footer for the filter rail. It combines two independent signals, both
 * color-independent (text + icon, never hue alone):
 *   1. per-account provider sync health (sanitized; no cursor tokens / credentials), and
 *   2. the near-real-time channel status — when the authenticated SSE stream is lost we show
 *      "Updates delayed" and rely on the bounded polling fallback, so existing conversations
 *      stay readable and the operator knows updates are periodic, not live.
 */
export function InboxSyncStatus({
    syncStatus,
    lastUpdatedAt,
    isError,
    isFetching,
    realtimeStatus,
    realtimeStale,
}: InboxSyncStatusProps) {
    const degraded = syncStatus.filter((account) => account.degraded)
    // "Updates delayed" = the list request failed OR the live stream is down (reconnecting/polling).
    const updatesDelayed = Boolean(isError) || Boolean(realtimeStale)
    const hasProblem = updatesDelayed || degraded.length > 0

    const headline = updatesDelayed
        ? 'Updates delayed'
        : hasProblem
            ? 'Sync degraded'
            : realtimeStatus === 'live'
                ? 'Live'
                : 'All accounts synced'

    return (
        <div className="border-t border-border p-3 text-xs" aria-live="polite">
            <div className="flex items-center gap-2">
                {isFetching ? (
                    <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                ) : hasProblem ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                )}
                <span className={hasProblem ? 'font-medium text-amber-700 dark:text-amber-400' : 'font-medium text-muted-foreground'}>
                    {headline}
                </span>
            </div>

            {updatesDelayed && (
                <p className="mt-1 text-muted-foreground">
                    Reconnecting — refreshing periodically. Conversations remain readable.
                </p>
            )}

            {degraded.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                    {degraded.map((account) => (
                        <li key={account.emailAccountId} className="truncate">
                            <span className="capitalize">{account.provider}</span>
                            {account.errorCategory ? ` — ${CATEGORY_LABEL[account.errorCategory] ?? 'Provider error'}` : ' — degraded'}
                        </li>
                    ))}
                </ul>
            )}

            {lastUpdatedAt && (
                <p className="mt-1.5 text-muted-foreground">
                    Last updated {formatRelativeDate(lastUpdatedAt)}
                </p>
            )}
        </div>
    )
}

export default InboxSyncStatus
