import React, { useState } from 'react'
import { useLocation } from 'wouter'
import { MailLayout } from './MailLayout'
import { EmailList, EmailItem, EmailToolbar } from './EmailList'
import { LoadingState } from './EmailParts'
import { EmailDetailView, EmailDetailEmpty } from './EmailDetailView'
import { EmailHtmlViewer } from './EmailHtmlViewer'
import { EmailMessageHeader } from './EmailMessageHeader'
import { ResizablePanels } from './ResizablePanels'
import { ConnectMailboxDialog } from './ConnectMailboxDialog'
import { toast } from '../ui/toaster'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useMailbox } from '../../hooks/useMailbox'
import { useCompose } from '../../hooks/useCompose'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useInfiniteScroll, useDebounce } from '../../hooks/useInfiniteScroll'
import {
    useInfiniteMessages,
    useMessage,
    useUpdateMessage,
    useDeleteMessage,
    useArchiveMessage,
    useBatchUpdate,
    useSpamMessage,
    useRestoreMessage,
    useSyncMailbox,
    mapMessageToEmailItem,
} from '../../hooks/useMail'
import { Search, X, Trash2 } from 'lucide-react'

/** One entry per mail folder page. 'starred' is the one cross-folder kind — it
 *  queries every folder (except Trash/Spam) with `starred` forced on server-side
 *  instead of resolving a single folder. See useInfiniteMessages(). */
export type FolderKind = 'inbox' | 'sent' | 'archive' | 'drafts' | 'spam' | 'trash' | 'starred'

type FilterTab = 'all' | 'unread' | 'starred' | 'attachments'

const PAGE_SIZE = 30

interface ConfirmState {
    open: boolean
    title: string
    description: string
    confirmLabel: string
    variant: 'danger' | 'warning' | 'default'
    onConfirm: () => void
}

const NO_CONFIRM: ConfirmState = {
    open: false,
    title: '',
    description: '',
    confirmLabel: 'Confirm',
    variant: 'default',
    onConfirm: () => {},
}

export interface FolderPageProps {
    kind: FolderKind
    title: string
    icon: React.ReactNode
    emptyMessage: string
    storageKey: string
    /** No-mailbox empty-state icon; falls back to `icon`. */
    emptyStateIcon?: React.ReactNode
}

