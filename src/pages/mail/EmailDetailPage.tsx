import React, { useState, useEffect } from 'react'
import { Link, useParams, useLocation } from 'wouter'
import { MailLayout } from '../../components/mail/MailLayout'
import { toast } from '../../components/ui/toaster'
import { useMailbox } from '../../hooks/useMailbox'
import { useCompose } from '../../hooks/useCompose'
import { useMessage, useUpdateMessage, useDeleteMessage, useArchiveMessage, useSpamMessage, mapMessageToEmailItem } from '../../hooks/useMail'
import { EmailHtmlViewer } from '../../components/mail/EmailHtmlViewer'
import { EmailMessageHeader } from '../../components/mail/EmailMessageHeader'
import { EmailThreadView } from '../../components/mail/EmailThread'
import { EmailThread, ThreadMessage } from '../../lib/email-threading'
import {
    ArrowLeft,
    Star,
    Mail,
    MailOpen,
    Trash2,
    Archive,
    Reply,
    ReplyAll,
    Forward,
    MoreVertical,
    Paperclip,
    Download,
    AlertCircle,
    Loader2,
    MessagesSquare
} from 'lucide-react'

const mockEmails: Record<string, { subject: string; body: string; from: { name: string; email: string }; to: { name: string; email: string }[]; date: Date; starred: boolean; attachments?: { name: string; size: string; type: string }[] }> = {
    '1': {
        subject: 'Welcome to Xmail!',
        body: `Dear User,

Thank you for using Xmail! We are thrilled to have you as part of our growing community.

Here's what you can do with your new email account:

1. Send and receive emails professionally
2. Organize your inbox with folders and labels
3. Track email opens and clicks
4. Create email templates for faster composing
5. Set up webhooks for automated workflows

If you have any questions or need assistance, don't hesitate to reach out to our support team.

Best regards,
The Skale Club Team

---
Xmail - Professional Email Made Simple
Website: https://skaleclub.com
Support: support@skaleclub.com`,
        from: { name: 'Skale Club Team', email: 'noreply@skaleclub.com' },
        to: [{ name: 'User', email: 'user@skaleclub.com' }],
        date: new Date(),
        starred: true,
        attachments: [
            { name: 'getting-started.pdf', size: '245 KB', type: 'pdf' },
            { name: 'welcome-guide.pdf', size: '1.2 MB', type: 'pdf' }
        ]
    },
    '2': {
        subject: 'Meeting Tomorrow at 10 AM',
        body: `Hi team,

Just a reminder about our weekly sync meeting tomorrow at 10 AM. Please come prepared with your updates.

Agenda:
1. Sprint review
2. Blockers discussion
3. Planning for next week

See you there!

Best,
John`,
        from: { name: 'John Smith', email: 'john.smith@company.com' },
        to: [{ name: 'User', email: 'user@skaleclub.com' }],
        date: new Date(Date.now() - 3600000),
        starred: false,
    },
    'thread-1': {
        subject: 'Re: Project Discussion',
        body: `Thanks for the update! I think we should proceed with option A.

Let me know your thoughts.

Best,
Sarah`,
        from: { name: 'Sarah Johnson', email: 'sarah@company.com' },
        to: [{ name: 'User', email: 'user@skaleclub.com' }],
        date: new Date(Date.now() - 7200000),
        starred: false,
    }
}

