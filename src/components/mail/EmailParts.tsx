import React from 'react'
import { Link } from 'wouter'
import { getAvatarColor, getInitials, formatDate } from '../../lib/utils'
import {
    Reply,
    ReplyAll,
    Forward,
    Star
} from 'lucide-react'

interface EmailHeaderProps {
    subject: string
    from: { name: string; email: string }
    to: { name: string; email: string }[]
    cc?: { name: string; email: string }[]
    date: Date
    starred?: boolean
    onStar?: () => void
}

export function EmailHeader({ subject, from, to, cc, date, starred, onStar }: EmailHeaderProps) {
    const avatarColor = getAvatarColor(from.email)
    const initials = getInitials(from.name || from.email)

    return (
        <>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground mb-4">
                {subject}
            </h1>

            <div className="flex items-start gap-3 sm:gap-4 mb-6">
                <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full ${avatarColor} flex items-center justify-center text-white font-semibold text-base sm:text-lg flex-shrink-0`}>
                    {initials}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                        <div>
                            <p className="font-semibold text-foreground">
                                {from.name || from.email}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {from.email}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <p className="text-sm text-muted-foreground">
                                {formatDate(date, 'MMM d, yyyy h:mm a')}
                            </p>
                            {onStar && (
                                <button
                                    onClick={onStar}
                                    className={`p-1 rounded transition-colors ${
                                        starred
                                            ? 'text-yellow-500 hover:text-yellow-600'
                                            : 'text-muted-foreground hover:text-foreground'
                                    }`}
                                >
                                    <Star className={`w-4 h-4 ${starred ? 'fill-current' : ''}`} />
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="mt-1">
                        <p className="text-sm text-muted-foreground">
                            To: {to.map(t => t.name || t.email).join(', ')}
                        </p>
                        {cc && cc.length > 0 && (
                            <p className="text-sm text-muted-foreground">
                                Cc: {cc.map(c => c.name || c.email).join(', ')}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </>
    )
}

interface EmailBodyProps {
    body: string
    className?: string
}

export function EmailBody({ body, className = '' }: EmailBodyProps) {
    return (
        <div className={`prose dark:prose-invert max-w-none ${className}`}>
            <div className="text-foreground whitespace-pre-wrap leading-relaxed">
                {body}
            </div>
        </div>
    )
}

interface EmailActionsProps {
    onReply?: () => void
    onReplyAll?: () => void
    onForward?: () => void
    replyHref?: string
    replyAllHref?: string
    forwardHref?: string
}

export function EmailActions({ onReply, onReplyAll, onForward, replyHref, replyAllHref, forwardHref }: EmailActionsProps) {
    const ButtonWrapper = ({ href, onClick, children }: { href?: string; onClick?: () => void; children: React.ReactNode }) => {
        if (href) {
            return (
                <Link
                    href={href}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                >
                    {children}
                </Link>
            )
        }
        return (
            <button
                onClick={onClick}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
            >
                {children}
            </button>
        )
    }

    return (
        <div className="mt-8 pt-6 border-t border-border">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
                <ButtonWrapper href={replyHref} onClick={onReply}>
                    <Reply className="w-4 h-4" />
                    Reply
                </ButtonWrapper>
                <Link
                    href={replyAllHref || '#'}
                    onClick={onReplyAll}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg font-medium transition-colors"
                >
                    <ReplyAll className="w-4 h-4" />
                    Reply All
                </Link>
                <Link
                    href={forwardHref || '#'}
                    onClick={onForward}
                    className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg font-medium transition-colors"
                >
                    <Forward className="w-4 h-4" />
                    Forward
                </Link>
            </div>
        </div>
    )
}

interface EmptyStateProps {
    icon: React.ReactNode
    title: string
    description?: string
    action?: React.ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-20">
            <div className="w-20 h-20 mb-4 rounded-full bg-muted flex items-center justify-center">
                {icon}
            </div>
            <p className="text-lg font-medium text-foreground">{title}</p>
            {description && <p className="text-sm mt-1">{description}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    )
}

interface LoadingStateProps {
    message?: string
}

export function LoadingState({ message = 'Loading...' }: LoadingStateProps) {
    return (
        <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-4">
                <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-muted-foreground">{message}</p>
            </div>
        </div>
    )
}

interface ErrorStateProps {
    title?: string
    message?: string
    onRetry?: () => void
    onBack?: () => void
}

export function ErrorState({ title = 'Error', message, onRetry, onBack }: ErrorStateProps) {
    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center">
                <p className="text-lg font-medium text-foreground">{title}</p>
                {message && (
                    <p className="text-sm text-muted-foreground mt-2">{message}</p>
                )}
                <div className="mt-4 flex items-center justify-center gap-3">
                    {onBack && (
                        <button
                            onClick={onBack}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg font-medium transition-colors"
                        >
                            Go Back
                        </button>
                    )}
                    {onRetry && (
                        <button
                            onClick={onRetry}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Try Again
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