export function FolderPage({ kind, title, icon, emptyMessage, storageKey, emptyStateIcon }: FolderPageProps) {
    const isMobile = useIsMobile()
    const [, navigate] = useLocation()
    const { openCompose } = useCompose()
    const { selectedMailbox, mailboxes, isLoading: mailboxesLoading } = useMailbox()

    const [selectedEmail, setSelectedEmail] = useState<string | null>(null)
    const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set())
    const [filter, setFilter] = useState<FilterTab>('all')
    const [searchInput, setSearchInput] = useState('')
    const [showConnectDialog, setShowConnectDialog] = useState(false)
    const [confirmDialog, setConfirmDialog] = useState<ConfirmState>(NO_CONFIRM)
    const searchQuery = useDebounce(searchInput, 300)

    const crossFolder = kind === 'starred'
    const serverFolderType = crossFolder ? undefined : kind

    const filters = React.useMemo(() => ({
        unread: filter === 'unread' ? true : undefined,
        starred: crossFolder ? true : filter === 'starred' ? true : undefined,
        hasAttachments: filter === 'attachments' ? true : undefined,
        search: searchQuery.trim() || undefined,
    }), [filter, searchQuery, crossFolder])

    const {
        data,
        isLoading,
        isFetching,
        isFetchingNextPage,
        hasNextPage,
        fetchNextPage,
        refetch,
    } = useInfiniteMessages(serverFolderType, PAGE_SIZE, filters)

    const { loadMoreRef } = useInfiniteScroll({
        hasMore: !!hasNextPage,
        isLoading: isFetchingNextPage,
        onLoadMore: () => { void fetchNextPage() },
    })

    const updateMessage = useUpdateMessage()
    const deleteMessage = useDeleteMessage()
    const archiveMessage = useArchiveMessage()
    const batchUpdate = useBatchUpdate()
    const spamMessage = useSpamMessage()
    const restoreMessage = useRestoreMessage()
    const syncMailbox = useSyncMailbox()

    const emails = React.useMemo(
        () => data?.pages.flatMap((page) => page.messages.map(mapMessageToEmailItem)) ?? [],
        [data]
    )
    const total = data?.pages[0]?.total
    const unreadCount = React.useMemo(() => emails.filter((e) => !e.read).length, [emails])

    const currentIndex = React.useMemo(() => {
        if (!selectedEmail) return -1
        return emails.findIndex((email) => email.id === selectedEmail)
    }, [emails, selectedEmail])

    const selectedEmailData = React.useMemo(
        () => emails.find((email) => email.id === selectedEmail) || null,
        [emails, selectedEmail]
    )

    const handleRefresh = () => {
        if (selectedMailbox) {
            syncMailbox.mutate()
        } else {
            refetch()
        }
    }

    const clearSelection = (id: string) => {
        setSelectedEmails((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
        })
    }

    const handleSelectEmail = (id: string) => {
        if (kind === 'drafts' && isMobile) {
            // Drafts have no "reader" view — mobile jumps straight into the editor,
            // matching the desktop panel's "Continue editing" button.
            openCompose({ draftId: id })
            return
        }

        if (kind === 'inbox' && selectedMailbox) {
            const email = emails.find((e) => e.id === id)
            if (email && !email.read) {
                updateMessage.mutate({ messageId: id, data: { read: true } })
            }
        }

        if (isMobile) {
            navigate(`/mail/${kind}/${id}`)
            return
        }
        setSelectedEmail(id)
    }

    const handleToggleRead = (id: string) => {
        const email = emails.find((e) => e.id === id)
        if (!email || !selectedMailbox) return
        updateMessage.mutate({ messageId: id, data: { read: !email.read } })
        toast({ title: email.read ? 'Marked as unread' : 'Marked as read', variant: 'success' })
    }

    const handleStar = (id: string) => {
        const email = emails.find((e) => e.id === id)
        if (selectedMailbox) {
            updateMessage.mutate({ messageId: id, data: { starred: !email?.starred } })
        }
        toast({ title: email?.starred ? 'Removed from starred' : 'Added to starred', variant: 'success' })
    }

    // Regular delete = move to Trash (Inbox/Sent/Archive/Spam/Starred/Drafts).
    const doDelete = (id: string) => {
        if (selectedEmail === id) {
            const idx = emails.findIndex((e) => e.id === id)
            const next = emails[idx + 1] ?? emails[idx - 1] ?? null
            setSelectedEmail(next?.id ?? null)
        }
        if (selectedMailbox) deleteMessage.mutate(id)
        clearSelection(id)
    }

    const handleDelete = (id: string) => {
        if (kind === 'trash') {
            setConfirmDialog({
                open: true,
                title: 'Delete permanently?',
                description: 'This email will be permanently deleted. This action cannot be undone.',
                confirmLabel: 'Delete forever',
                variant: 'danger',
                onConfirm: () => {
                    setConfirmDialog(NO_CONFIRM)
                    if (selectedEmail === id) setSelectedEmail(null)
                    if (selectedMailbox) deleteMessage.mutate(id)
                    toast({ title: 'Email permanently deleted', variant: 'success' })
                },
            })
            return
        }

        if (kind === 'drafts') {
            setConfirmDialog({
                open: true,
                title: 'Move to trash?',
                description: 'This draft will be moved to the Trash folder. You can restore it within 30 days.',
                confirmLabel: 'Move to trash',
                variant: 'danger',
                onConfirm: () => {
                    setConfirmDialog(NO_CONFIRM)
                    doDelete(id)
                    toast({ title: 'Draft moved to trash', variant: 'success' })
                },
            })
            return
        }

        doDelete(id)
        toast({ title: 'Email moved to trash', variant: 'success' })
    }

    const handleDeleteSelected = () => {
        if (selectedEmails.size > 0) {
            handleBulkDelete()
        } else if (selectedEmail) {
            handleDelete(selectedEmail)
        }
    }

    const handleArchive = (id: string) => {
        if (selectedEmail === id) setSelectedEmail(null)
        if (selectedMailbox) archiveMessage.mutate(id)
        clearSelection(id)
        toast({ title: 'Email archived', variant: 'success' })
    }

    // On the Archive page, the "archive" action means moving back to Inbox.
    const handleMoveToInbox = (id: string) => {
        if (selectedMailbox) batchUpdate.mutate({ messageIds: [id], action: 'move' })
        if (selectedEmail === id) setSelectedEmail(null)
        clearSelection(id)
        toast({ title: 'Moved to Inbox', variant: 'success' })
    }

    const handleArchiveSelected = () => {
        if (selectedEmails.size > 0) {
            handleBulkArchive()
        } else if (selectedEmail) {
            if (kind === 'archive') handleMoveToInbox(selectedEmail)
            else handleArchive(selectedEmail)
        }
    }

    const handleSpam = (id: string) => {
        if (selectedEmail === id) setSelectedEmail(null)
        if (selectedMailbox) spamMessage.mutate({ messageId: id, isSpam: true })
        clearSelection(id)
        toast({ title: 'Marked as spam', variant: 'success' })
    }

    const handleNotSpam = (id: string) => {
        if (selectedMailbox) spamMessage.mutate({ messageId: id, isSpam: false })
        if (selectedEmail === id) setSelectedEmail(null)
        toast({ title: 'Message moved to Inbox', variant: 'success' })
    }

    const handleRestore = (id: string) => {
        if (selectedMailbox) restoreMessage.mutate(id)
        if (selectedEmail === id) setSelectedEmail(null)
        toast({ title: 'Email restored to inbox', variant: 'success' })
    }

    const handleBulkDelete = () => {
        if (selectedEmails.size === 0) return
        const count = selectedEmails.size
        const ids = Array.from(selectedEmails)

        const run = () => {
            if (selectedMailbox) batchUpdate.mutate({ messageIds: ids, action: 'delete' })
            setSelectedEmails(new Set())
        }

        if (kind === 'trash') {
            setConfirmDialog({
                open: true,
                title: `Permanently delete ${count} email${count > 1 ? 's' : ''}?`,
                description: 'These emails will be permanently deleted. This action cannot be undone.',
                confirmLabel: 'Delete forever',
                variant: 'danger',
                onConfirm: () => {
                    setConfirmDialog(NO_CONFIRM)
                    run()
                    toast({ title: `${count} emails permanently deleted`, variant: 'success' })
                },
            })
            return
        }

        if (kind === 'drafts') {
            setConfirmDialog({
                open: true,
                title: `Move ${count} draft${count > 1 ? 's' : ''} to trash?`,
                description: 'These drafts will be moved to the Trash folder. You can restore them within 30 days.',
                confirmLabel: 'Move to trash',
                variant: 'danger',
                onConfirm: () => {
                    setConfirmDialog(NO_CONFIRM)
                    run()
                    toast({ title: `${count} drafts moved to trash`, variant: 'success' })
                },
            })
            return
        }

        run()
        toast({ title: `${count} email${count > 1 ? 's' : ''} moved to trash`, variant: 'success' })
    }

    const handleBulkArchive = () => {
        if (selectedEmails.size === 0) return
        const count = selectedEmails.size

        if (kind === 'drafts') {
            toast({ title: 'Cannot archive drafts', variant: 'destructive' })
            return
        }
        if (kind === 'spam') {
            toast({ title: 'Cannot archive spam', variant: 'destructive' })
            return
        }
        if (kind === 'trash') {
            toast({ title: 'Cannot archive from trash', variant: 'destructive' })
            return
        }

        const action = kind === 'archive' ? 'move' : 'archive'
        if (selectedMailbox) batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action })
        setSelectedEmails(new Set())
        toast({ title: kind === 'archive' ? `${count} messages moved to Inbox` : `${count} emails archived`, variant: 'success' })
    }

    const handleBulkRead = (read: boolean) => {
        if (selectedEmails.size === 0) return
        if (selectedMailbox) {
            batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: read ? 'read' : 'unread' })
        }
        setSelectedEmails(new Set())
    }

    const handleBulkSpam = () => {
        if (selectedEmails.size === 0) return
        const count = selectedEmails.size
        if (selectedMailbox) {
            batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: kind === 'spam' ? 'unspam' : 'spam' })
        }
        setSelectedEmails(new Set())
        toast({
            title: kind === 'spam' ? `${count} messages moved to Inbox` : `${count} emails marked as spam`,
            variant: 'success',
        })
    }

    const handleMarkReadSelected = () => {
        if (selectedEmails.size > 0) {
            handleBulkRead(true)
        } else if (selectedEmail) {
            const email = emails.find((e) => e.id === selectedEmail)
            if (email && !email.read) {
                updateMessage.mutate({ messageId: selectedEmail, data: { read: true } })
            }
        }
    }

    const handleEmptyFolder = () => {
        if (emails.length === 0 || !selectedMailbox) return
        setConfirmDialog({
            open: true,
            title: kind === 'trash' ? 'Empty trash?' : 'Delete all spam?',
            description: `All ${emails.length} message${emails.length > 1 ? 's' : ''} will be permanently deleted. This action cannot be undone.`,
            confirmLabel: kind === 'trash' ? 'Empty trash' : 'Delete all',
            variant: 'danger',
            onConfirm: () => {
                setConfirmDialog(NO_CONFIRM)
                batchUpdate.mutate({ messageIds: emails.map((e) => e.id), action: 'delete' })
                setSelectedEmail(null)
                toast({ title: kind === 'trash' ? 'Trash emptied' : 'Spam folder emptied', variant: 'success' })
            },
        })
    }

    const handleToggleSelect = () => {
        if (!selectedEmail) return
        setSelectedEmails((prev) => {
            const next = new Set(prev)
            if (next.has(selectedEmail)) next.delete(selectedEmail)
            else next.add(selectedEmail)
            return next
        })
    }

    // Mirrors which reply/forward buttons each detail panel actually renders (see
    // EmailDetailView's replyActions and the Drafts/Trash/Spam panels above).
    const canReplyAll = kind !== 'drafts' && kind !== 'trash' && kind !== 'spam' && kind !== 'sent'
    const canForward = kind !== 'drafts' && kind !== 'trash' && kind !== 'spam'
    const canStar = kind !== 'drafts' && kind !== 'trash' && kind !== 'spam'

    useKeyboardShortcuts({
        enabled: true,
        onNavigate: (direction) => {
            if (emails.length === 0) return
            let newIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1
            newIndex = Math.max(0, Math.min(emails.length - 1, newIndex))
            if (emails[newIndex]) handleSelectEmail(emails[newIndex].id)
        },
        onReply: () => canReplyAll && selectedEmail && openCompose({ replyToId: selectedEmail }),
        onReplyAll: () => canReplyAll && selectedEmail && openCompose({ replyToId: selectedEmail, replyAll: true }),
        onForward: () => canForward && selectedEmail && openCompose({ forwardId: selectedEmail }),
        onArchive: handleArchiveSelected,
        onDelete: handleDeleteSelected,
        onStar: () => canStar && selectedEmail && handleStar(selectedEmail),
        onMarkRead: handleMarkReadSelected,
        onRefresh: handleRefresh,
        onCompose: () => openCompose(),
        onSelect: handleToggleSelect,
        onSelectAll: () => setSelectedEmails(new Set(emails.map((e) => e.id))),
        onDeselectAll: () => setSelectedEmails(new Set()),
        onEscape: () => {
            setSelectedEmail(null)
            setSelectedEmails(new Set())
        },
    })

    if (mailboxesLoading || isLoading) {
        return (
            <MailLayout>
                <LoadingState message={`Loading ${title.toLowerCase()}...`} />
            </MailLayout>
        )
    }

    if (mailboxes.length === 0) {
        return (
            <MailLayout>
                <div className="flex items-center justify-center h-full">
                    <div className="text-center max-w-md px-6">
                        <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center text-muted-foreground">
                            {emptyStateIcon ?? icon}
                        </div>
                        <h2 className="text-xl font-bold text-foreground mb-2">No Email Accounts Connected</h2>
                        <p className="text-muted-foreground mb-6">Add an email account to start using {title.toLowerCase()}.</p>
                        <button
                            type="button"
                            onClick={() => setShowConnectDialog(true)}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Add Email Account
                        </button>
                    </div>
                </div>
                <ConnectMailboxDialog open={showConnectDialog} onOpenChange={setShowConnectDialog} />
            </MailLayout>
        )
    }

    const headerRow = (
        <div className="px-4 py-2 border-b border-border bg-background">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {icon}
                    <h1 className="text-lg font-bold text-foreground">{title}</h1>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                        <button onClick={() => setFilter('all')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>All</button>
                        <button onClick={() => setFilter('unread')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'unread' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Unread {unreadCount > 0 && `(${unreadCount})`}</button>
                        {!crossFolder && (
                            <button onClick={() => setFilter('starred')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'starred' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Starred</button>
                        )}
                        <button onClick={() => setFilter('attachments')} className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'attachments' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Attachments</button>
                    </div>
                    {(kind === 'trash' || kind === 'spam') && emails.length > 0 && (
                        <div className="relative group">
                            <button
                                onClick={handleEmptyFolder}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-destructive transition-colors hover:bg-destructive/10"
                                aria-label={kind === 'trash' ? 'Empty trash' : 'Delete all spam'}
                            >
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
            <div className="relative mt-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                    type="text"
                    placeholder={`Search ${title.toLowerCase()}...`}
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    aria-label={`Search ${title.toLowerCase()}`}
                    className="w-full pl-8 pr-8 py-1.5 text-sm bg-muted border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {searchInput && (
                    <button
                        onClick={() => setSearchInput('')}
                        aria-label="Clear search"
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    )

    const listActions = {
        onToggleRead: kind === 'drafts' || kind === 'spam' || kind === 'trash' ? undefined : handleToggleRead,
        onStar: kind === 'drafts' || kind === 'spam' || kind === 'trash' ? undefined : handleStar,
        onArchive: kind === 'drafts' || kind === 'spam' || kind === 'trash'
            ? undefined
            : kind === 'archive' ? handleMoveToInbox : handleArchive,
        onSpam: kind === 'inbox' || kind === 'archive' || kind === 'starred' ? handleSpam : undefined,
        onDelete: handleDelete,
    }

    const toolbar = (
        <EmailToolbar
            selectedCount={selectedEmails.size}
            totalCount={total}
            onSelectAll={() => {
                if (selectedEmails.size === emails.length) setSelectedEmails(new Set())
                else setSelectedEmails(new Set(emails.map((e) => e.id)))
            }}
            onMarkRead={() => handleBulkRead(true)}
            onMarkUnread={() => handleBulkRead(false)}
            onDelete={handleBulkDelete}
            onArchive={handleBulkArchive}
            onSpam={kind === 'spam' || kind === 'inbox' || kind === 'archive' || kind === 'starred' ? handleBulkSpam : undefined}
            spamLabel={kind === 'spam' ? 'Not Spam' : 'Mark as spam'}
            onRefresh={handleRefresh}
            isRefreshing={isFetching || syncMailbox.isPending}
        />
    )

    const listNode = (
        <div className="flex-1 overflow-y-auto">
            <EmailList
                emails={emails}
                selectedId={selectedEmail || undefined}
                selectedEmails={selectedEmails}
                onSelect={handleSelectEmail}
                onSelectMultiple={(ids) => setSelectedEmails(new Set(ids))}
                {...listActions}
                emptyMessage={filter === 'all' ? emptyMessage : `No ${filter} messages`}
                isLoadingMore={isFetchingNextPage}
                hasMore={!!hasNextPage}
                loadMoreRef={loadMoreRef}
            />
        </div>
    )

    const detailNode = selectedEmailData ? (
        kind === 'trash' ? (
            <TrashDetailPanel email={selectedEmailData} onDelete={handleDelete} onRestore={handleRestore} />
        ) : kind === 'drafts' ? (
            <DraftDetailPanel
                email={selectedEmailData}
                onToggleRead={handleToggleRead}
                onArchive={handleArchive}
                onDelete={handleDelete}
                onStar={handleStar}
            />
        ) : kind === 'spam' ? (
            <SpamDetailPanel email={selectedEmailData} onNotSpam={handleNotSpam} onDelete={handleDelete} />
        ) : (
            <EmailDetailView
                email={selectedEmailData}
                onToggleRead={handleToggleRead}
                onArchive={kind === 'archive' ? handleMoveToInbox : handleArchive}
                onSpam={kind === 'sent' ? undefined : handleSpam}
                onDelete={handleDelete}
                onStar={handleStar}
                archiveTitle={kind === 'archive' ? 'Move to Inbox' : undefined}
                archiveAriaLabel={kind === 'archive' ? 'Move to Inbox' : undefined}
                archiveIcon={kind === 'archive' ? 'inbox' : undefined}
                replyActions={kind === 'sent' ? 'forwardOnly' : 'all'}
            />
        )
    ) : (
        <EmailDetailEmpty
            icon={icon}
            title={kind === 'drafts' ? 'Select a draft to edit' : `Select ${kind === 'starred' ? 'a starred' : 'an'} email`}
            description={
                kind === 'drafts'
                    ? 'Click on a draft to continue editing'
                    : 'Click on an email from the list to view its contents'
            }
        />
    )

    return (
        <MailLayout>
            {isMobile ? (
                <div className="flex h-full flex-col bg-background">
                    {headerRow}
                    {toolbar}
                    {listNode}
                </div>
            ) : (
                <ResizablePanels
                    storageKey={`mail-panels-${storageKey}`}
                    left={<>{headerRow}{toolbar}{listNode}</>}
                    right={detailNode}
                />
            )}
            <ConfirmDialog
                open={confirmDialog.open}
                onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
                title={confirmDialog.title}
                description={confirmDialog.description}
                confirmLabel={confirmDialog.confirmLabel}
                variant={confirmDialog.variant}
                onConfirm={confirmDialog.onConfirm}
            />
        </MailLayout>
    )
}

function TrashDetailPanel({
    email,
    onDelete,
    onRestore,
}: {
    email: EmailItem
    onDelete: (id: string) => void
    onRestore: (id: string) => void
}) {
    return (
        <div className="flex-1 overflow-y-auto">
            <div className="p-4">
                <div className="max-w-3xl mx-auto">
                    <div className="flex items-center gap-3 py-2 border-b border-border mb-3">
                        <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-medium text-xs flex-shrink-0">
                            {email.from.name?.[0]?.toUpperCase() || email.from.email?.[0]?.toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-foreground truncate">{email.from.name}</p>
                                <p className="text-xs text-muted-foreground flex-shrink-0">{email.date.toLocaleString()}</p>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">To: {email.to.map((t) => t.name || t.email).join(', ')}</p>
                        </div>
                    </div>
                    <h2 className="text-sm font-bold text-foreground mb-3">{email.subject}</h2>
                    <div className="flex items-center gap-2 mb-4">
                        <button
                            onClick={() => onRestore(email.id)}
                            className="px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-lg font-medium transition-colors"
                        >
                            Restore
                        </button>
                        <button
                            onClick={() => onDelete(email.id)}
                            className="px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded-lg font-medium transition-colors"
                        >
                            Delete forever
                        </button>
                    </div>
                    <p className="text-muted-foreground text-xs">This email will be permanently deleted after 30 days.</p>
                </div>
            </div>
        </div>
    )
}

function DraftDetailPanel({
    email,
    onToggleRead,
    onArchive,
    onDelete,
    onStar,
}: {
    email: EmailItem
    onToggleRead: (id: string) => void
    onArchive: (id: string) => void
    onDelete: (id: string) => void
    onStar: (id: string) => void
}) {
    const { openCompose } = useCompose()
    const { data: messageData, isLoading } = useMessage(email.id)
    const fullMessage = messageData?.message

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
                        onToggleRead={() => onToggleRead(email.id)}
                        onArchive={() => onArchive(email.id)}
                        onDelete={() => onDelete(email.id)}
                        onStar={() => onStar(email.id)}
                    />
                    <h2 className="text-sm font-bold text-foreground mb-3">{email.subject || '(No subject)'}</h2>
                    <div className="mt-4">
                        <EmailHtmlViewer
                            html={fullMessage?.bodyHtml || fullMessage?.htmlBody}
                            plainText={fullMessage?.bodyText || fullMessage?.plainBody || email.snippet}
                            isLoading={isLoading}
                            senderEmail={email.from.email}
                        />
                    </div>
                    <div className="mt-8 pt-6 border-t border-border flex items-center gap-3">
                        <button
                            onClick={() => openCompose({ draftId: email.id })}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Continue editing
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

function SpamDetailPanel({
    email,
    onNotSpam,
    onDelete,
}: {
    email: EmailItem
    onNotSpam: (id: string) => void
    onDelete: (id: string) => void
}) {
    const { data: messageData, isLoading } = useMessage(email.id)
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
                        isSpam
                        onSpam={() => onNotSpam(email.id)}
                        onDelete={() => onDelete(email.id)}
                        emailDarkMode={emailDarkMode}
                        onToggleEmailDarkMode={() => setEmailDarkMode(!emailDarkMode)}
                    />
                    <h2 className="text-sm font-bold text-foreground mb-3">{email.subject}</h2>
                    <div className="mt-4">
                        <EmailHtmlViewer
                            html={fullMessage?.bodyHtml || fullMessage?.htmlBody}
                            plainText={fullMessage?.bodyText || fullMessage?.plainBody || email.snippet}
                            emailDarkMode={emailDarkMode}
                            isLoading={isLoading}
                            senderEmail={email.from.email}
                        />
                    </div>
                    <div className="mt-8 pt-6 border-t border-border">
                        <p className="text-muted-foreground text-xs">Messages in Spam are automatically deleted after 30 days.</p>
                    </div>
                </div>
            </div>
        </div>
    )
}