const mockThreads: Record<string, EmailThread> = {
    'thread-1': {
        threadId: 'thread-1',
        subject: 'Project Discussion',
        messages: [
            {
                id: 'msg-1',
                from: { name: 'John Smith', email: 'john@company.com' },
                to: [{ name: 'Team', email: 'team@company.com' }],
                date: new Date(Date.now() - 86400000),
                subject: 'Project Discussion',
                body: 'Hi team,\n\nI wanted to start a discussion about our upcoming project. We have two options:\n\n1. Build from scratch\n2. Use existing framework\n\nWhat do you think?',
                snippet: 'I wanted to start a discussion about our upcoming project...',
                read: true,
                starred: false,
                messageId: 'msg-1'
            },
            {
                id: 'msg-2',
                from: { name: 'Sarah Johnson', email: 'sarah@company.com' },
                to: [{ name: 'Team', email: 'team@company.com' }],
                date: new Date(Date.now() - 43200000),
                subject: 'Re: Project Discussion',
                body: 'Hi John,\n\nI think option 2 would be faster, but option 1 gives us more flexibility.\n\nLet\'s discuss in our next meeting.\n\nSarah',
                snippet: 'I think option 2 would be faster, but option 1 gives us more flexibility...',
                read: true,
                starred: false,
                inReplyTo: 'msg-1',
                messageId: 'msg-2'
            },
            {
                id: 'thread-1',
                from: { name: 'User', email: 'user@skaleclub.com' },
                to: [{ name: 'Team', email: 'team@company.com' }],
                date: new Date(Date.now() - 7200000),
                subject: 'Re: Project Discussion',
                body: 'Thanks for the input!\n\nI agree with Sarah. Let\'s go with option 2 for the MVP and consider option 1 for the next version.\n\nI\'ll schedule a meeting for tomorrow.',
                snippet: 'Thanks for the input! I agree with Sarah...',
                read: false,
                starred: false,
                inReplyTo: 'msg-2',
                messageId: 'thread-1'
            }
        ],
        participants: [
            { name: 'John Smith', email: 'john@company.com' },
            { name: 'Sarah Johnson', email: 'sarah@company.com' },
            { name: 'User', email: 'user@skaleclub.com' }
        ],
        lastMessageAt: new Date(Date.now() - 7200000),
        unreadCount: 1,
        starred: false,
        hasAttachments: false
    }
}

