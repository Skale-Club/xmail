import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'
import { formatRelativeDate } from '../../../lib/utils'
import type { InboxSyncStatusItem } from '../../../lib/unified-inbox-api'

interface InboxSyncStatusProps {
    syncStatus: InboxSyncStatusItem[]
    lastUpdatedAt: Date | null
    /** The list request itself failed (network/server) — degrade to an explicit stale marker. */
    isError?: boolean
    isFetching?: boolean
}

const CATEGORY_LABEL: Record<string, string> = {
    auth: 'Reconnect required',
    rate_limit: 'Provider rate limited',
    network: 'Network issue',
    provider_cursor: 'Sync reset needed',
    provider: 'Provider error',
}

/**
 * Sync-health footer for the filter rail. It reflects the sanitized per-account sync
 * status embedded in the Phase 21 list response (no cursor tokens / credentials). Because
 * near-real-time SSE is a later plan, this is a textual, color-independent health marker
 * with a "Last updated" timestamp — degraded accounts never rely on hue alone.
 */
export function InboxSyncStatus({ syncStatus, lastUpdatedAt, isError, isFetching }: InboxSyncStatusProps) {
    const degraded = syncStatus.filter((account) => account.degraded)
    const hasProblem = isError || degraded.length > 0

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
                    {isError ? 'Updates delayed' : hasProblem ? 'Sync degraded' : 'All accounts synced'}
                </span>
            </div>

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
