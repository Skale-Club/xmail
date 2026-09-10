import * as React from 'react'
import { cn } from '../../lib/utils'

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
    icon?: React.ReactNode
    title: string
    description?: React.ReactNode
    action?: React.ReactNode
}

// Shared empty-state shell. Was previously duplicated as a local component in
// src/components/mail/EmailParts.tsx — that file now re-exports this one.
const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
    ({ className, icon, title, description, action, ...props }, ref) => {
        return (
            <div
                ref={ref}
                className={cn(
                    'flex flex-col items-center justify-center h-full text-center text-muted-foreground py-20',
                    className
                )}
                {...props}
            >
                {icon && (
                    <div className="w-20 h-20 mb-4 rounded-full bg-muted flex items-center justify-center">
                        {icon}
                    </div>
                )}
                <p className="text-lg font-medium text-foreground">{title}</p>
                {description && <p className="text-sm mt-1">{description}</p>}
                {action && <div className="mt-4">{action}</div>}
            </div>
        )
    }
)
EmptyState.displayName = 'EmptyState'

export { EmptyState }
