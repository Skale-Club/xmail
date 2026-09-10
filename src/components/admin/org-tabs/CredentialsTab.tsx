import { useEffect, useMemo, useState } from 'react'
import { Copy, Eye, EyeOff, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/Table'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { toast } from '../../ui/toaster'
import { apiFetch } from './shared'

interface Credential {
    id: string
    organizationId: string
    name: string
    type: 'smtp' | 'api'
    key: string
    lastUsedAt: string | null
    expiresAt: string | null
    createdAt: string
}

interface CredentialsTabProps {
    organizationId: string
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
            <p className="text-sm font-medium text-foreground">Credential secret (shown only once)</p>
            <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{secret}</code>
                <Button variant="outline" size="sm" onClick={copy}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                Store this now. It will not be shown again — use "Regenerate" to get a new one.
            </p>
        </div>
    )
}

export default function CredentialsTab({ organizationId }: CredentialsTabProps) {
    const [credentials, setCredentials] = useState<Credential[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [visibleKeyId, setVisibleKeyId] = useState<string | null>(null)
    const [newCredential, setNewCredential] = useState({
        name: '',
        type: 'smtp' as 'smtp' | 'api',
    })
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
    const [credentialToDelete, setCredentialToDelete] = useState<Credential | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const [regenerateTarget, setRegenerateTarget] = useState<Credential | null>(null)
    const [isRegenerating, setIsRegenerating] = useState(false)

    useEffect(() => {
        void fetchCredentials()
    }, [organizationId])

    async function fetchCredentials() {
        setIsLoading(true)
        try {
            const data = await apiFetch<{ credentials: Credential[] }>(`/api/credentials?organizationId=${organizationId}`)
            setCredentials(data.credentials || [])
        } catch (error) {
            console.error('Error fetching credentials:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load credentials', variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    const filteredCredentials = useMemo(() => (
        credentials.filter((credential) =>
            credential.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            credential.key.toLowerCase().includes(searchQuery.toLowerCase())
        )
    ), [credentials, searchQuery])

    async function handleCreateCredential() {
        if (!newCredential.name.trim()) return

        try {
            const data = await apiFetch<{ credential: Credential }>('/api/credentials', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId,
                    name: newCredential.name.trim(),
                    type: newCredential.type,
                    key: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
                }),
            })

            setCredentials((current) => [data.credential, ...current])
            setNewCredential({ name: '', type: 'smtp' })
            setShowCreateModal(false)
            setVisibleKeyId(data.credential.id)
            toast({ title: 'Credential created', variant: 'success' })
        } catch (error) {
            console.error('Error creating credential:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to create credential', variant: 'destructive' })
        }
    }

    async function handleRegenerate() {
        if (!regenerateTarget) return
        setIsRegenerating(true)
        try {
            const data = await apiFetch<{ newKey: string; newSecret: string }>(`/api/credentials/${regenerateTarget.id}/regenerate`, {
                method: 'POST',
            })
            setCredentials((current) =>
                current.map((item) => item.id === regenerateTarget.id ? { ...item, key: data.newKey } : item)
            )
            setRevealedSecret(data.newSecret)
            toast({ title: 'Credential regenerated', variant: 'success' })
            setRegenerateTarget(null)
        } catch (error) {
            console.error('Error regenerating credential:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to regenerate credential', variant: 'destructive' })
        } finally {
            setIsRegenerating(false)
        }
    }

    async function handleDeleteCredential() {
        if (!credentialToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/credentials/${credentialToDelete.id}`, {
                method: 'DELETE',
            })

            setCredentials((current) => current.filter((credential) => credential.id !== credentialToDelete.id))
            if (visibleKeyId === credentialToDelete.id) {
                setVisibleKeyId(null)
            }
            toast({ title: 'Credential deleted', variant: 'success' })
            setCredentialToDelete(null)
        } catch (error) {
            console.error('Error deleting credential:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete credential', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    function copyToClipboard(value: string) {
        navigator.clipboard.writeText(value).then(
            () => toast({ title: 'Copied to clipboard', variant: 'success' }),
            () => toast({ title: 'Failed to copy', variant: 'destructive' })
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Credentials</h3>
                    <p className="text-sm text-muted-foreground">Manage SMTP and API credentials for this organization.</p>
                </div>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Credential
                </Button>
            </div>

            {revealedSecret && <SecretRevealBox secret={revealedSecret} />}

            <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-9"
                    placeholder="Search credentials..."
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
                                <TableHead>Type</TableHead>
                                <TableHead>Key</TableHead>
                                <TableHead>Last Used</TableHead>
                                <TableHead>Expires</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredCredentials.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                                        No credentials found. Create a credential to get started.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredCredentials.map((credential) => (
                                    <TableRow key={credential.id}>
                                        <TableCell className="font-medium">{credential.name}</TableCell>
                                        <TableCell>
                                            <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                                                credential.type === 'smtp'
                                                    ? 'bg-primary/10 text-primary'
                                                    : 'bg-secondary text-secondary-foreground'
                                            }`}>
                                                {credential.type.toUpperCase()}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
                                                    {visibleKeyId === credential.id ? credential.key : '••••••••••••'}
                                                </code>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    aria-label={visibleKeyId === credential.id ? 'Hide key' : 'Show key'}
                                                    onClick={() => setVisibleKeyId((current) => current === credential.id ? null : credential.id)}
                                                >
                                                    {visibleKeyId === credential.id ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                </Button>
                                                <Button variant="ghost" size="sm" aria-label="Copy key" onClick={() => copyToClipboard(credential.key)}>
                                                    <Copy className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {credential.lastUsedAt ? new Date(credential.lastUsedAt).toLocaleDateString() : 'Never'}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {credential.expiresAt ? new Date(credential.expiresAt).toLocaleDateString() : 'Never'}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button variant="ghost" size="icon" aria-label={`Regenerate ${credential.name}`} onClick={() => setRegenerateTarget(credential)}>
                                                <RefreshCw className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label={`Delete ${credential.name}`} onClick={() => setCredentialToDelete(credential)}>
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
                open={credentialToDelete !== null}
                onOpenChange={(open) => { if (!open) setCredentialToDelete(null) }}
                title="Delete credential"
                description={credentialToDelete ? `"${credentialToDelete.name}" will stop working immediately. This action cannot be undone.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteCredential()}
            />

            <ConfirmDialog
                open={regenerateTarget !== null}
                onOpenChange={(open) => { if (!open) setRegenerateTarget(null) }}
                title="Regenerate credential"
                description={regenerateTarget ? `A new key and secret will be generated for "${regenerateTarget.name}". The old ones stop working immediately.` : ''}
                confirmLabel="Regenerate"
                variant="warning"
                loading={isRegenerating}
                onConfirm={() => void handleRegenerate()}
            />

            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Credential</DialogTitle>
                        <DialogDescription>Create a new SMTP or API credential.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="credentialName">Credential Name</Label>
                            <Input
                                id="credentialName"
                                placeholder="My App Credential"
                                value={newCredential.name}
                                onChange={(event) => setNewCredential((current) => ({ ...current, name: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="credentialType">Type</Label>
                            <select
                                id="credentialType"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                value={newCredential.type}
                                onChange={(event) => setNewCredential((current) => ({ ...current, type: event.target.value as 'smtp' | 'api' }))}
                            >
                                <option value="smtp">SMTP</option>
                                <option value="api">API</option>
                            </select>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            A key is generated automatically. Use "Regenerate" afterward to get a one-time secret.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreateCredential()} disabled={!newCredential.name.trim()}>
                            Create Credential
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
