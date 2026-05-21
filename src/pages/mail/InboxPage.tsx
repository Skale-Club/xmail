import React, { useState } from 'react'
import { useLocation } from 'wouter'
import { MailLayout } from '../../components/mail/MailLayout'
import { EmailList, EmailItem, EmailToolbar } from '../../components/mail/EmailList'
import { LoadingState } from '../../components/mail/EmailParts'
import { ConnectMailboxDialog } from '../../components/mail/ConnectMailboxDialog'
import { toast } from '../../components/ui/toaster'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useMailbox } from '../../hooks/useMailbox'
import { useCompose } from '../../hooks/useCompose'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import {
    useMessages,
    useMessage,
    useUpdateMessage,
    useDeleteMessage,
    useArchiveMessage,
    useBatchUpdate,
    useSpamMessage,
    useSyncMailbox,
    mapMessageToEmailItem
} from '../../hooks/useMail'
import { EmailHtmlViewer } from '../../components/mail/EmailHtmlViewer'
import { EmailMessageHeader } from '../../components/mail/EmailMessageHeader'
import { Inbox as InboxIcon, Mail, MailOpen, AlertCircle, Search, X } from 'lucide-react'
import { ResizablePanels } from '../../components/mail/ResizablePanels'

export default function InboxPage() {
    const isMobile = useIsMobile()
    const [, navigate] = useLocation()
    const { openCompose } = useCompose()
    const { selectedMailbox, mailboxes, isLoading: mailboxesLoading } = useMailbox()

    const [selectedEmail, setSelectedEmail] = React.useState<string | null>(null)
    const [selectedEmails, setSelectedEmails] = React.useState<Set<string>>(new Set())
    const [filter, setFilter] = React.useState<'all' | 'unread' | 'starred' | 'attachments'>('all')
    const [searchQuery, setSearchQuery] = React.useState('')
    const [showConnectDialog, setShowConnectDialog] = React.useState(false)
    const { data, isLoading, isFetching, refetch } = useMessages('inbox', 1, 50)
    const updateMessage = useUpdateMessage()
    const deleteMessage = useDeleteMessage()
    const archiveMessage = useArchiveMessage()
    const batchUpdate = useBatchUpdate()
    const spamMessage = useSpamMessage()
    const syncMailbox = useSyncMailbox()

    const { emails, unreadCount } = React.useMemo(() => {
        const baseEmails = data?.messages ? data.messages.map(mapMessageToEmailItem) : []

        const totalUnread = baseEmails.filter(e => !e.read).length

        let filtered = baseEmails
        if (filter === 'unread') filtered = filtered.filter(e => !e.read)
        if (filter === 'starred') filtered = filtered.filter(e => e.starred)
        if (filter === 'attachments') filtered = filtered.filter(e => e.hasAttachments)

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            filtered = filtered.filter(e =>
                e.subject.toLowerCase().includes(q) ||
                e.from.name.toLowerCase().includes(q) ||
                e.from.email.toLowerCase().includes(q) ||
                e.snippet.toLowerCase().includes(q)
            )
        }

        return { emails: filtered, unreadCount: totalUnread }
    }, [data, filter, searchQuery])

    const currentIndex = React.useMemo(() => {
        if (!selectedEmail) return -1
        return emails.findIndex(email => email.id === selectedEmail)
    }, [emails, selectedEmail])

    const selectedEmailData = React.useMemo(
        () => emails.find((email) => email.id === selectedEmail) || null,
        [emails, selectedEmail]
    )

    const handleRefresh = async () => {
        if (selectedMailbox) {
            syncMailbox.mutate()
        } else {
            refetch()
        }
        toast({ title: 'Inbox refreshed', variant: 'success' })
    }

    const handleSelectEmail = (id: string) => {
        const email = emails.find(email => email.id === id)

        if (selectedMailbox && email && !email.read) {
            updateMessage.mutate({ messageId: id, data: { read: true } })
        }

        if (isMobile) {
            navigate(`/mail/inbox/${id}`)
            return
        }
        setSelectedEmail(id)
    }

    const handleToggleRead = (id: string) => {
        const email = emails.find(e => e.id === id)
        if (!email || !selectedMailbox) return

        updateMessage.mutate({ messageId: id, data: { read: !email.read } })
        toast({
            title: email.read ? 'Marked as unread' : 'Marked as read',
            variant: 'success'
        })
    }

    const handleNavigate = (direction: 'up' | 'down') => {
        if (emails.length === 0) return
        
        let newIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1
        newIndex = Math.max(0, Math.min(emails.length - 1, newIndex))
        
        if (emails[newIndex]) {
            handleSelectEmail(emails[newIndex].id)
        }
    }

    const handleStar = (id: string) => {
        if (selectedMailbox) {
            const email = emails.find(email => email.id === id)
            updateMessage.mutate({ messageId: id, data: { starred: !email?.starred } })
        }
        toast({
            title: emails.find(email => email.id === id)?.starred ? 'Removed from starred' : 'Added to starred',
            variant: 'success'
        })
    }

    const handleStarSelected = () => {
        if (selectedEmail) {
            handleStar(selectedEmail)
        }
    }

    const handleDelete = (id: string) => {
        if (selectedEmail === id) {
            const idx = emails.findIndex(e => e.id === id)
            const next = emails[idx + 1] ?? emails[idx - 1] ?? null
            setSelectedEmail(next?.id ?? null)
        }
        if (selectedMailbox) deleteMessage.mutate(id)
        setSelectedEmails(prev => {
            const newSet = new Set(prev)
            newSet.delete(id)
            return newSet
        })
        toast({ title: 'Email moved to trash', variant: 'success' })
    }

    const handleDeleteSelected = () => {
        if (selectedEmails.size > 0) {
            handleBulkDelete()
        } else if (selectedEmail) {
            handleDelete(selectedEmail)
            const nextIndex = Math.min(currentIndex, emails.length - 2)
            if (nextIndex >= 0 && emails[nextIndex]) {
                setSelectedEmail(emails[nextIndex].id)
            }
        }
    }

    const handleArchive = (id: string) => {
        if (selectedEmail === id) {
            setSelectedEmail(null)
        }
        if (selectedMailbox) {
            archiveMessage.mutate(id)
        }
        setSelectedEmails(prev => {
            const newSet = new Set(prev)
            newSet.delete(id)
            return newSet
        })
        toast({ title: 'Email archived', variant: 'success' })
    }

    const handleArchiveSelected = () => {
        if (selectedEmails.size > 0) {
            handleBulkArchive()
        } else if (selectedEmail) {
            handleArchive(selectedEmail)
            const nextIndex = Math.min(currentIndex, emails.length - 2)
            if (nextIndex >= 0 && emails[nextIndex]) {
                setSelectedEmail(emails[nextIndex].id)
            }
        }
    }

    const handleBulkDelete = () => {
        if (selectedEmails.size === 0) return
        const count = selectedEmails.size
        if (selectedMailbox) batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'delete' })
        setSelectedEmails(new Set())
        toast({ title: `${count} email${count > 1 ? 's' : ''} moved to trash`, variant: 'success' })
    }

    const handleBulkArchive = () => {
        if (selectedEmails.size === 0) return
        if (selectedMailbox) {
            batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'archive' })
        }
        setSelectedEmails(new Set())
        toast({ title: `${selectedEmails.size} emails archived`, variant: 'success' })
    }

    const handleSpam = (id: string) => {
        if (selectedEmail === id) {
            setSelectedEmail(null)
        }
        if (selectedMailbox) {
            spamMessage.mutate({ messageId: id, isSpam: true })
        }
        setSelectedEmails(prev => {
            const newSet = new Set(prev)
            newSet.delete(id)
            return newSet
        })
        toast({ title: 'Marked as spam', variant: 'success' })
    }

    const handleBulkSpam = () => {
        if (selectedEmails.size === 0) return
        if (selectedMailbox) {
            batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'spam' })
        }
        setSelectedEmails(new Set())
        toast({ title: `${selectedEmails.size} emails marked as spam`, variant: 'success' })
    }

    const handleBulkRead = (read: boolean) => {
        if (selectedEmails.size === 0) return
        if (selectedMailbox) {
            batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: read ? 'read' : 'unread' })
        }
        setSelectedEmails(new Set())
    }

    const handleMarkReadSelected = () => {
        if (selectedEmails.size > 0) {
            handleBulkRead(true)
        } else if (selectedEmail) {
            const email = emails.find(e => e.id === selectedEmail)
            if (email && !email.read) {
                updateMessage.mutate({ messageId: selectedEmail, data: { read: true } })
            }
        }
    }

    const handleToggleSelect = () => {
        if (selectedEmail) {
            setSelectedEmails(prev => {
                const newSet = new Set(prev)
                if (newSet.has(selectedEmail)) {
                    newSet.delete(selectedEmail)
                } else {
                    newSet.add(selectedEmail)
                }
                return newSet
            })
        }
    }

    useKeyboardShortcuts({
        enabled: true,
        onNavigate: handleNavigate,
        onReply: () => selectedEmail && openCompose({ replyToId: selectedEmail }),
        onReplyAll: () => selectedEmail && openCompose({ replyToId: selectedEmail, replyAll: true }),
        onForward: () => selectedEmail && openCompose({ forwardId: selectedEmail }),
        onArchive: handleArchiveSelected,
        onDelete: handleDeleteSelected,
        onStar: handleStarSelected,
        onMarkRead: handleMarkReadSelected,
        onRefresh: handleRefresh,
        onCompose: () => openCompose(),
        onSelect: handleToggleSelect,
        onSelectAll: () => setSelectedEmails(new Set(emails.map(email => email.id))),
        onDeselectAll: () => setSelectedEmails(new Set()),
        onEscape: () => {
            setSelectedEmail(null)
            setSelectedEmails(new Set())
        }
    })

    if (mailboxesLoading || isLoading) {
        return (
            <MailLayout>
                <LoadingState message="Loading inbox..." />
            </MailLayout>
        )
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
                            Add an email account to start sending and receiving emails.
                        </p>
                        <button
                            type="button"
                            onClick={() => setShowConnectDialog(true)}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Add Email Account
                        </button>
                    </div>
                </div>
                <ConnectMailboxDialog
                    open={showConnectDialog}
                    onOpenChange={setShowConnectDialog}
                    onConnected={() => navigate('/mail/inbox')}
                />
            </MailLayout>
        )
    }

    return (
        <MailLayout>
            {isMobile ? (
                <div className="flex h-full flex-col bg-background">
                    <div className="px-4 py-2 border-b border-border bg-background">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <InboxIcon className="w-5 h-5 text-muted-foreground" />
                                <h1 className="text-lg font-bold text-foreground">Inbox</h1>
                            </div>
                            <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                                <button onClick={() => setFilter('all')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>All</button>
                                <button onClick={() => setFilter('unread')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'unread' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Unread {unreadCount > 0 && `(${unreadCount})`}</button>
                                <button onClick={() => setFilter('starred')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'starred' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Starred</button>
                                <button onClick={() => setFilter('attachments')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'attachments' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Attachments</button>
                            </div>
                        </div>
                        <div className="relative mt-2">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input
                                type="text"
                                placeholder="Search emails..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-8 pr-8 py-1.5 text-sm bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                            {searchQuery && (
                                <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    <EmailToolbar
                        selectedCount={selectedEmails.size}
                        totalCount={data?.total}
                        onSelectAll={() => {
                            if (selectedEmails.size === emails.length) {
                                setSelectedEmails(new Set())
                            } else {
                                setSelectedEmails(new Set(emails.map(email => email.id)))
                            }
                        }}
                        onMarkRead={() => handleBulkRead(true)}
                        onMarkUnread={() => handleBulkRead(false)}
                        onDelete={handleBulkDelete}
                        onArchive={handleBulkArchive}
                        onSpam={handleBulkSpam}
                        onRefresh={handleRefresh}
                        isRefreshing={isFetching || syncMailbox.isPending}
                    />

                    <div className="flex-1 overflow-y-auto">
                        <EmailList
                            emails={emails}
                            selectedId={selectedEmail || undefined}
                            selectedEmails={selectedEmails}
                            onSelect={handleSelectEmail}
                            onSelectMultiple={(ids) => setSelectedEmails(new Set(ids))}
                            onToggleRead={handleToggleRead}
                            onStar={handleStar}
                            onDelete={handleDelete}
                            onArchive={handleArchive}
                            onSpam={handleSpam}
                            emptyMessage={filter === 'all' ? "No emails in inbox" : `No ${filter} emails`}
                        />
                    </div>
                </div>
            ) : (
                <ResizablePanels
                    storageKey="mail-panels-inbox"
                    left={
                        <>
                            <div className="px-4 py-2 border-b border-border bg-background">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <InboxIcon className="w-5 h-5 text-muted-foreground" />
                                        <h1 className="text-lg font-bold text-foreground">Inbox</h1>
                                    </div>
                                    <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                                        <button onClick={() => setFilter('all')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>All</button>
                                        <button onClick={() => setFilter('unread')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'unread' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Unread {unreadCount > 0 && `(${unreadCount})`}</button>
                                        <button onClick={() => setFilter('starred')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'starred' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Starred</button>
                                        <button onClick={() => setFilter('attachments')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'attachments' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Attachments</button>
                                    </div>
                                </div>
                                <div className="relative mt-2">
                                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="text"
                                        placeholder="Search emails..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-full pl-8 pr-8 py-1.5 text-sm bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    />
                                    {searchQuery && (
                                        <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                            <X className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <EmailToolbar
                                selectedCount={selectedEmails.size}
                                totalCount={data?.total}
                                onSelectAll={() => {
                                    if (selectedEmails.size === emails.length) {
                                        setSelectedEmails(new Set())
                                    } else {
                                        setSelectedEmails(new Set(emails.map(email => email.id)))
                                    }
                                }}
                                onMarkRead={() => handleBulkRead(true)}
                                onMarkUnread={() => handleBulkRead(false)}
                                onDelete={handleBulkDelete}
                                onArchive={handleBulkArchive}
                                onSpam={handleBulkSpam}
                                onRefresh={handleRefresh}
                                isRefreshing={isFetching || syncMailbox.isPending}
                            />

                            <div className="flex-1 overflow-y-auto">
                                <EmailList
                                    emails={emails}
                                    selectedId={selectedEmail || undefined}
                                    selectedEmails={selectedEmails}
                                    onSelect={handleSelectEmail}
                                    onSelectMultiple={(ids) => setSelectedEmails(new Set(ids))}
                                    onToggleRead={handleToggleRead}
                                    onStar={handleStar}
                                    onDelete={handleDelete}
                                    onArchive={handleArchive}
                                    onSpam={handleSpam}
                                    emptyMessage={filter === 'all' ? "No emails in inbox" : `No ${filter} emails`}
                                />
                            </div>
                        </>
                    }
                    right={
                        <>
                            {selectedEmailData ? (
                                <EmailDetail
                                    email={selectedEmailData}
                                    onToggleRead={handleToggleRead}
                                    onArchive={handleArchive}
                                    onSpam={handleSpam}
                                    onDelete={handleDelete}
                                    onStar={handleStar}
                                />
                            ) : (
                                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                                    <div className="text-center">
                                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent flex items-center justify-center">
                                            <InboxIcon className="w-8 h-8 text-muted-foreground" />
                                        </div>
                                        <p className="text-base font-medium text-foreground">Select an email to read</p>
                                        <p className="text-sm mt-1">Click on an email from the list to view its contents</p>
                                    </div>
                                </div>
                            )}
                        </>
                    }
                />
            )}
        </MailLayout>
    )
}

function EmailDetail({
    email,
    onToggleRead,
    onArchive,
    onSpam,
    onDelete,
    onStar,
}: {
    email: EmailItem
    onToggleRead?: (id: string) => void
    onArchive?: (id: string) => void
    onSpam?: (id: string) => void
    onDelete?: (id: string) => void
    onStar?: (id: string) => void
}) {
    const { data: messageData, isLoading: isMessageLoading } = useMessage(email.id)
    const { openCompose } = useCompose()
    const fullMessage = messageData?.message
    const [emailDarkMode, setEmailDarkMode] = useState(false)

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="p-4">
                <div className="max-w-3xl mx-auto">
                    <EmailMessageHeader
                        from={email.from}
                        to={email.to}
                        date={email.date}
                        read={email.read}
                        starred={email.starred}
                        onToggleRead={onToggleRead ? () => onToggleRead(email.id) : undefined}
                        onArchive={onArchive ? () => onArchive(email.id) : undefined}
                        onSpam={onSpam ? () => onSpam(email.id) : undefined}
                        onDelete={onDelete ? () => onDelete(email.id) : undefined}
                        onStar={onStar ? () => onStar(email.id) : undefined}
                        emailDarkMode={emailDarkMode}
                        onToggleEmailDarkMode={() => setEmailDarkMode(!emailDarkMode)}
                    />
                    <h2 className="text-sm font-bold text-foreground mb-3">
                        {email.subject}
                    </h2>

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
                        />
                    </div>

                    <div className="mt-8 pt-6 border-t border-border">
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => openCompose({ replyToId: email.id })}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors"
                            >
                                Reply
                            </button>
                            <button
                                onClick={() => openCompose({ replyToId: email.id, replyAll: true })}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg text-sm font-medium transition-colors"
                            >
                                Reply All
                            </button>
                            <button
                                onClick={() => openCompose({ forwardId: email.id })}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg text-sm font-medium transition-colors"
                            >
                                Forward
                            </button>
                            {onToggleRead && (
                                <button
                                    onClick={() => onToggleRead(email.id)}
                                    className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                        email.read
                                            ? 'bg-secondary hover:bg-secondary/80 text-secondary-foreground'
                                            : 'bg-primary/10 hover:bg-primary/20 text-primary'
                                    }`}
                                    title={email.read ? 'Mark as unread' : 'Mark as read'}
                                >
                                    {email.read ? (
                                        <>
                                            <Mail className="w-4 h-4" />
                                            Mark as unread
                                        </>
                                    ) : (
                                        <>
                                            <MailOpen className="w-4 h-4" />
                                            Mark as read
                                        </>
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
