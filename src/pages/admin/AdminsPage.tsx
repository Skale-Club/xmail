import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Mail, Plus, Search, Shield, Trash2, UserCog } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Dialog'
import { toast } from '../../components/ui/toaster'
import { apiFetch, matchesSearch } from './helpers'

type AdminRecord = {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    isAdmin: boolean
    emailVerified: boolean
    createdAt: string
    lastLoginAt: string | null
}

const emptyCreate = {
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    sendInvite: true,
}

const emptyEdit = {
    firstName: '',
    lastName: '',
    emailVerified: false,
}

export default function AdminsPage() {
    const [admins, setAdmins] = useState<AdminRecord[]>([])
    const [searchQuery, setSearchQuery] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [isCreating, setIsCreating] = useState(false)
    const [editingAdmin, setEditingAdmin] = useState<AdminRecord | null>(null)
    const [isSavingEdit, setIsSavingEdit] = useState(false)
    const [createForm, setCreateForm] = useState(emptyCreate)
    const [editForm, setEditForm] = useState(emptyEdit)
    const [adminToDelete, setAdminToDelete] = useState<AdminRecord | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    useEffect(() => {
        void fetchAdmins()
    }, [])

    async function fetchAdmins() {
        setIsLoading(true)
        setError(null)
        try {
            const data = await apiFetch<{ users: AdminRecord[] }>('/api/users')
            setAdmins((data.users || []).filter((u) => u.isAdmin))
        } catch (err) {
            console.error('Error fetching admins:', err)
            setError(err instanceof Error ? err.message : 'Failed to load admins')
        } finally {
            setIsLoading(false)
        }
    }

    async function handleCreateAdmin() {
        setIsCreating(true)
        try {
            const data = await apiFetch<{ user: AdminRecord }>('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: createForm.email,
                    password: createForm.sendInvite ? undefined : createForm.password,
                    firstName: createForm.firstName || undefined,
                    lastName: createForm.lastName || undefined,
                    isAdmin: true,
                    sendInvite: createForm.sendInvite,
                }),
            })
            setAdmins((current) => [data.user, ...current])
            setCreateForm(emptyCreate)
            setShowCreateModal(false)
            toast({ title: 'Admin created', variant: 'success' })
        } catch (error) {
            toast({ title: error instanceof Error ? error.message : 'Failed to create admin', variant: 'destructive' })
        } finally {
            setIsCreating(false)
        }
    }

    function openEditModal(admin: AdminRecord) {
        setEditingAdmin(admin)
        setEditForm({
            firstName: admin.firstName || '',
            lastName: admin.lastName || '',
            emailVerified: admin.emailVerified,
        })
    }

    async function handleUpdateAdmin() {
        if (!editingAdmin) return
        setIsSavingEdit(true)
        try {
            const data = await apiFetch<{ user: AdminRecord }>(`/api/users/${editingAdmin.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editForm),
            })
            setAdmins((current) => current.map((a) => a.id === editingAdmin.id ? data.user : a))
            setEditingAdmin(null)
            toast({ title: 'Admin updated', variant: 'success' })
        } catch (error) {
            toast({ title: error instanceof Error ? error.message : 'Failed to update admin', variant: 'destructive' })
        } finally {
            setIsSavingEdit(false)
        }
    }

    async function handleResendInvite(adminId: string) {
        try {
            const data = await apiFetch<{ message: string; inviteSent?: boolean }>(
                `/api/users/${adminId}/resend-invite`,
                { method: 'POST' }
            )
            toast({ title: data.message || (data.inviteSent ? 'Invite sent' : 'Failed to resend invitation'), variant: data.inviteSent ? 'success' : 'destructive' })
        } catch (error) {
            toast({ title: error instanceof Error ? error.message : 'Failed to resend invitation', variant: 'destructive' })
        }
    }

    async function handleDeleteAdmin() {
        if (!adminToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/users/${adminToDelete.id}`, { method: 'DELETE' })
            setAdmins((current) => current.filter((a) => a.id !== adminToDelete.id))
            if (editingAdmin?.id === adminToDelete.id) {
                setEditingAdmin(null)
            }
            toast({ title: 'Admin deleted', variant: 'success' })
            setAdminToDelete(null)
        } catch (error) {
            toast({ title: error instanceof Error ? error.message : 'Failed to delete admin', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    const filteredAdmins = useMemo(
        () =>
            admins.filter((admin) =>
                matchesSearch(admin.email, searchQuery) ||
                matchesSearch(admin.firstName || '', searchQuery) ||
                matchesSearch(admin.lastName || '', searchQuery)
            ),
        [admins, searchQuery]
    )

    const canCreate = createForm.email && (createForm.sendInvite || createForm.password) && !isCreating

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4 justify-between">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        placeholder="Search by email or name..."
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        className="pl-10 shadow-sm-soft"
                    />
                </div>
                <Button className="shadow-sm-soft" onClick={() => setShowCreateModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Admin
                </Button>
            </div>

            <Card className="shadow-sm-soft">
                <CardHeader>
                    <CardTitle>Platform administrators</CardTitle>
                    <CardDescription>{filteredAdmins.length} admin{filteredAdmins.length !== 1 ? 's' : ''} with platform access</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {isLoading ? (
                        <p className="py-8 text-center text-muted-foreground">Loading admins...</p>
                    ) : error ? (
                        <div className="flex flex-col items-center gap-3 py-8 text-center">
                            <AlertCircle className="h-8 w-8 text-destructive" />
                            <p className="text-sm text-destructive">{error}</p>
                            <Button variant="outline" size="sm" onClick={() => void fetchAdmins()}>
                                Try again
                            </Button>
                        </div>
                    ) : filteredAdmins.length === 0 ? (
                        <p className="py-8 text-center text-muted-foreground">No admins found.</p>
                    ) : (
                        filteredAdmins.map((admin) => (
                            <div key={admin.id} className="rounded-lg border p-4">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-2">
                                            <Shield className="h-4 w-4 text-primary" />
                                            <span className="font-medium">{admin.email}</span>
                                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                                Admin
                                            </span>
                                        </div>
                                        <p className="text-sm text-muted-foreground">
                                            {[admin.firstName, admin.lastName].filter(Boolean).join(' ') || 'No profile name'}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            Created {new Date(admin.createdAt).toLocaleDateString()}
                                            {admin.lastLoginAt ? ` - Last login ${new Date(admin.lastLoginAt).toLocaleString()}` : ''}
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <Button variant="outline" size="sm" onClick={() => openEditModal(admin)}>
                                            <UserCog className="mr-2 h-4 w-4" />
                                            Edit
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => void handleResendInvite(admin.id)}>
                                            <Mail className="mr-2 h-4 w-4" />
                                            Resend invite
                                        </Button>
                                        <Button variant="outline" size="sm" aria-label={`Delete ${admin.email}`} onClick={() => setAdminToDelete(admin)}>
                                            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                open={adminToDelete !== null}
                onOpenChange={(open) => { if (!open) setAdminToDelete(null) }}
                title="Delete admin"
                description={adminToDelete ? `${adminToDelete.email} will lose platform admin access and their account will be deleted.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteAdmin()}
            />

            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent className="max-h-[90vh] overflow-auto">
                    <DialogHeader>
                        <DialogTitle>Create administrator</DialogTitle>
                        <DialogDescription>Admins have full access to the platform.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <Field label="Email">
                            <Input
                                type="email"
                                placeholder="admin@example.com"
                                value={createForm.email}
                                onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                            />
                        </Field>

                        <div className="grid gap-4 md:grid-cols-2">
                            <Field label="First name">
                                <Input
                                    value={createForm.firstName}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, firstName: event.target.value }))}
                                />
                            </Field>
                            <Field label="Last name">
                                <Input
                                    value={createForm.lastName}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, lastName: event.target.value }))}
                                />
                            </Field>
                        </div>

                        <Toggle
                            label="Send invite email instead of setting password"
                            checked={createForm.sendInvite}
                            onChange={(checked) => setCreateForm((current) => ({ ...current, sendInvite: checked }))}
                        />

                        {!createForm.sendInvite && (
                            <Field label="Password">
                                <Input
                                    type="password"
                                    placeholder="Minimum 8 characters"
                                    value={createForm.password}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
                                />
                            </Field>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreateAdmin()} disabled={!canCreate}>
                            {isCreating ? 'Creating...' : 'Create admin'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={editingAdmin !== null} onOpenChange={(open) => { if (!open) setEditingAdmin(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit admin</DialogTitle>
                        <DialogDescription>{editingAdmin?.email}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <Field label="First name">
                                <Input
                                    value={editForm.firstName}
                                    onChange={(event) => setEditForm((current) => ({ ...current, firstName: event.target.value }))}
                                />
                            </Field>
                            <Field label="Last name">
                                <Input
                                    value={editForm.lastName}
                                    onChange={(event) => setEditForm((current) => ({ ...current, lastName: event.target.value }))}
                                />
                            </Field>
                        </div>
                        <Toggle
                            label="Email verified"
                            checked={editForm.emailVerified}
                            onChange={(checked) => setEditForm((current) => ({ ...current, emailVerified: checked }))}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditingAdmin(null)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleUpdateAdmin()} disabled={isSavingEdit}>
                            {isSavingEdit ? 'Saving...' : 'Save changes'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <Label>{label}</Label>
            {children}
        </div>
    )
}

function Toggle({
    label,
    checked,
    onChange,
}: {
    label: string
    checked: boolean
    onChange: (checked: boolean) => void
}) {
    return (
        <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
            <span>{label}</span>
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        </label>
    )
}
