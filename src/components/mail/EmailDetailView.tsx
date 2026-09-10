import React, { useState, useEffect } from 'react'
import { EmailItem } from './EmailList'
import { EmailHtmlViewer } from './EmailHtmlViewer'
import { useMessage } from '../../hooks/useMail'
import { useCompose } from '../../hooks/useCompose'
import { Reply, ReplyAll, Forward, Paperclip } from 'lucide-react'
import { EmailMessageHeader } from './EmailMessageHeader'

interface EmailDetailViewProps {
    email: EmailItem
    onStar?: (id: string) => void
    onDelete?: (id: string) => void
    onArchive?: (id: string) => void
    onSpam?: (id: string) => void
    isSpam?: boolean
    onToggleRead?: (id: string) => void
    archiveTitle?: string
    archiveAriaLabel?: string
    archiveIcon?: 'archive' | 'inbox'
    /** Which of the reply/reply-all/forward buttons to show. Defaults to all three
     *  (Inbox/Archive/Starred). Sent only forwards; Spam shows none of them. */
    replyActions?: 'all' | 'forwardOnly' | 'none'
}

export function EmailDetailView({
    email,
    onStar,
    onDelete,
    onArchive,
    onSpam,
    isSpam,
    onToggleRead,
    archiveTitle,
    archiveAriaLabel,
    archiveIcon,
    replyActions = 'all',
}: EmailDetailViewProps) {
    const { openCompose } = useCompose()
    const { data: messageData, isLoading: isMessageLoading } = useMessage(email.id)
    const fullMessage = messageData?.message
    const [emailDarkMode, setEmailDarkMode] = useState(false)

    useEffect(() => {
        setEmailDarkMode(false)
    }, [email.id])

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="p-4">
                <div className="max-w-3xl mx-auto">
                    <h2 className="text-base font-bold text-foreground mb-3">
                        {email.subject}
                    </h2>

                    <EmailMessageHeader
                        from={email.from}
                        to={email.to}
                        date={email.date}
                        read={email.read}
                        starred={email.starred}
                        isSpam={isSpam}
                        onToggleRead={onToggleRead ? () => onToggleRead(email.id) : undefined}
                        onArchive={onArchive ? () => onArchive(email.id) : undefined}
                        onSpam={onSpam ? () => onSpam(email.id) : undefined}
                        onDelete={onDelete ? () => onDelete(email.id) : undefined}
                        onStar={onStar ? () => onStar(email.id) : undefined}
                        archiveTitle={archiveTitle}
                        archiveAriaLabel={archiveAriaLabel}
                        archiveIcon={archiveIcon}
                        emailDarkMode={emailDarkMode}
                        onToggleEmailDarkMode={() => setEmailDarkMode(!emailDarkMode)}
                    />

                    {email.labels && email.labels.length > 0 && (
                        <div className="flex items-center gap-2 mt-4 mb-6">
                            {email.labels.map(label => (
                                <span
                                    key={label}
                                    className="px-2.5 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground font-medium"
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                    )}

                    <div className="mt-4">
                        <EmailHtmlViewer
                            html={fullMessage?.bodyHtml || fullMessage?.htmlBody}
                            plainText={fullMessage?.bodyText || fullMessage?.plainBody || email.snippet}
                            emailDarkMode={emailDarkMode}
                            isLoading={isMessageLoading}
                            senderEmail={email.from.email}
                        />
                    </div>

                    {email.hasAttachments && (
                        <div className="mt-6 p-4 bg-muted/30 rounded-lg">
                            <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                                <Paperclip className="w-4 h-4" />
                                Attachments
                            </h3>
                            <div className="flex flex-wrap gap-2">
                                <div className="flex items-center gap-2 px-3 py-2 bg-background rounded-lg border border-border">
                                    <Paperclip className="w-4 h-4 text-muted-foreground" />
                                    <span className="text-sm text-foreground">Attachment</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {replyActions !== 'none' && (
                        <div className="mt-8 pt-6 border-t border-border">
                            <div className="flex items-center gap-3">
                                {replyActions === 'all' && (
                                    <>
                                        <button
                                            onClick={() => openCompose({ replyToId: email.id })}
                                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors"
                                        >
                                            <Reply className="w-4 h-4" />
                                            Reply
                                        </button>
                                        <button
                                            onClick={() => openCompose({ replyToId: email.id, replyAll: true })}
                                            className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg text-sm font-medium transition-colors"
                                        >
                                            <ReplyAll className="w-4 h-4" />
                                            Reply All
                                        </button>
                                    </>
                                )}
                                <button
                                    onClick={() => openCompose({ forwardId: email.id })}
                                    className={
                                        replyActions === 'forwardOnly'
                                            ? 'inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors'
                                            : 'inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg text-sm font-medium transition-colors'
                                    }
                                >
                                    <Forward className="w-4 h-4" />
                                    Forward
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

interface EmailDetailEmptyProps {
    icon?: React.ReactNode
    title?: string
    description?: string
}

export function EmailDetailEmpty({ 
    icon, 
    title = 'Select an email to read', 
    description = "Click on an email from the list to view its contents" 
}: EmailDetailEmptyProps) {
    return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
                {icon ? (
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent flex items-center justify-center">
                        {icon}
                    </div>
                ) : (
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent flex items-center justify-center">
                        <svg className="w-8 h-8 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                    </div>
                )}
                <p className="text-base font-medium text-foreground">{title}</p>
                <p className="text-sm mt-1">{description}</p>
            </div>
        </div>
    )
}
