import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Eye, RefreshCw, Search, Trash2, Mail, ArrowUpRight, ArrowDownLeft } from 'lucide-react'
import { Card, CardContent } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/Table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { toast } from '../../ui/toaster'
import { apiFetch } from './shared'

interface Message {
    id: string
    organizationId: string
    messageId: string | null
    token: string
    direction: 'incoming' | 'outgoing'
    fromAddress: string
    fromName: string | null
    toAddresses: string[]
    subject: string | null
    plainBody?: string | null
    htmlBody?: string | null
    status: 'pending' | 'queued' | 'sent' | 'delivered' | 'bounced' | 'held' | 'failed'
    held: boolean
    heldReason: string | null
    spamScore: number | null
    sentAt: string | null
    deliveredAt: string | null
    openedAt: string | null
    createdAt: string
}

interface MessagesTabProps {
    organizationId: string
}

export default function MessagesTab({ organizationId }: MessagesTabProps) {
    const [messages, setMessages] = useState<Message[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState('all')
    const [directionFilter, setDirectionFilter] = useState('all')
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null)
    const [isLoadingMessage, setIsLoadingMessage] = useState(false)
    const [messageToDelete, setMessageToDelete] = useState<Message | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    useEffect(() => {
        void fetchMessages()
    }, [organizationId, statusFilter, directionFilter])

    async function fetchMessages() {
        setIsLoading(true)
        setError(null)
        try {
            const params = new URLSearchParams({ organizationId })
            if (statusFilter !== 'all') params.set('status', statusFilter)
            if (directionFilter !== 'all') params.set('direction', directionFilter)

            const data = await apiFetch<{ messages: Message[] }>(`/api/messages?${params.toString()}`)
            setMessages(data.messages || [])
        } catch (err) {
            console.error('Error fetching messages:', err)
            setError(err instanceof Error ? err.message : 'Failed to load messages')
        } finally {
            setIsLoading(false)
        }
    }

    const filteredMessages = useMemo(() => (
        messages.filter((message) => (
            message.subject?.toLowerCase().includes(searchQuery.toLowerCase()) ||
            message.fromAddress.toLowerCase().includes(searchQuery.toLowerCase()) ||
            message.toAddresses.some((address) => address.toLowerCase().includes(searchQuery.toLowerCase()))
        ))
    ), [messages, searchQuery])

    // The list response omits plainBody/htmlBody, so opening a message must fetch the
    // full record from GET /api/messages/:id to show its body.
    async function openMessage(message: Message) {
        setSelectedMessage(message)
        setIsLoadingMessage(true)
        try {
            const data = await apiFetch<{ message: Message }>(`/api/messages/${message.id}`)
            setSelectedMessage(data.message)
        } catch (error) {
            console.error('Error fetching message:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load message', variant: 'destructive' })
        } finally {
            setIsLoadingMessage(false)
        }
    }

    async function handleDeleteMessage() {
        if (!messageToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/messages/${messageToDelete.id}`, {
                method: 'DELETE',
            })

            setMessages((current) => current.filter((message) => message.id !== messageToDelete.id))
            if (selectedMessage?.id === messageToDelete.id) {
                setSelectedMessage(null)
            }
            toast({ title: 'Message deleted', variant: 'success' })
            setMessageToDelete(null)
        } catch (error) {
            console.error('Error deleting message:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete message', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    async function handleReleaseHeld(messageId: string) {
        try {
            const data = await apiFetch<{ message: Message }>(`/api/messages/${messageId}/release`, {
                method: 'POST',
            })

            setMessages((current) => current.map((message) => message.id === messageId ? data.message : message))
            if (selectedMessage?.id === messageId) {
                setSelectedMessage(data.message)
            }
            toast({ title: 'Message released', variant: 'success' })
        } catch (error) {
            console.error('Error releasing message:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to release message', variant: 'destructive' })
        }
    }

    function getStatusColor(status: Message['status']) {
        switch (status) {
            case 'delivered':
                return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
            case 'sent':
                return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
            case 'bounced':
            case 'failed':
                return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
            case 'held':
                return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
            case 'queued':
                return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
            default:
                return 'bg-muted text-muted-foreground'
        }
    }

    function formatDate(value: string | null) {
        return value ? new Date(value).toLocaleString() : 'Never'
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Messages</h3>
                    <p className="text-sm text-muted-foreground">Inspect message flow, filters and held queue handling.</p>
                </div>
                <Button variant="outline" onClick={() => void fetchMessages()}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh
                </Button>
            </div>

            <div className="flex flex-col gap-4 md:flex-row md:items-center">
                <div className="flex gap-3">
                    <select
                        aria-label="Status filter"
                        className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={statusFilter}
                        onChange={(event) => setStatusFilter(event.target.value)}
                    >
                        <option value="all">All Status</option>
                        <option value="pending">Pending</option>
                        <option value="queued">Queued</option>
                        <option value="sent">Sent</option>
                        <option value="delivered">Delivered</option>
                        <option value="bounced">Bounced</option>
                        <option value="held">Held</option>
                        <option value="failed">Failed</option>
                    </select>
                    <select
                        aria-label="Direction filter"
                        className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={directionFilter}
                        onChange={(event) => setDirectionFilter(event.target.value)}
                    >
                        <option value="all">All Directions</option>
                        <option value="incoming">Incoming</option>
                        <option value="outgoing">Outgoing</option>
                    </select>
                </div>
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder="Search messages..."
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                    />
                </div>
            </div>

            {isLoading ? (
                <div className="flex justify-center p-8">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
            ) : error ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => void fetchMessages()}>
                        Try again
                    </Button>
                </div>
            ) : filteredMessages.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <Mail className="mb-4 h-12 w-12 text-muted-foreground" />
                        <p className="text-muted-foreground">No messages found for the current filters.</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="rounded-lg border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Status</TableHead>
                                <TableHead>Direction</TableHead>
                                <TableHead>From</TableHead>
                                <TableHead>To</TableHead>
                                <TableHead>Subject</TableHead>
                                <TableHead>Spam</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredMessages.map((message) => (
                                <TableRow
                                    key={message.id}
                                    className="cursor-pointer"
                                    onClick={() => void openMessage(message)}
                                >
                                    <TableCell>
                                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${getStatusColor(message.status)}`}>
                                            {message.status}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <span className={`inline-flex items-center gap-1.5 text-sm ${message.direction === 'outgoing' ? 'text-blue-600 dark:text-blue-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                                            {message.direction === 'outgoing' ? (
                                                <ArrowUpRight className="h-4 w-4" />
                                            ) : (
                                                <ArrowDownLeft className="h-4 w-4" />
                                            )}
                                            {message.direction}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <div className="font-medium">{message.fromName || message.fromAddress}</div>
                                        {message.fromName && (
                                            <div className="text-xs text-muted-foreground">{message.fromAddress}</div>
                                        )}
                                    </TableCell>
                                    <TableCell className="max-w-[200px]">
                                        <div className="truncate">
                                            {message.toAddresses.slice(0, 2).join(', ')}
                                            {message.toAddresses.length > 2 && (
                                                <span className="ml-1 text-xs text-muted-foreground">+{message.toAddresses.length - 2} more</span>
                                            )}
                                        </div>
                                    </TableCell>
                                    <TableCell className="max-w-[250px]">
                                        <div className="truncate" title={message.subject || '(No subject)'}>
                                            {message.subject || '(No subject)'}
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        {message.spamScore !== null ? (
                                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${message.spamScore >= 5
                                                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                                    : message.spamScore >= 3
                                                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                                                        : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                }`}>
                                                {message.spamScore}/10
                                            </span>
                                        ) : (
                                            <span className="text-muted-foreground">-</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {formatDate(message.createdAt)}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            {message.held && (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={(event) => {
                                                        event.stopPropagation()
                                                        void handleReleaseHeld(message.id)
                                                    }}
                                                >
                                                    Release
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="View message"
                                                onClick={(event) => {
                                                    event.stopPropagation()
                                                    void openMessage(message)
                                                }}
                                            >
                                                <Eye className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Delete message"
                                                onClick={(event) => {
                                                    event.stopPropagation()
                                                    setMessageToDelete(message)
                                                }}
                                            >
                                                <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <ConfirmDialog
                open={messageToDelete !== null}
                onOpenChange={(open) => { if (!open) setMessageToDelete(null) }}
                title="Delete message"
                description="This message will be permanently deleted. This action cannot be undone."
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteMessage()}
            />

            <Dialog open={selectedMessage !== null} onOpenChange={(open) => { if (!open) setSelectedMessage(null) }}>
                <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Message Details</DialogTitle>
                        <DialogDescription>View message metadata, body and status history.</DialogDescription>
                    </DialogHeader>
                    {selectedMessage && (
                        <div className="space-y-6">
                            <div className="grid gap-6 md:grid-cols-2">
                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Message ID</Label>
                                    <div className="rounded-md bg-muted px-3 py-2 font-mono text-sm">{selectedMessage.messageId || 'N/A'}</div>
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Status</Label>
                                    <div>
                                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${getStatusColor(selectedMessage.status)}`}>
                                            {selectedMessage.status}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="grid gap-6 md:grid-cols-2">
                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">From</Label>
                                    <div className="text-sm">
                                        {selectedMessage.fromName && <div className="font-medium">{selectedMessage.fromName}</div>}
                                        <div className="text-muted-foreground">{selectedMessage.fromAddress}</div>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">To</Label>
                                    <div className="text-sm">{selectedMessage.toAddresses.join(', ')}</div>
                                </div>
                            </div>

                            <div className="space-y-1">
                                <Label className="text-muted-foreground">Subject</Label>
                                <div className="text-sm font-medium">{selectedMessage.subject || '(No subject)'}</div>
                            </div>

                            {selectedMessage.held && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                                    <div className="font-medium">Message Held</div>
                                    <div className="mt-1">{selectedMessage.heldReason || 'No reason provided'}</div>
                                </div>
                            )}

                            <div className="space-y-1">
                                <Label className="text-muted-foreground">Body</Label>
                                {isLoadingMessage ? (
                                    <div className="flex justify-center p-6">
                                        <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
                                    </div>
                                ) : (
                                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm">
                                        {selectedMessage.plainBody || selectedMessage.htmlBody || 'No body stored.'}
                                    </pre>
                                )}
                            </div>

                            <div className="grid gap-6 md:grid-cols-2">
                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Spam Score</Label>
                                    <div className="text-sm">
                                        {selectedMessage.spamScore !== null ? (
                                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${selectedMessage.spamScore >= 5
                                                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                }`}>
                                                {selectedMessage.spamScore}/10
                                            </span>
                                        ) : (
                                            'Not scored'
                                        )}
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-muted-foreground">Direction</Label>
                                    <div className="text-sm capitalize">{selectedMessage.direction}</div>
                                </div>
                            </div>

                            <div className="space-y-1">
                                <Label className="text-muted-foreground">Timestamps</Label>
                                <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                                    <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
                                        <span>Created</span>
                                        <span className="font-medium text-foreground">{formatDate(selectedMessage.createdAt)}</span>
                                    </div>
                                    <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
                                        <span>Sent</span>
                                        <span className="font-medium text-foreground">{formatDate(selectedMessage.sentAt)}</span>
                                    </div>
                                    <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
                                        <span>Delivered</span>
                                        <span className="font-medium text-foreground">{formatDate(selectedMessage.deliveredAt)}</span>
                                    </div>
                                    <div className="flex justify-between rounded-md bg-muted/50 px-3 py-2">
                                        <span>Opened</span>
                                        <span className="font-medium text-foreground">{formatDate(selectedMessage.openedAt)}</span>
                                    </div>
                                </div>
                            </div>

                            {selectedMessage.held && (
                                <div className="flex justify-end pt-2">
                                    <Button onClick={() => void handleReleaseHeld(selectedMessage.id)}>
                                        Release Message
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