export default function EmailDetailPage() {
    const params = useParams<{ folder: string; id: string }>()
    const [, setLocation] = useLocation()
    const { openCompose } = useCompose()
    const { selectedMailbox, mailboxes } = useMailbox()

    const [menuOpen, setMenuOpen] = React.useState(false)
    const [viewMode, setViewMode] = React.useState<'single' | 'thread'>('thread')

    const { data: apiMessage, isLoading: messageLoading, error } = useMessage(params.id)
    const updateMessage = useUpdateMessage()
    const deleteMessage = useDeleteMessage()
    const archiveMessage = useArchiveMessage()
    const spamMessage = useSpamMessage()

    const thread = React.useMemo(() => {
        const mockThread = mockThreads[params.id]
        if (mockThread) return mockThread

        const mock = mockEmails[params.id]
        if (mock) {
            return {
                threadId: params.id,
                subject: mock.subject,
                messages: [{
                    id: params.id,
                    from: mock.from,
                    to: mock.to,
                    date: mock.date,
                    subject: mock.subject,
                    body: mock.body,
                    snippet: mock.body.slice(0, 150),
                    read: true,
                    starred: mock.starred,
                    attachments: mock.attachments,
                    messageId: params.id
                }],
                participants: [{ ...mock.from }, ...mock.to],
                lastMessageAt: mock.date,
                unreadCount: 0,
                starred: mock.starred,
                hasAttachments: !!mock.attachments?.length
            }
        }

        if (apiMessage?.message) {
            const emailItem = mapMessageToEmailItem(apiMessage.message)
            return {
                threadId: params.id,
                subject: emailItem.subject,
                messages: [{
                    id: emailItem.id,
                    from: emailItem.from,
                    to: emailItem.to,
                    date: emailItem.date,
                    subject: emailItem.subject,
                    body: apiMessage.message.bodyText || apiMessage.message.bodyHtml || '',
                    htmlBody: apiMessage.message.bodyHtml || apiMessage.message.htmlBody,
                    snippet: emailItem.snippet,
                    read: emailItem.read,
                    starred: emailItem.starred,
                    attachments: apiMessage.message.attachments?.map(a => ({
                        name: a.filename,
                        size: `${Math.round(a.size / 1024)} KB`,
                        type: a.mimeType
                    })),
                    messageId: emailItem.id
                }],
                participants: [{ ...emailItem.from }, ...emailItem.to],
                lastMessageAt: emailItem.date,
                unreadCount: emailItem.read ? 0 : 1,
                starred: emailItem.starred,
                hasAttachments: emailItem.hasAttachments
            }
        }

        return null
    }, [apiMessage, params.id])

    const email = thread?.messages[thread.messages.length - 1] || null

    // Mark as read as soon as the user opens the email.
    React.useEffect(() => {
        if (!email || !selectedMailbox || email.read) return

        updateMessage.mutate({ messageId: email.id, data: { read: true } })
    }, [email?.id, email?.read, selectedMailbox, updateMessage])

    const handleToggleRead = (messageId?: string) => {
        const id = messageId || email?.id
        if (!id || !email || !selectedMailbox) return

        updateMessage.mutate({ messageId: id, data: { read: !email.read } })
        toast({
            title: email.read ? 'Marked as unread' : 'Marked as read',
            variant: 'success'
        })
    }

    const handleToggleReadForThread = (messageId: string, read: boolean) => {
        if (!selectedMailbox) return

        updateMessage.mutate({ messageId, data: { read } })
        toast({
            title: read ? 'Marked as read' : 'Marked as unread',
            variant: 'success'
        })
    }

    const handleStar = () => {
        if (email && selectedMailbox) {
            updateMessage.mutate({ messageId: email.id, data: { starred: !email.starred } })
        }
        toast({
            title: email?.starred ? 'Removed from starred' : 'Added to starred',
            variant: 'success'
        })
    }

    const handleDelete = () => {
        if (email && selectedMailbox) {
            deleteMessage.mutate(email.id)
        }
        toast({ title: 'Email moved to trash', variant: 'success' })
        const backPath = params.folder === 'inbox' ? '/mail/inbox'
            : params.folder === 'sent' ? '/mail/sent'
            : params.folder === 'starred' ? '/mail/starred'
            : params.folder === 'drafts' ? '/mail/drafts'
            : params.folder === 'archive' ? '/mail/archive'
            : params.folder === 'spam' ? '/mail/spam'
            : params.folder === 'trash' ? '/mail/trash'
            : '/mail/inbox'
        setLocation(backPath)
    }

    const handleArchive = () => {
        if (email && selectedMailbox) {
            archiveMessage.mutate(email.id)
        }
        toast({ title: 'Email archived', variant: 'success' })
        const backPath = params.folder === 'inbox' ? '/mail/inbox'
            : params.folder === 'sent' ? '/mail/sent'
            : params.folder === 'starred' ? '/mail/starred'
            : params.folder === 'drafts' ? '/mail/drafts'
            : params.folder === 'archive' ? '/mail/archive'
            : params.folder === 'spam' ? '/mail/spam'
            : params.folder === 'trash' ? '/mail/trash'
            : '/mail/inbox'
        setLocation(backPath)
    }

    const handleSpam = () => {
        if (!email || !selectedMailbox) return

        const isSpamFolder = params.folder === 'spam'
        spamMessage.mutate({ messageId: email.id, isSpam: !isSpamFolder })
        toast({ title: isSpamFolder ? 'Message moved to Inbox' : 'Marked as spam', variant: 'success' })

        const backPath = params.folder === 'inbox' ? '/mail/inbox'
            : params.folder === 'sent' ? '/mail/sent'
            : params.folder === 'starred' ? '/mail/starred'
            : params.folder === 'drafts' ? '/mail/drafts'
            : params.folder === 'archive' ? '/mail/archive'
            : params.folder === 'trash' ? '/mail/trash'
            : params.folder === 'spam' ? '/mail/spam'
            : '/mail/inbox'
        setLocation(backPath)
    }

    const handleReply = (messageId: string) => {
        openCompose({ replyToId: messageId })
    }

    const handleReplyAll = (messageId: string) => {
        openCompose({ replyToId: messageId, replyAll: true })
    }

    const handleForward = (messageId: string) => {
        openCompose({ forwardId: messageId })
    }

    if (mailboxes.length === 0) {
        return (
            <MailLayout>
                <div className="flex items-center justify-center h-full">
                    <div className="text-center max-w-md px-6">
                        <AlertCircle className="w-16 h-16 mx-auto mb-4 text-yellow-500" />
                        <h2 className="text-xl font-bold text-foreground mb-2">
                            No Email Accounts Connected
                        </h2>
                        <p className="text-muted-foreground mb-6">
                            Add an email account to view emails.
                        </p>
                        <Link
                            href="/mail/settings"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Add Email Account
                        </Link>
                    </div>
                </div>
            </MailLayout>
        )
    }

    if (messageLoading) {
        return (
            <MailLayout>
                <div className="flex items-center justify-center h-full">
                    <div className="flex flex-col items-center gap-4">
                        <Loader2 className="w-10 h-10 text-primary animate-spin" />
                        <p className="text-muted-foreground">Loading email...</p>
                    </div>
                </div>
            </MailLayout>
        )
    }

    if (error || !thread) {
        return (
            <MailLayout>
                <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                        <AlertCircle className="w-16 h-16 mx-auto mb-4 text-destructive" />
                        <p className="text-lg font-medium text-foreground">Email not found</p>
                        <p className="text-sm text-muted-foreground mt-2">
                            {error?.message || 'This email may have been deleted or moved.'}
                        </p>
                        <Link
                            href="/mail/inbox"
                            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            <ArrowLeft className="w-4 h-4" />
                            Back to Inbox
                        </Link>
                    </div>
                </div>
            </MailLayout>
        )
    }

    return (
        <MailLayout>
            <div className="flex flex-col h-full bg-background">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => {
                                const backPath = params.folder === 'inbox' ? '/mail/inbox'
                                    : params.folder === 'sent' ? '/mail/sent'
                                    : params.folder === 'starred' ? '/mail/starred'
                                    : params.folder === 'drafts' ? '/mail/drafts'
                                    : params.folder === 'archive' ? '/mail/archive'
                                    : params.folder === 'spam' ? '/mail/spam'
                                    : params.folder === 'trash' ? '/mail/trash'
                                    : '/mail/inbox'
                                setLocation(backPath)
                            }}
                            className="p-2 rounded-lg hover:bg-muted transition-colors"
                        >
                            <ArrowLeft className="w-5 h-5 text-muted-foreground" />
                        </button>
                        <span className="text-sm text-muted-foreground capitalize">
                            {params.folder}
                        </span>
                        {thread.messages.length > 1 && (
                            <span className="flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded-full text-xs">
                                <MessagesSquare className="w-3 h-3" />
                                {thread.messages.length}
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-1">
                        {thread.messages.length > 1 && (
                            <div className="flex items-center gap-1 mr-2 p-1 bg-muted rounded-lg">
                                <button
                                    onClick={() => setViewMode('thread')}
                                    className={`px-2 py-1 text-xs rounded-md transition-colors ${
                                        viewMode === 'thread'
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground'
                                    }`}
                                >
                                    Thread
                                </button>
                                <button
                                    onClick={() => setViewMode('single')}
                                    className={`px-2 py-1 text-xs rounded-md transition-colors ${
                                        viewMode === 'single'
                                            ? 'bg-background text-foreground shadow-sm'
                                            : 'text-muted-foreground'
                                    }`}
                                >
                                    Single
                                </button>
                            </div>
                        )}
                        <button
                            onClick={() => handleToggleRead()}
                            className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                                email?.read
                                    ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                                    : 'text-primary hover:bg-primary/10'
                            }`}
                            title={email?.read ? 'Mark as unread' : 'Mark as read'}
                        >
                            {email?.read ? <Mail className="w-5 h-5" /> : <MailOpen className="w-5 h-5" />}
                            <span className="hidden sm:inline text-sm font-medium">
                                {email?.read ? 'Mark as unread' : 'Mark as read'}
                            </span>
                        </button>
                        <button
                            onClick={handleArchive}
                            className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
                            title="Archive"
                        >
                            <Archive className="w-5 h-5" />
                        </button>
                        <button
                            onClick={handleDelete}
                            className="p-2 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-500 transition-colors"
                            title="Delete"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                        <button
                            onClick={handleStar}
                            className={`p-2 rounded-lg transition-colors ${
                                thread.starred
                                    ? 'text-yellow-500 hover:text-yellow-600'
                                    : 'text-muted-foreground hover:text-foreground'
                            }`}
                            title={thread.starred ? 'Unstar' : 'Star'}
                        >
                            <Star className={`w-5 h-5 ${thread.starred ? 'fill-current' : ''}`} />
                        </button>
                        <div className="relative">
                            <button
                                onClick={() => setMenuOpen(!menuOpen)}
                                className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
                            >
                                <MoreVertical className="w-5 h-5" />
                            </button>

                            {menuOpen && (
                                <>
                                    <div
                                        className="fixed inset-0 z-40"
                                        onClick={() => setMenuOpen(false)}
                                    />
                                    <div className="absolute right-0 top-full mt-1 w-48 bg-popover rounded-xl shadow-xl border border-border py-1 z-50">
                                        <button
                                            onClick={() => {
                                                setMenuOpen(false)
                                                handleReply(thread.messages[thread.messages.length - 1].id)
                                            }}
                                            className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                        >
                                            <Reply className="w-4 h-4" />
                                            Reply
                                        </button>
                                        <button
                                            onClick={() => {
                                                setMenuOpen(false)
                                                handleReplyAll(thread.messages[thread.messages.length - 1].id)
                                            }}
                                            className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                        >
                                            <ReplyAll className="w-4 h-4" />
                                            Reply All
                                        </button>
                                        <button
                                            onClick={() => {
                                                setMenuOpen(false)
                                                handleForward(thread.messages[thread.messages.length - 1].id)
                                            }}
                                            className="flex items-center gap-3 w-full px-4 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
                                        >
                                            <Forward className="w-4 h-4" />
                                            Forward
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                {viewMode === 'thread' && thread.messages.length > 1 ? (
                    <EmailThreadView
                        thread={thread}
                        onReply={handleReply}
                        onReplyAll={handleReplyAll}
                        onForward={handleForward}
                        onStar={() => {
                            toast({ title: 'Star toggled', variant: 'success' })
                        }}
                        onToggleRead={handleToggleReadForThread}
                    />
                ) : (
                    <SingleEmailView
                        message={thread.messages[thread.messages.length - 1]}
                        onReply={() => handleReply(thread.messages[thread.messages.length - 1].id)}
                        onReplyAll={() => handleReplyAll(thread.messages[thread.messages.length - 1].id)}
                        onForward={() => handleForward(thread.messages[thread.messages.length - 1].id)}
                        onToggleRead={() => handleToggleRead(thread.messages[thread.messages.length - 1].id)}
                        onArchive={handleArchive}
                        onSpam={handleSpam}
                        isSpam={params.folder === 'spam'}
                        onDelete={handleDelete}
                        onStar={handleStar}
                    />
                )}
            </div>
        </MailLayout>
    )
}

function SingleEmailView({
    message,
    onReply,
    onReplyAll,
    onForward,
    onToggleRead,
    onArchive,
    onSpam,
    isSpam,
    onDelete,
    onStar,
}: {
    message: ThreadMessage
    onReply: () => void
    onReplyAll: () => void
    onForward: () => void
    onToggleRead: () => void
    onArchive: () => void
    onSpam: () => void
    isSpam?: boolean
    onDelete: () => void
    onStar: () => void
}) {
    const [emailDarkMode, setEmailDarkMode] = useState(false)

    useEffect(() => {
        setEmailDarkMode(false)
    }, [message.id])

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="p-4 sm:p-6">
                <div className="max-w-3xl mx-auto">
                    <h1 className="text-base font-bold text-foreground mb-3">
                        {message.subject}
                    </h1>

                    <EmailMessageHeader
                        from={message.from}
                        to={message.to}
                        date={message.date}
                        className="mb-6"
                        read={message.read}
                        starred={message.starred}
                        onToggleRead={onToggleRead}
                        onArchive={onArchive}
                        onSpam={onSpam}
                        isSpam={isSpam}
                        onDelete={onDelete}
                        onStar={onStar}
                        emailDarkMode={emailDarkMode}
                        onToggleEmailDarkMode={() => setEmailDarkMode(!emailDarkMode)}
                    />

                    <div className="mt-4">
                        <EmailHtmlViewer
                            html={message.htmlBody}
                            plainText={message.body || message.snippet}
                            emailDarkMode={emailDarkMode}
                        />
                    </div>

                    {message.attachments && message.attachments.length > 0 && (
                        <div className="mt-8">
                            <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                                <Paperclip className="w-4 h-4" />
                                Attachments ({message.attachments.length})
                            </h3>
                            <div className="flex flex-wrap gap-2">
                                {message.attachments.map((attachment, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg hover:bg-muted/80 transition-colors cursor-pointer"
                                    >
                                        <Paperclip className="w-4 h-4 text-muted-foreground" />
                                        <div>
                                            <p className="text-sm font-medium text-foreground">
                                                {attachment.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">{attachment.size}</p>
                                        </div>
                                        <Download className="w-4 h-4 text-muted-foreground ml-2" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="mt-8 pt-6 border-t border-border">
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
                            <button
                                onClick={onReply}
                                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                            >
                                <Reply className="w-4 h-4" />
                                Reply
                            </button>
                            <button
                                onClick={onReplyAll}
                                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg font-medium transition-colors"
                            >
                                <ReplyAll className="w-4 h-4" />
                                Reply All
                            </button>
                            <button
                                onClick={onForward}
                                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 sm:py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg font-medium transition-colors"
                            >
                                <Forward className="w-4 h-4" />
                                Forward
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
