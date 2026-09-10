import React, { useState } from 'react'
import { Link, useLocation } from 'wouter'
import { MailLayout } from '../../components/mail/MailLayout'
import { EmailList, EmailItem, EmailToolbar } from '../../components/mail/EmailList'
import { toast } from '../../components/ui/toaster'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useCompose } from '../../hooks/useCompose'
import { useMailbox } from '../../hooks/useMailbox'
import { useSearchMessages, useMessage, useUpdateMessage, useDeleteMessage, useArchiveMessage, useBatchUpdate, useSpamMessage, mapMessageToEmailItem } from '../../hooks/useMail'
import { EmailHtmlViewer } from '../../components/mail/EmailHtmlViewer'
import { EmailMessageHeader } from '../../components/mail/EmailMessageHeader'
import {
    Search as SearchIcon,
    Filter,
    Calendar,
    Paperclip,
    User,
    Mail,
    AlertCircle
} from 'lucide-react'
import { ResizablePanels } from '../../components/mail/ResizablePanels'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'

// Radix Select items cannot carry an empty-string value, so "any" (hasAttachment === null) is
// sent as this sentinel and translated back at the boundary.
const ANY_ATTACHMENT_VALUE = '__any__'

interface SearchFilters {
    query: string
    from: string
    to: string
    subject: string
    hasAttachment: boolean | null
    dateRange: 'all' | 'today' | 'week' | 'month' | 'year'
    folder: string
}

const dateRangeLabels = {
    all: 'Any time',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    year: 'Last year'
}

