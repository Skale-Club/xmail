import * as React from 'react'
import { CheckCircle2, HelpCircle, MinusCircle, ShieldQuestion, XCircle } from 'lucide-react'
import { Badge } from '../ui/Badge'
import { cn, formatDate } from '../../lib/utils'
import { APP_CONSTANTS } from '../../lib/constants'

// Provider-neutral email deliverability verification, populated at lead import time from
// Xphere's enrichment data (src/db/schema.ts leads.emailVerificationStatus, migration 046).
// This is DISTINCT from the inbound sender-authentication signal (SPF/DKIM/DMARC) shown in
// the webmail inbox — see src/components/mail/SenderAuthBadge.tsx for that one. Do not conflate.
export type LeadEmailVerificationStatus = 'unknown' | 'verified' | 'likely' | 'unavailable' | 'invalid'

export interface LeadVerificationBadgeProps {
    status: LeadEmailVerificationStatus
    verifiedAt?: string | Date | null
    provider?: string | null
    className?: string
}

const STATUS_CONFIG: Record<
    LeadEmailVerificationStatus,
    { label: string; icon: React.ComponentType<{ className?: string }>; className: string; tooltip?: string }
> = {
    verified: {
        label: 'Verified',
        icon: CheckCircle2,
        className: 'border-transparent bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    },
    likely: {
        label: 'Likely',
        icon: ShieldQuestion,
        className: 'border-transparent bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
        tooltip: 'Catch-all or unconfirmed — sendable, with risk.',
    },
    invalid: {
        label: 'Invalid',
        icon: XCircle,
        className: 'border-transparent bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
        tooltip: 'Blocked — will not be sent.',
    },
    unavailable: {
        label: 'Unavailable',
        icon: MinusCircle,
        className: 'border-transparent bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
    },
    unknown: {
        label: 'Not verified',
        icon: HelpCircle,
        className: '',
    },
}

/**
 * Shared status badge for `leads.emailVerificationStatus`. Mirrors the existing
 * `<Badge variant="..." className="...">` + lucide-icon pattern used elsewhere (e.g.
 * src/pages/admin/IntegrationsPage.tsx connection-status badges) rather than introducing a
 * new design system — this repo has no dedicated Tooltip primitive, so the tooltip is the
 * same native `title` attribute used throughout (see src/components/mail/EmailMessageHeader.tsx).
 */
export function LeadVerificationBadge({ status, verifiedAt, provider, className }: LeadVerificationBadgeProps) {
    const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.unknown
    const Icon = config.icon

    const tooltipParts: string[] = []
    if (config.tooltip) tooltipParts.push(config.tooltip)
    if (verifiedAt) {
        tooltipParts.push(`Verified on ${formatDate(verifiedAt, APP_CONSTANTS.DATE_FORMATS.DISPLAY_WITH_TIME)}`)
    }
    if (provider) tooltipParts.push(`Source: ${provider}`)
    const tooltip = tooltipParts.length > 0 ? tooltipParts.join(' — ') : undefined

    return (
        <Badge
            variant={status === 'unknown' ? 'outline' : 'default'}
            className={cn('gap-1 whitespace-nowrap font-medium', config.className, className)}
            title={tooltip}
        >
            <Icon className="h-3 w-3" />
            {config.label}
        </Badge>
    )
}
