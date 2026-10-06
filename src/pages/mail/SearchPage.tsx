import React from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { MailLayout } from '../../components/mail/MailLayout'
import { EmailList, EmailToolbar } from '../../components/mail/EmailList'
import { EmailDetailView } from '../../components/mail/EmailDetailView'
import { toast } from '../../components/ui/toaster'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useMailbox } from '../../hooks/useMailbox'
import { useDebounce, useInfiniteScroll } from '../../hooks/useInfiniteScroll'
import {
    useInfiniteSearch,
    useUpdateMessage,
    useDeleteMessage,
    useArchiveMessage,
    useBatchUpdate,
    useSpamMessage,
    mapMessageToEmailItem,
} from '../../hooks/useMail'
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
import {
    buildSearchQuery,
    EMPTY_SEARCH_FILTERS,
    type SearchDateRange,
    type SearchFilters,
} from './search-query'

// Radix Select items cannot carry an empty-string value, so "any" (hasAttachment === null) is
// sent as this sentinel and translated back at the boundary.
const ANY_ATTACHMENT_VALUE = '__any__'

const dateRangeLabels: Record<SearchDateRange, string> = {
    all: 'Any time',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    year: 'Last year'
}

export default function SearchPage() {
    const [, navigate] = useLocation()
    // wouter's useLocation() carries only the pathname; the query string lives in useSearch().
    const search = useSearch()
    const { selectedMailbox, mailboxes } = useMailbox()
    const isMobile = useIsMobile()

    const urlParams = React.useMemo(() => new URLSearchParams(search), [search])
    const urlQuery = urlParams.get('q') || ''
    const urlFolder = urlParams.get('folder') || ''

    const [filters, setFilters] = React.useState<SearchFilters>({
        ...EMPTY_SEARCH_FILTERS,
        query: urlQuery,
        folder: urlFolder,
    })
    const [showFilters, setShowFilters] = React.useState(false)
    const [selectedEmail, setSelectedEmail] = React.useState<string | null>(null)
    const [selectedEmails, setSelectedEmails] = React.useState<Set<string>>(new Set())

    // Header search (and shared links) land here through the URL: mirror it into the input.
    React.useEffect(() => {
        setFilters(prev => (prev.query === urlQuery && prev.folder === urlFolder
            ? prev
            : { ...prev, query: urlQuery, folder: urlFolder }))
    }, [urlQuery, urlFolder])

    const effectiveQuery = buildSearchQuery(filters)
    const debouncedQuery = useDebounce(effectiveQuery, 300)

    const {
        data,
        isLoading,
        isError,
        isFetching,
        isFetchingNextPage,
        hasNextPage,
        fetchNextPage,
        refetch,
    } = useInfiniteSearch(debouncedQuery, filters.folder || undefined)
    const updateMessage = useUpdateMessage()
    const deleteMessage = useDeleteMessage()
    const archiveMessage = useArchiveMessage()
    const batchUpdate = useBatchUpdate()
    const spamMessage = useSpamMessage()

    const { loadMoreRef } = useInfiniteScroll({
        hasMore: !!hasNextPage,
        isLoading: isFetchingNextPage,
        onLoadMore: () => { void fetchNextPage() },
    })

    const emails = React.useMemo(
        () => data?.pages.flatMap(page => page.messages.map(mapMessageToEmailItem)) ?? [],
        [data]
    )
    const total = data?.pages[0]?.total ?? emails.length

    // A new search (or another mailbox) must not keep acting on rows that are gone.
    React.useEffect(() => {
        setSelectedEmails(new Set())
        setSelectedEmail(null)
    }, [debouncedQuery, selectedMailbox?.id])

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

    const hasQuery = debouncedQuery.trim().length >= 2

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault()
        const params = new URLSearchParams()
        if (filters.query.trim()) params.set('q', filters.query.trim())
        if (filters.folder) params.set('folder', filters.folder)
        navigate(`/mail/search?${params}`)
        void refetch()
    }

    const handleClearFilters = () => {
        setFilters({ ...EMPTY_SEARCH_FILTERS, query: filters.query })
    }

    const handleSelectEmail = (id: string) => {
        if (isMobile) {
            navigate(`/mail/inbox/${id}`)
            return
        }
        setSelectedEmail(id)
    }

    const forgetSelection = (id: string) => {
        setSelectedEmails(prev => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
        })
    }

    const handleStar = (id: string) => {
        const email = emails.find(e => e.id === id)
        if (selectedMailbox) {
            updateMessage.mutate({ messageId: id, data: { starred: !email?.starred } })
        }
        toast({ title: email?.starred ? 'Removed from starred' : 'Added to starred', variant: 'success' })
    }

    const handleToggleRead = (id: string) => {
        const email = emails.find(e => e.id === id)
        if (!email || !selectedMailbox) return

        updateMessage.mutate({ messageId: id, data: { read: !email.read } })
        toast({ title: email.read ? 'Marked as unread' : 'Marked as read', variant: 'success' })
    }

    const handleDelete = (id: string) => {
        if (selectedEmail === id) setSelectedEmail(null)
        if (selectedMailbox) deleteMessage.mutate(id)
        forgetSelection(id)
        toast({ title: 'Email moved to trash', variant: 'success' })
    }

    const handleArchive = (id: string) => {
        if (selectedEmail === id) setSelectedEmail(null)
        if (selectedMailbox) archiveMessage.mutate(id)
        forgetSelection(id)
        toast({ title: 'Email archived', variant: 'success' })
    }

    const handleSpam = (id: string) => {
        if (selectedEmail === id) setSelectedEmail(null)
        if (selectedMailbox) spamMessage.mutate({ messageId: id, isSpam: true })
        forgetSelection(id)
        toast({ title: 'Marked as spam', variant: 'success' })
    }

    const runBulk = (action: 'read' | 'unread' | 'delete' | 'archive' | 'spam', message?: string) => {
        const ids = Array.from(selectedEmails)
        if (ids.length === 0) return
        if (selectedMailbox) batchUpdate.mutate({ messageIds: ids, action })
        setSelectedEmails(new Set())
        if (message) toast({ title: `${ids.length} ${message}`, variant: 'success' })
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

    const filterInputClass = 'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary/20 focus:border-primary'

    const searchHeader = (
        <div className="px-4 sm:px-5 py-4 border-b border-border">
            <form onSubmit={handleSearch} className="relative" role="search">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                <input
                    type="text"
                    placeholder="Search emails..."
                    aria-label="Search emails"
                    value={filters.query}
                    onChange={(e) => setFilters({ ...filters, query: e.target.value })}
                    className="w-full pl-10 pr-12 py-2.5 bg-muted border-0 rounded-xl text-sm focus:ring-2 focus:ring-primary text-foreground placeholder-muted-foreground"
                    autoFocus
                />
                <button
                    type="button"
                    onClick={() => setShowFilters(!showFilters)}
                    aria-label="Toggle search filters"
                    aria-expanded={showFilters}
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
                                type="button"
                                onClick={handleClearFilters}
                                className="text-sm text-primary hover:text-primary/80"
                            >
                                Clear all
                            </button>
                        )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="search-from" className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                <User className="w-3 h-3" />
                                From
                            </label>
                            <input
                                id="search-from"
                                type="text"
                                placeholder="sender@example.com"
                                value={filters.from}
                                onChange={(e) => setFilters({ ...filters, from: e.target.value })}
                                className={filterInputClass}
                            />
                        </div>

                        <div>
                            <label htmlFor="search-to" className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                <Mail className="w-3 h-3" />
                                To
                            </label>
                            <input
                                id="search-to"
                                type="text"
                                placeholder="recipient@example.com"
                                value={filters.to}
                                onChange={(e) => setFilters({ ...filters, to: e.target.value })}
                                className={filterInputClass}
                            />
                        </div>

                        <div className="sm:col-span-2">
                            <label htmlFor="search-subject" className="text-xs text-muted-foreground mb-1 block">
                                Subject contains
                            </label>
                            <input
                                id="search-subject"
                                type="text"
                                placeholder="Keywords in subject"
                                value={filters.subject}
                                onChange={(e) => setFilters({ ...filters, subject: e.target.value })}
                                className={filterInputClass}
                            />
                        </div>

                        <div>
                            <span className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                <Calendar className="w-3 h-3" />
                                Date
                            </span>
                            <Select
                                value={filters.dateRange}
                                onValueChange={(value) => setFilters({ ...filters, dateRange: value as SearchDateRange })}
                            >
                                <SelectTrigger aria-label="Date range">
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
                            <span className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                                <Paperclip className="w-3 h-3" />
                                Attachments
                            </span>
                            <Select
                                value={filters.hasAttachment === null ? ANY_ATTACHMENT_VALUE : filters.hasAttachment ? 'yes' : 'no'}
                                onValueChange={(value) => setFilters({
                                    ...filters,
                                    hasAttachment: value === ANY_ATTACHMENT_VALUE ? null : value === 'yes'
                                })}
                            >
                                <SelectTrigger aria-label="Attachments">
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
                {hasQuery && !isLoading && !isError && (
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                        {total} {total === 1 ? 'result' : 'results'}
                        {filters.query && ` for "${filters.query}"`}
                        {selectedMailbox && ` in ${selectedMailbox.email}`}
                    </p>
                )}
            </div>
        </div>
    )

    const searchToolbar = (
        <EmailToolbar
            selectedCount={selectedEmails.size}
            totalCount={hasQuery ? total : undefined}
            onSelectAll={() => {
                if (selectedEmails.size === emails.length) {
                    setSelectedEmails(new Set())
                } else {
                    setSelectedEmails(new Set(emails.map(e => e.id)))
                }
            }}
            onMarkRead={() => runBulk('read')}
            onMarkUnread={() => runBulk('unread')}
            onDelete={() => runBulk('delete', 'emails moved to trash')}
            onArchive={() => runBulk('archive', 'emails archived')}
            onSpam={() => runBulk('spam', 'emails marked as spam')}
            onRefresh={() => { void refetch() }}
            isRefreshing={isFetching}
        />
    )

    const results = (
        <div className="flex-1 overflow-y-auto">
            {isLoading ? (
                <div className="flex items-center justify-center h-64">
                    <div className="flex flex-col items-center gap-4">
                        <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        <p className="text-muted-foreground">Searching...</p>
                    </div>
                </div>
            ) : !hasQuery ? (
                <div className="flex flex-col items-center justify-center h-64 px-6 text-center text-muted-foreground">
                    <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                    <p className="text-lg font-medium">Search your emails</p>
                    <p className="text-sm mt-1">Enter keywords to find emails</p>
                    <p className="text-xs mt-3 max-w-sm">
                        Tip: combine words with operators such as from:ana, to:bob, subject:invoice,
                        has:attachment, is:unread, before:2026-01-31 or in:sent.
                    </p>
                </div>
            ) : isError ? (
                <div role="alert" className="flex flex-col items-center justify-center h-64 px-6 text-center text-muted-foreground">
                    <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                    <p className="text-lg font-medium text-foreground">Search failed</p>
                    <p className="text-sm mt-1">Something went wrong on our side. Your mail is fine.</p>
                    <button
                        type="button"
                        onClick={() => { void refetch() }}
                        className="mt-4 text-sm text-blue-600 hover:text-blue-700"
                    >
                        Try again
                    </button>
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
                    isLoadingMore={isFetchingNextPage}
                    hasMore={!!hasNextPage}
                    loadMoreRef={loadMoreRef}
                />
            ) : (
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                    <SearchIcon className="w-12 h-12 mb-4 opacity-50" />
                    <p className="text-lg font-medium">No results found</p>
                    <p className="text-sm mt-1">Try different keywords or check your spelling</p>
                    {activeFilterCount > 0 && (
                        <button
                            type="button"
                            onClick={handleClearFilters}
                            className="mt-4 text-sm text-blue-600 hover:text-blue-700"
                        >
                            Clear filters
                        </button>
                    )}
                </div>
            )}
        </div>
    )

    return (
        <MailLayout>
            {isMobile ? (
                <div className="flex h-full flex-col bg-background">
                    {searchHeader}
                    {searchToolbar}
                    {results}
                </div>
            ) : (
                <ResizablePanels
                    storageKey="mail-panels"
                    left={<>{searchHeader}{searchToolbar}{results}</>}
                    right={
                        selectedEmailData ? (
                            <EmailDetailView
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
                        )
                    }
                />
            )}
        </MailLayout>
    )
}