export default function SearchPage() {
    const [location, navigate] = useLocation()
    const { selectedMailbox, mailboxes } = useMailbox()
    const isMobile = useIsMobile()

    const [filters, setFilters] = React.useState<SearchFilters>({
        query: '',
        from: '',
        to: '',
        subject: '',
        hasAttachment: null,
        dateRange: 'all',
        folder: ''
    })
    const [showFilters, setShowFilters] = React.useState(false)
    const [selectedEmail, setSelectedEmail] = React.useState<string | null>(null)
    const [selectedEmails, setSelectedEmails] = React.useState<Set<string>>(new Set())

    const effectiveQuery = [filters.query, filters.from && `from:${filters.from}`, filters.to && `to:${filters.to}`, filters.subject && `subject:${filters.subject}`].filter(Boolean).join(' ')

    const { data, isLoading, isFetching, refetch } = useSearchMessages(effectiveQuery, filters.folder || undefined)
    const updateMessage = useUpdateMessage()
    const deleteMessage = useDeleteMessage()
    const archiveMessage = useArchiveMessage()
    const batchUpdate = useBatchUpdate()
    const spamMessage = useSpamMessage()

    React.useEffect(() => {
        const params = new URLSearchParams(location.split('?')[1] || '')
        const q = params.get('q') || ''
        const folder = params.get('folder') || ''
        setFilters(prev => ({ ...prev, query: q, folder }))
    }, [location])

    const emails = React.useMemo(() => {
        if (!data?.messages) return []
        let results = data.messages.map(mapMessageToEmailItem)

        if (filters.hasAttachment !== null) {
            results = results.filter(e => filters.hasAttachment ? e.hasAttachments : !e.hasAttachments)
        }

        if (filters.dateRange !== 'all') {
            const now = new Date()
            let cutoff: Date
            switch (filters.dateRange) {
                case 'today':
                    cutoff = new Date(now.setHours(0, 0, 0, 0))
                    break
                case 'week':
                    cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
                    break
                case 'month':
                    cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
                    break
                case 'year':
                    cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
                    break
            }
            if (cutoff) {
                results = results.filter(e => e.date >= cutoff)
            }
        }

        return results
    }, [data, filters.hasAttachment, filters.dateRange])

    const selectedEmailData = React.useMemo(
        () => emails.find((email) => email.id === selectedEmail) || null,
        [emails, selectedEmail]
    )

    const activeFilterCount = [
        filters.from,
        filters.to,
        filters.subject,
        filters.hasAttachment !== null,
        filters.dateRange !== 'all',
        filters.folder
    ].filter(Boolean).length

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault()
        if (filters.query.trim()) {
            const params = new URLSearchParams()
            params.set('q', filters.query)
            if (filters.folder) params.set('folder', filters.folder)
            navigate(`/mail/search?${params}`)
            refetch()
        }
    }

    const handleClearFilters = () => {
        setFilters({
            query: filters.query,
            from: '',
            to: '',
            subject: '',
            hasAttachment: null,
            dateRange: 'all',
            folder: ''
        })
    }

    const handleSelectEmail = (id: string) => {
        if (isMobile) {
            navigate(`/mail/inbox/${id}`)
            return
        }
        setSelectedEmail(id)
    }

    const handleStar = (id: string) => {
        const email = emails.find(e => e.id === id)
        if (selectedMailbox) {
            updateMessage.mutate({ messageId: id, data: { starred: !email?.starred } })
        }
        toast({
            title: emails.find(e => e.id === id)?.starred ? 'Removed from starred' : 'Added to starred',
            variant: 'success'
        })
    }

    const handleToggleRead = (id: string) => {
        const email = emails.find(e => e.id === id)
        if (!email || !selectedMailbox) return

        updateMessage.mutate({ messageId: id, data: { read: !email.read } })
        toast({
            title: email.read ? 'Marked as unread' : 'Marked as read',
            variant: 'success',
        })
    }

    const handleDelete = (id: string) => {
        if (selectedEmail === id) {
            setSelectedEmail(null)
        }
        if (selectedMailbox) {
            deleteMessage.mutate(id)
        }
        setSelectedEmails(prev => {
            const newSet = new Set(prev)
            newSet.delete(id)
            return newSet
        })
        toast({ title: 'Email deleted', variant: 'success' })
    }

    const handleArchive = (id: string) => {
        if (selectedEmail === id) {
            setSelectedEmail(null)
        }
        if (selectedMailbox) {
            archiveMessage.mutate(id)
        }
        toast({ title: 'Email archived', variant: 'success' })
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
                            Add an email account to search your emails.
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

    return (
        <MailLayout>
            {isMobile ? (
                <div className="flex h-full flex-col bg-background">
                    <div className="px-4 sm:px-5 py-4 border-b border-border">
                        <form onSubmit={handleSearch} className="relative">
                            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                            <input
                                type="text"
                                placeholder="Search emails..."
                                value={filters.query}
                                onChange={(e) => setFilters({ ...filters, query: e.target.value })}
                                className="w-full pl-10 pr-12 py-2.5 bg-muted border-0 rounded-xl text-sm focus:ring-2 focus:ring-primary text-foreground placeholder-muted-foreground"
                                autoFocus
                            />
                            <button
                                type="button"
                                onClick={() => setShowFilters(!showFilters)}
                                className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${
                                    showFilters || activeFilterCount > 0
                                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600'
                                        : 'hover:bg-accent text-muted-foreground'
                                }`}
                            >
                                <Filter className="w-4 h-4" />
                                {activeFilterCount > 0 && (
                                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-600 text-white text-xs rounded-full flex items-center justify-center">
                                        {activeFilterCount}
                                    </span>
                                )}
                            </button>
                        </form>

                        {showFilters && (
                            <div className="mt-4 p-4 bg-muted/50 rounded-xl space-y-3">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm font-medium text-foreground">Filters</span>
                                    {activeFilterCount > 0 && (
                                        <button
                                            onClick={handleClearFilters}
                                            className="text-sm text-primary hover:text-primary/80"
                                        >
                                            Clear all
                                        </button>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                            <User className="w-3 h-3" />
                                            From
                                        </label>
                                        <input
                                            type="text"
                                            placeholder="sender@example.com"
                                            value={filters.from}
                                            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                                        />
                                    </div>

                                    <div>
                                        <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                            <Mail className="w-3 h-3" />
                                            To
                                        </label>
                                        <input
                                            type="text"
                                            placeholder="recipient@example.com"
                                            value={filters.to}
                                            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                                        />
                                    </div>

                                    <div className="sm:col-span-2">
                                        <label className="text-xs text-muted-foreground mb-1 block">
                                            Subject contains
                                        </label>
                                        <input
                                            type="text"
                                            placeholder="Keywords in subject"
                                            value={filters.subject}
                                            onChange={(e) => setFilters({ ...filters, subject: e.target.value })}
                                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                                        />
                                    </div>

                                    <div>
                                        <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                            <Calendar className="w-3 h-3" />
                                            Date
                                        </label>
                                        <Select
                                            value={filters.dateRange}
                                            onValueChange={(value) => setFilters({ ...filters, dateRange: value as SearchFilters['dateRange'] })}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {Object.entries(dateRangeLabels).map(([value, label]) => (
                                                    <SelectItem key={value} value={value}>{label}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div>
                                        <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                            <Paperclip className="w-3 h-3" />
                                            Attachments
                                        </label>
                                        <Select
                                            value={filters.hasAttachment === null ? ANY_ATTACHMENT_VALUE : filters.hasAttachment ? 'yes' : 'no'}
                                            onValueChange={(value) => setFilters({
                                                ...filters,
                                                hasAttachment: value === ANY_ATTACHMENT_VALUE ? null : value === 'yes'
                                            })}
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value={ANY_ATTACHMENT_VALUE}>Any</SelectItem>
                                                <SelectItem value="yes">Has attachments</SelectItem>
                                                <SelectItem value="no">No attachments</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="mt-3 flex items-center justify-between">
                            <h1 className="text-lg font-semibold text-foreground">
                                Search Results
                            </h1>
                            {!isLoading && (
                                <p className="text-sm text-muted-foreground">
                                    {emails.length} {emails.length === 1 ? 'result' : 'results'}
                                    {filters.query && ` for "${filters.query}"`}
                                </p>
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
                                setSelectedEmails(new Set(emails.map(e => e.id)))
                            }
                        }}
                        onMarkRead={() => {
                            if (selectedMailbox) {
                                batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'read' })
                            }
                            setSelectedEmails(new Set())
                        }}
                        onMarkUnread={() => {
                            if (selectedMailbox) {
                                batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'unread' })
                            }
                            setSelectedEmails(new Set())
                        }}
                        onDelete={() => {
                            if (selectedMailbox) {
                                batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'delete' })
                            }
                            setSelectedEmails(new Set())
                            toast({ title: 'Emails deleted', variant: 'success' })
                        }}
                        onArchive={() => {
                            if (selectedMailbox) {
                                batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'archive' })
                            }
                            setSelectedEmails(new Set())
                            toast({ title: 'Emails archived', variant: 'success' })
                        }}
                        onSpam={() => {
                            if (selectedMailbox) {
                                batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'spam' })
                            }
                            setSelectedEmails(new Set())
                            toast({ title: 'Emails marked as spam', variant: 'success' })
                        }}
                        onRefresh={() => {
                            refetch()
                            toast({ title: 'Search refreshed', variant: 'success' })
                        }}
                        isRefreshing={isFetching}
                    />

                    <div className="flex-1 overflow-y-auto">
                        {isLoading ? (
                            <div className="flex items-center justify-center h-64">
                                <div className="flex flex-col items-center gap-4">
                                    <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                    <p className="text-muted-foreground">Searching...</p>
                                </div>
                            </div>
                        ) : !filters.query ? (
                            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                                <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                                <p className="text-lg font-medium">Search your emails</p>
                                <p className="text-sm mt-1">Enter keywords to find emails</p>
                            </div>
                        ) : emails.length > 0 ? (
                            <EmailList
                                emails={emails}
                                selectedId={selectedEmail || undefined}
                                selectedEmails={selectedEmails}
                                onSelect={handleSelectEmail}
                                onSelectMultiple={(ids) => setSelectedEmails(new Set(ids))}
                                onStar={handleStar}
                                onDelete={handleDelete}
                                onArchive={handleArchive}
                                onSpam={handleSpam}
                                emptyMessage="No results found"
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                                <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                                <p className="text-lg font-medium">No results found</p>
                                <p className="text-sm mt-1">Try different keywords or check your spelling</p>
                                {activeFilterCount > 0 && (
                                    <button
                                        onClick={handleClearFilters}
                                        className="mt-4 text-sm text-blue-600 hover:text-blue-700"
                                    >
                                        Clear filters
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <ResizablePanels
                    storageKey="mail-panels-search"
                    left={
                        <>
                            <div className="px-4 sm:px-5 py-4 border-b border-border">
                                <form onSubmit={handleSearch} className="relative">
                                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                                    <input
                                        type="text"
                                        placeholder="Search emails..."
                                        value={filters.query}
                                        onChange={(e) => setFilters({ ...filters, query: e.target.value })}
                                        className="w-full pl-10 pr-12 py-2.5 bg-muted border-0 rounded-xl text-sm focus:ring-2 focus:ring-primary text-foreground placeholder-muted-foreground"
                                        autoFocus
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowFilters(!showFilters)}
                                        className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${
                                            showFilters || activeFilterCount > 0
                                                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600'
                                                : 'hover:bg-accent text-muted-foreground'
                                        }`}
                                    >
                                        <Filter className="w-4 h-4" />
                                        {activeFilterCount > 0 && (
                                            <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-600 text-white text-xs rounded-full flex items-center justify-center">
                                                {activeFilterCount}
                                            </span>
                                        )}
                                    </button>
                                </form>

                                {showFilters && (
                                    <div className="mt-4 p-4 bg-muted/50 rounded-xl space-y-3">
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-sm font-medium text-foreground">Filters</span>
                                            {activeFilterCount > 0 && (
                                                <button
                                                    onClick={handleClearFilters}
                                                    className="text-sm text-primary hover:text-primary/80"
                                                >
                                                    Clear all
                                                </button>
                                            )}
                                        </div>

                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            <div>
                                                <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                                    <User className="w-3 h-3" />
                                                    From
                                                </label>
                                                <input
                                                    type="text"
                                                    placeholder="sender@example.com"
                                                    value={filters.from}
                                                    onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                                                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                                                />
                                            </div>

                                            <div>
                                                <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                                    <Mail className="w-3 h-3" />
                                                    To
                                                </label>
                                                <input
                                                    type="text"
                                                    placeholder="recipient@example.com"
                                                    value={filters.to}
                                                    onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                                                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                                                />
                                            </div>

                                            <div className="sm:col-span-2">
                                                <label className="text-xs text-muted-foreground mb-1 block">
                                                    Subject contains
                                                </label>
                                                <input
                                                    type="text"
                                                    placeholder="Keywords in subject"
                                                    value={filters.subject}
                                                    onChange={(e) => setFilters({ ...filters, subject: e.target.value })}
                                                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary"
                                                />
                                            </div>

                                            <div>
                                                <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                                    <Calendar className="w-3 h-3" />
                                                    Date
                                                </label>
                                                <Select
                                                    value={filters.dateRange}
                                                    onValueChange={(value) => setFilters({ ...filters, dateRange: value as SearchFilters['dateRange'] })}
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {Object.entries(dateRangeLabels).map(([value, label]) => (
                                                            <SelectItem key={value} value={value}>{label}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>

                                            <div>
                                                <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                                    <Paperclip className="w-3 h-3" />
                                                    Attachments
                                                </label>
                                                <Select
                                                    value={filters.hasAttachment === null ? ANY_ATTACHMENT_VALUE : filters.hasAttachment ? 'yes' : 'no'}
                                                    onValueChange={(value) => setFilters({
                                                        ...filters,
                                                        hasAttachment: value === ANY_ATTACHMENT_VALUE ? null : value === 'yes'
                                                    })}
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value={ANY_ATTACHMENT_VALUE}>Any</SelectItem>
                                                        <SelectItem value="yes">Has attachments</SelectItem>
                                                        <SelectItem value="no">No attachments</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="mt-3 flex items-center justify-between">
                                    <h1 className="text-lg font-semibold text-foreground">
                                        Search Results
                                    </h1>
                                    {!isLoading && (
                                        <p className="text-sm text-muted-foreground">
                                            {emails.length} {emails.length === 1 ? 'result' : 'results'}
                                            {filters.query && ` for "${filters.query}"`}
                                        </p>
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
                                        setSelectedEmails(new Set(emails.map(e => e.id)))
                                    }
                                }}
                                onMarkRead={() => {
                                    if (selectedMailbox) {
                                        batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'read' })
                                    }
                                    setSelectedEmails(new Set())
                                }}
                                onMarkUnread={() => {
                                    if (selectedMailbox) {
                                        batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'unread' })
                                    }
                                    setSelectedEmails(new Set())
                                }}
                                onDelete={() => {
                                    if (selectedMailbox) {
                                        batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'delete' })
                                    }
                                    setSelectedEmails(new Set())
                                    toast({ title: 'Emails deleted', variant: 'success' })
                                }}
                                onArchive={() => {
                                    if (selectedMailbox) {
                                        batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'archive' })
                                    }
                                    setSelectedEmails(new Set())
                                    toast({ title: 'Emails archived', variant: 'success' })
                                }}
                                onSpam={() => {
                                    if (selectedMailbox) {
                                        batchUpdate.mutate({ messageIds: Array.from(selectedEmails), action: 'spam' })
                                    }
                                    setSelectedEmails(new Set())
                                    toast({ title: 'Emails marked as spam', variant: 'success' })
                                }}
                                onRefresh={() => {
                                    refetch()
                                    toast({ title: 'Search refreshed', variant: 'success' })
                                }}
                                isRefreshing={isFetching}
                            />

                            <div className="flex-1 overflow-y-auto">
                                {isLoading ? (
                                    <div className="flex items-center justify-center h-64">
                                        <div className="flex flex-col items-center gap-4">
                                            <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                            <p className="text-muted-foreground">Searching...</p>
                                        </div>
                                    </div>
                                ) : !filters.query ? (
                                    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                                        <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                                        <p className="text-lg font-medium">Search your emails</p>
                                        <p className="text-sm mt-1">Enter keywords to find emails</p>
                                    </div>
                                ) : emails.length > 0 ? (
                                    <EmailList
                                        emails={emails}
                                        selectedId={selectedEmail || undefined}
                                        selectedEmails={selectedEmails}
                                        onSelect={handleSelectEmail}
                                        onSelectMultiple={(ids) => setSelectedEmails(new Set(ids))}
                                        onStar={handleStar}
                                        onDelete={handleDelete}
                                        onArchive={handleArchive}
                                        onSpam={handleSpam}
                                        emptyMessage="No results found"
                                    />
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                                        <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                                        <p className="text-lg font-medium">No results found</p>
                                        <p className="text-sm mt-1">Try different keywords or check your spelling</p>
                                        {activeFilterCount > 0 && (
                                            <button
                                                onClick={handleClearFilters}
                                                className="mt-4 text-sm text-blue-600 hover:text-blue-700"
                                            >
                                                Clear filters
                                            </button>
                                        )}
                                    </div>
                                )}
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
                                        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                                            <SearchIcon className="w-10 h-10 text-muted-foreground" />
                                        </div>
                                        <p className="text-lg font-medium text-foreground">Select a result to preview</p>
                                        <p className="text-sm mt-1">Click on an email from the search results</p>
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
                    <h2 className="text-sm font-bold text-foreground mb-3">{email.subject}</h2>

                    <div className="mt-4">
                        <EmailHtmlViewer
                            html={fullMessage?.bodyHtml || fullMessage?.htmlBody}
                            plainText={fullMessage?.bodyText || fullMessage?.plainBody || email.snippet}
                            emailDarkMode={emailDarkMode}
                            isLoading={isMessageLoading}
                            senderEmail={email.from.email}
                        />
                    </div>

                    <div className="mt-8 pt-6 border-t border-border flex items-center gap-3">
                        <button
                            onClick={() => openCompose({ replyToId: email.id })}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Reply
                        </button>
                        <button
                            onClick={() => openCompose({ forwardId: email.id })}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg font-medium transition-colors"
                        >
                            Forward
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
