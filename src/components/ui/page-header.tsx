import * as React from 'react'
import { cn } from '../../lib/utils'

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
    title: React.ReactNode
    description?: React.ReactNode
    actions?: React.ReactNode
}

// Single h1 scale used across admin/mail/outreach pages: text-2xl font-semibold
// tracking-tight. Introduced to stop each page hand-rolling its own header markup
// (and its own heading size) — see CLAUDE.md design-system-unification notes.
const PageHeader = React.forwardRef<HTMLDivElement, PageHeaderProps>(
    ({ className, title, description, actions, ...props }, ref) => {
        return (
            <div
                ref={ref}
                className={cn(
                    'flex flex-col gap-4 pb-6 sm:flex-row sm:items-center sm:justify-between',
                    className
                )}
                {...props}
            >
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground truncate">
                        {title}
                    </h1>
                    {description && (
                        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                    )}
                </div>
                {actions && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
                )}
            </div>
        )
    }
)
PageHeader.displayName = 'PageHeader'

export { PageHeader }
