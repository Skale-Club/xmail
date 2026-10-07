import { ArrowLeft } from 'lucide-react'

interface DetailBackBarProps {
    /** Folder the Back button returns to, shown next to the arrow. */
    label: string
    onBack: () => void
}

/**
 * Header for the message drawer shown when the window is too narrow for list and reader side by
 * side. Mirrors the Back affordance of the full-page message view (EmailDetailPage): arrow button
 * plus the folder name.
 */
export function DetailBackBar({ label, onBack }: DetailBackBarProps) {
    return (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-4 py-3">
            <button
                type="button"
                onClick={onBack}
                data-drawer-back
                aria-label={`Back to ${label}`}
                className="rounded-lg p-2 transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <ArrowLeft className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </button>
            <span className="text-sm text-muted-foreground">{label}</span>
        </div>
    )
}
