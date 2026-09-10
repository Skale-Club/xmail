import { useEffect, useMemo, useState } from 'react'
import { Copy, Edit, KeyRound, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/Table'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { toast } from '../../ui/toaster'
import { apiFetch } from './shared'

interface WebhookConfig {
    id: string
    organizationId: string
    name: string
    url: string
    hasSecret: boolean
    active: boolean
    events: string[]
    createdAt: string
}

interface WebhooksTabProps {
    organizationId: string
}

const availableEvents = [
    'message_sent',
    'message_delivered',
    'message_bounced',
    'message_held',
    'message_opened',
    'link_clicked',
    'domain_verified',
    'spam_alert',
]

const emptyWebhook = {
    name: '',
    url: '',
    active: true,
    events: [] as string[],
}

function SecretRevealBox({ secret }: { secret: string }) {
    function copy() {
        navigator.clipboard.writeText(secret).then(
            () => toast({ title: 'Secret copied to clipboard', variant: 'success' }),
            () => toast({ title: 'Failed to copy secret', variant: 'destructive' })
        )
    }

    return (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-foreground">Webhook secret (shown only once)</p>
            <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{secret}</code>
                <Button variant="outline" size="sm" onClick={copy}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                Store this now. It will not be shown again — use "Regenerate secret" to get a new one.
            </p>
        </div>
    )
}

export default function WebhooksTab({ organizationId }: WebhooksTabProps) {
    const [webhooks, setWebhooks] = useState<WebhookConfig[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [showEditModal, setShowEditModal] = useState(false)
    const [selectedWebhook, setSelectedWebhook] = useState<WebhookConfig | null>(null)
    const [newWebhook, setNewWebhook] = useState(emptyWebhook)
    const [editData, setEditData] = useState(emptyWebhook)
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
    const [webhookToDelete, setWebhookToDelete] = useState<WebhookConfig | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const [regenerateTarget, setRegenerateTarget] = useState<WebhookConfig | null>(null)
    const [isRegenerating, setIsRegenerating] = useState(false)

    useEffect(() => {
        void fetchWebhooks()
    }, [organizationId])

    async function fetchWebhooks() {
        setIsLoading(true)
        try {
            const data = await apiFetch<{ webhooks: WebhookConfig[] }>(`/api/webhooks?organizationId=${organizationId}`)
            setWebhooks(data.webhooks || [])
        } catch (error) {
            console.error('Error fetching webhooks:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load webhooks', variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    const filteredWebhooks = useMemo(() => (
        webhooks.filter((webhook) =>
            webhook.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            webhook.url.toLowerCase().includes(searchQuery.toLowerCase())
        )
    ), [webhooks, searchQuery])

    async function handleCreateWebhook() {
        try {
            const data = await apiFetch<{ webhook: WebhookConfig; secret?: string }>('/api/webhooks', {
                method: 'POST',
                body: JSON.stringify({
                    ...newWebhook,
                    organizationId,
                }),
            })

            setWebhooks((current) => [data.webhook, ...current])
            setNewWebhook(emptyWebhook)
            setShowCreateModal(false)
            if (data.secret) setRevealedSecret(data.secret)
            toast({ title: 'Webhook created', variant: 'success' })
        } catch (error) {
            console.error('Error creating webhook:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to create webhook', variant: 'destructive' })
        }
    }

    async function handleUpdateWebhook() {
        if (!selectedWebhook) return

        try {
            const data = await apiFetch<{ webhook: WebhookConfig }>(`/api/webhooks/${selectedWebhook.id}`, {
                method: 'PATCH',
                body: JSON.stringify(editData),
            })

            setWebhooks((current) => current.map((webhook) => webhook.id === selectedWebhook.id ? data.webhook : webhook))
            setSelectedWebhook(null)
            setShowEditModal(false)
            toast({ title: 'Webhook updated', variant: 'success' })
        } catch (error) {
            console.error('Error updating webhook:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to update webhook', variant: 'destructive' })
        }
    }

    async function handleDeleteWebhook() {
        if (!webhookToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/webhooks/${webhookToDelete.id}`, {
                method: 'DELETE',
            })

            setWebhooks((current) => current.filter((webhook) => webhook.id !== webhookToDelete.id))
            toast({ title: 'Webhook deleted', variant: 'success' })
            setWebhookToDelete(null)
        } catch (error) {
            console.error('Error deleting webhook:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete webhook', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    async function handleRegenerateSecret() {
        if (!regenerateTarget) return
        setIsRegenerating(true)
        try {
            const data = await apiFetch<{ secret: string }>(`/api/webhooks/${regenerateTarget.id}/regenerate-secret`, {
                method: 'POST',
            })
            setWebhooks((current) => current.map((webhook) => webhook.id === regenerateTarget.id ? { ...webhook, hasSecret: true } : webhook))
            setRevealedSecret(data.secret)
            toast({ title: 'Secret regenerated', variant: 'success' })
            setRegenerateTarget(null)
        } catch (error) {
            console.error('Error regenerating webhook secret:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to regenerate secret', variant: 'destructive' })
        } finally {
            setIsRegenerating(false)
        }
    }

    async function handleTestWebhook(webhookId: string) {
        try {
            const data = await apiFetch<{ success?: boolean }>(`/api/webhooks/${webhookId}/test`, {
                method: 'POST',
            })

            toast({ title: data.success ? 'Webhook test successful' : 'Webhook test failed', variant: data.success ? 'success' : 'destructive' })
        } catch (error) {
            console.error('Error testing webhook:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to test webhook', variant: 'destructive' })
        }
    }

    function toggleEvent(event: string, isSelected: boolean, target: 'new' | 'edit') {
        const update = (current: typeof emptyWebhook) => ({
            ...current,
            events: isSelected
                ? current.events.filter((currentEvent) => currentEvent !== event)
                : [...current.events, event],
        })

        if (target === 'new') {
            setNewWebhook((current) => update(current))
            return
        }

        setEditData((current) => update(current))
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Webhooks</h3>
                    <p className="text-sm text-muted-foreground">Configure event notifications and test deliveries.</p>
                </div>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Webhook
                </Button>
            </div>

            {revealedSecret && <SecretRevealBox secret={revealedSecret} />}

            <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-9"
                    placeholder="Search webhooks..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                />
            </div>

            {isLoading ? (
                <div className="flex justify-center p-8">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
            ) : (
                <div className="rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>URL</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Secret</TableHead>
                                <TableHead>Events</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredWebhooks.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                                        No webhooks found. Create a webhook to get started.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredWebhooks.map((webhook) => (
                                    <TableRow key={webhook.id}>
                                        <TableCell className="font-medium">{webhook.name}</TableCell>
                                        <TableCell>
                                            <code className="rounded bg-muted px-2 py-1 text-sm">{webhook.url}</code>
                                        </TableCell>
                                        <TableCell>
                                            <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                                                webhook.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                                            }`}>
                                                {webhook.active ? 'Active' : 'Inactive'}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-sm text-muted-foreground">
                                                {webhook.hasSecret ? 'Secret set' : 'No secret'}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-1">
                                                {webhook.events.slice(0, 3).map((event) => (
                                                    <span key={event} className="rounded bg-muted px-2 py-0.5 text-xs">
                                                        {event.replace(/_/g, ' ')}
                                                    </span>
                                                ))}
                                                {webhook.events.length > 3 && (
                                                    <span className="text-xs text-muted-foreground">+{webhook.events.length - 3} more</span>
                                                )}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {new Date(webhook.createdAt).toLocaleDateString()}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button variant="ghost" size="icon" aria-label={`Test ${webhook.name}`} onClick={() => void handleTestWebhook(webhook.id)}>
                                                <RefreshCw className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label={`Regenerate secret for ${webhook.name}`} onClick={() => setRegenerateTarget(webhook)}>
                                                <KeyRound className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={`Edit ${webhook.name}`}
                                                onClick={() => {
                                                    setSelectedWebhook(webhook)
                                                    setEditData({
                                                        name: webhook.name,
                                                        url: webhook.url,
                                                        active: webhook.active,
                                                        events: webhook.events,
                                                    })
                                                    setShowEditModal(true)
                                                }}
                                            >
                                                <Edit className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label={`Delete ${webhook.name}`} onClick={() => setWebhookToDelete(webhook)}>
                                                <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>
            )}

            <ConfirmDialog
                open={webhookToDelete !== null}
                onOpenChange={(open) => { if (!open) setWebhookToDelete(null) }}
                title="Delete webhook"
                description={webhookToDelete ? `"${webhookToDelete.name}" will stop receiving events. This action cannot be undone.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteWebhook()}
            />

            <ConfirmDialog
                open={regenerateTarget !== null}
                onOpenChange={(open) => { if (!open) setRegenerateTarget(null) }}
                title="Regenerate secret"
                description={regenerateTarget ? `A new secret will be generated for "${regenerateTarget.name}". The old secret stops working immediately.` : ''}
                confirmLabel="Regenerate"
                variant="warning"
                loading={isRegenerating}
                onConfirm={() => void handleRegenerateSecret()}
            />

            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Webhook</DialogTitle>
                        <DialogDescription>Create a new webhook for event notifications.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="webhookName">Webhook Name</Label>
                            <Input
                                id="webhookName"
                                placeholder="My Webhook"
                                value={newWebhook.name}
                                onChange={(event) => setNewWebhook((current) => ({ ...current, name: event.target.value }))}
                            />
                        </div>
                        <div>
                            <Label htmlFor="webhookUrl">URL</Label>
                            <Input
                                id="webhookUrl"
                                placeholder="https://example.com/webhook"
                                value={newWebhook.url}
                                onChange={(event) => setNewWebhook((current) => ({ ...current, url: event.target.value }))}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            A signing secret will be generated automatically and shown once after creation.
                        </p>
                        <div>
                            <Label>Events</Label>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                                {availableEvents.map((event) => (
                                    <label key={event} className="flex items-center gap-2 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={newWebhook.events.includes(event)}
                                            onChange={() => toggleEvent(event, newWebhook.events.includes(event), 'new')}
                                        />
                                        <span>{event.replace(/_/g, ' ')}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreateWebhook()} disabled={!newWebhook.name || !newWebhook.url || newWebhook.events.length === 0}>
                            Create Webhook
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showEditModal} onOpenChange={(open) => { setShowEditModal(open); if (!open) setSelectedWebhook(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit Webhook</DialogTitle>
                        <DialogDescription>Update webhook configuration.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="editWebhookName">Webhook Name</Label>
                            <Input
                                id="editWebhookName"
                                value={editData.name}
                                onChange={(event) => setEditData((current) => ({ ...current, name: event.target.value }))}
                            />
                        </div>
                        <div>
                            <Label htmlFor="editWebhookUrl">URL</Label>
                            <Input
                                id="editWebhookUrl"
                                value={editData.url}
                                onChange={(event) => setEditData((current) => ({ ...current, url: event.target.value }))}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                id="editWebhookActive"
                                type="checkbox"
                                checked={editData.active}
                                onChange={(event) => setEditData((current) => ({ ...current, active: event.target.checked }))}
                            />
                            <Label htmlFor="editWebhookActive">Active</Label>
                        </div>
                        <div>
                            <Label>Events</Label>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                                {availableEvents.map((event) => (
                                    <label key={event} className="flex items-center gap-2 text-sm">
                                        <input
                                            type="checkbox"
                                            checked={editData.events.includes(event)}
                                            onChange={() => toggleEvent(event, editData.events.includes(event), 'edit')}
                                        />
                                        <span>{event.replace(/_/g, ' ')}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setSelectedWebhook(null)
                                setShowEditModal(false)
                            }}
                        >
                            Cancel
                        </Button>
                        <Button onClick={() => void handleUpdateWebhook()} disabled={!editData.name || !editData.url || editData.events.length === 0}>
                            Save Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
