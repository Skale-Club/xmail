import React, { useState, useEffect } from 'react'
import { ThreadMessage, EmailThread, getThreadParticipants } from '../../lib/email-threading'
import { EmailHtmlViewer } from './EmailHtmlViewer'
import { SenderAuthBadge } from './SenderAuthBadge'
import { getSenderAuthStatus } from '../../lib/mail-auth-status'
import { getAvatarColor, getInitials } from '../../lib/utils'
import {
    ChevronDown,
    ChevronRight,
    Star,
    Mail,
    MailOpen,
    Reply,
    ReplyAll,
    Forward,
    Paperclip,
    Download,
    Sun,
    Moon
} from 'lucide-react'

interface EmailThreadProps {
    thread: EmailThread
    onReply?: (messageId: string) => void
    onReplyAll?: (messageId: string) => void
    onForward?: (messageId: string) => void
    onStar?: (messageId: string) => void
    onToggleRead?: (messageId: string, read: boolean) => void
}

export function EmailThreadView({ thread, onReply, onReplyAll, onForward, onStar, onToggleRead }: EmailThreadProps) {
    const [expandedMessages, setExpandedMessages] = React.useState<Set<string>>(() => {
        const expanded = new Set<string>()
        const lastMessage = thread.messages[thread.messages.length - 1]
        if (lastMessage) {
            expanded.add(lastMessage.id)
        }
        for (const msg of thread.messages) {
            if (!msg.read) {
                expanded.add(msg.id)
            }
        }
        return expanded
    })

    const toggleMessage = (id: string) => {
        setExpandedMessages(prev => {
            const newSet = new Set(prev)
            if (newSet.has(id)) {
                newSet.delete(id)
            } else {
                newSet.add(id)
            }
            return newSet
        })
    }

    const expandAll = () => {
        setExpandedMessages(new Set(thread.messages.map(m => m.id)))
    }

    const collapseAll = () => {
        setExpandedMessages(new Set([thread.messages[thread.messages.length - 1]?.id]))
    }

    const participants = getThreadParticipants(thread.messages)

    return (
        <div className="flex flex-col h-full">
            <div className="px-4 sm:px-6 py-4 border-b border-border">
                <div className="flex items-center justify-between mb-3">
                    <h1 className="text-xl sm:text-2xl font-bold text-foreground">
                        {thread.subject}
                    </h1>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={expandAll}
                            className="text-sm text-muted-foreground hover:text-foreground"
                        >
                            Expand all
                        </button>
                        <span className="text-border">|</span>
                        <button
                            onClick={collapseAll}
                            className="text-sm text-muted-foreground hover:text-foreground"
                        >
                            Collapse all
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">
                        {thread.messages.length} {thread.messages.length === 1 ? 'message' : 'messages'}
                    </span>
                    <span className="text-border">•</span>
                    <span className="text-sm text-muted-foreground">
                        {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
                    </span>
                    {thread.unreadCount > 0 && (
                        <>
                            <span className="text-border">•</span>
                            <span className="text-sm font-medium text-primary">
                                {thread.unreadCount} unread
                            </span>
                        </>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto py-4 sm:py-6 px-4 sm:px-6">
                    <div className="space-y-2">
                        {thread.messages.map((message) => (
                            <ThreadMessageCard
                                key={message.id}
                                message={message}
                                isExpanded={expandedMessages.has(message.id)}
                                onToggle={() => toggleMessage(message.id)}
                                onReply={onReply}
                                onReplyAll={onReplyAll}
                                onForward={onForward}
                                onStar={onStar}
                                onToggleRead={onToggleRead}
                            />
                        ))}
                    </div>

                    <div className="mt-8 pt-6 border-t border-border">
                        <button
                            onClick={() => onReply?.(thread.messages[thread.messages.length - 1].id)}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            <Reply className="w-4 h-4" />
                            Reply to thread
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

interface ThreadMessageCardProps {
    message: ThreadMessage
    isExpanded: boolean
    onToggle: () => void
    onReply?: (messageId: string) => void
    onReplyAll?: (messageId: string) => void
    onForward?: (messageId: string) => void
    onStar?: (messageId: string) => void
    onToggleRead?: (messageId: string, read: boolean) => void
}

function ThreadMessageCard({
    message,
    isExpanded,
    onToggle,
    onReply,
    onReplyAll,
    onForward,
    onStar,
    onToggleRead
}: ThreadMessageCardProps) {
    const avatarColor = getAvatarColor(message.from.email)
    const initials = getInitials(message.from.name || message.from.email)
    const authStatus = getSenderAuthStatus(message.headers)
    const [emailDarkMode, setEmailDarkMode] = useState(false)

    useEffect(() => {
        setEmailDarkMode(false)
    }, [message.id])

    return (
        <div
            className={`
                rounded-xl border transition-all duration-200
                ${isExpanded
                    ? 'border-border bg-card shadow-sm'
                    : 'border-border bg-muted/30 hover:bg-muted/50'
                }
                ${!message.read ? 'border-l-4 border-l-primary' : ''}
            `}
        >
            <button
                onClick={onToggle}
                className="w-full px-4 py-3 text-left"
            >
                <div className="flex items-start gap-3">
                    <div
                        className={`w-10 h-10 rounded-full ${avatarColor} flex items-center justify-center text-primary-foreground font-semibold text-sm flex-shrink-0`}
                    >
                        {initials}
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <span className={`truncate ${!message.read ? 'font-semibold text-foreground' : 'text-foreground/80'}`}>
                                    {message.from.name || message.from.email}
                                </span>
                                {authStatus && <SenderAuthBadge status={authStatus} className="flex-shrink-0" />}
                                {isExpanded ? (
                                    <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                ) : (
                                    <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                                )}
                            </div>
                            <span className="text-xs text-muted-foreground flex-shrink-0">
                                {message.date.toLocaleDateString()} {message.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                        </div>

                        {!isExpanded && (
                            <p className="text-sm text-muted-foreground truncate mt-0.5">
                                {message.snippet.slice(0, 100)}{message.snippet.length > 100 ? '...' : ''}
                            </p>
                        )}

                        {isExpanded && message.to.length > 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                                To: {message.to.map(t => t.name || t.email).join(', ')}
                            </p>
                        )}
                    </div>

                    <div className="flex items-center gap-1">
                        {message.starred && (
                            <Star className="w-4 h-4 text-yellow-500 fill-current" />
                        )}
                        {message.attachments && message.attachments.length > 0 && (
                            <Paperclip className="w-4 h-4 text-muted-foreground" />
                        )}
                    </div>
                </div>
            </button>

            {isExpanded && (
                <div className="px-4 pb-4">
                    <div className="flex items-center justify-end mb-2 pl-13">
                        <button
                            onClick={() => setEmailDarkMode(!emailDarkMode)}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title={emailDarkMode ? 'Light mode' : 'Dark mode'}
                        >
                            {emailDarkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                            {emailDarkMode ? 'Light' : 'Dark'}
                        </button>
                    </div>
                    <div className="pl-13">
                        <EmailHtmlViewer
                            html={message.htmlBody}
                            plainText={message.body || message.snippet}
                            emailDarkMode={emailDarkMode}
                        />
                    </div>

                    {message.attachments && message.attachments.length > 0 && (
                        <div className="mt-4 pl-13">
                            <div className="flex flex-wrap gap-2">
                                {message.attachments.map((attachment, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg text-sm"
                                    >
                                        <Paperclip className="w-4 h-4 text-muted-foreground" />
                                        <span className="text-foreground">{attachment.name}</span>
                                        <span className="text-muted-foreground text-xs">({attachment.size})</span>
                                        <Download className="w-4 h-4 text-muted-foreground cursor-pointer hover:text-foreground" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="mt-4 pl-13 flex items-center gap-2">
                        <button
                            onClick={() => onReply?.(message.id)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted rounded-lg transition-colors"
                        >
                            <Reply className="w-4 h-4" />
                            Reply
                        </button>
                        <button
                            onClick={() => onReplyAll?.(message.id)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted rounded-lg transition-colors"
                        >
                            <ReplyAll className="w-4 h-4" />
                            Reply All
                        </button>
                        <button
                            onClick={() => onForward?.(message.id)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted rounded-lg transition-colors"
                        >
                            <Forward className="w-4 h-4" />
                            Forward
                        </button>
                        <button
                            onClick={() => onStar?.(message.id)}
                            className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                message.starred
                                    ? 'text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
                                    : 'text-muted-foreground hover:bg-muted'
                            }`}
                        >
                            <Star className={`w-4 h-4 ${message.starred ? 'fill-current' : ''}`} />
                        </button>
                        {onToggleRead && (
                            <button
                                onClick={() => onToggleRead(message.id, !message.read)}
                                className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                                    message.read
                                        ? 'text-muted-foreground hover:bg-muted'
                                        : 'text-primary hover:bg-primary/10'
                                }`}
                                title={message.read ? 'Mark as unread' : 'Mark as read'}
                            >
                                {message.read ? <Mail className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
