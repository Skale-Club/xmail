import { ShieldAlert, ShieldCheck } from 'lucide-react'
import type { SenderAuthStatus } from '../../lib/mail-auth-status'

interface SenderAuthBadgeProps {
    status: SenderAuthStatus
    className?: string
}

/**
 * Anti-phishing indicator for inbound mail, driven by the persisted SPF/DKIM/DMARC
 * Authentication-Results header (see src/lib/mail-auth-status.ts). Renders nothing when the
 * signal is absent or unparseable — never claims verification the data doesn't support.
 */
export function SenderAuthBadge({ status, className }: SenderAuthBadgeProps) {
    if (status === 'pass') {
        return (
            <span
                className={`inline-flex items-center text-green-600 dark:text-green-400 ${className || ''}`}
                title="Remetente verificado — SPF/DKIM/DMARC aprovados"
                aria-label="Remetente verificado"
            >
                <ShieldCheck className="h-3.5 w-3.5" />
            </span>
        )
    }

    if (status === 'fail') {
        return (
            <span
                className={`inline-flex items-center text-red-600 dark:text-red-400 ${className || ''}`}
                title="Falha na autenticação do remetente — possível phishing"
                aria-label="Falha na autenticação do remetente"
            >
                <ShieldAlert className="h-3.5 w-3.5" />
            </span>
        )
    }

    return null
}
