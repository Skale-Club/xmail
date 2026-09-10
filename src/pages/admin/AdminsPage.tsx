import { useEffect, useMemo, useState } from 'react'
import { Mail, Plus, Search, Shield, Trash2, UserCog } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
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
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [editingAdmin, setEditingAdmin] = useState<AdminRecord | null>(null)
    const [createForm, setCreateForm] = useState(emptyCreate)
    const [editForm, setEditForm] = useState(emptyEdit)

    useEffect(() => {
        void fetchAdmins()
    }, [])

    async function fetchAdmins() {
        setIsLoading(true)
        try {
            const data = await apiFetch<{ users: AdminRecord[] }>('/api/users')
            setAdmins((data.users || []).filter((u) => u.isAdmin))
        } catch (error) {
            console.error('Error fetching admins:', error)
            setAdmins([])
        } finally {
            setIsLoading(false)
        }
    }

    async function handleCreateAdmin() {
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
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to create admin')
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

        try {
            const data = await apiFetch<{ user: AdminRecord }>(`/api/users/${editingAdmin.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editForm),
            })
            setAdmins((current) => current.map((a) => a.id === editingAdmin.id ? data.user : a))
            setEditingAdmin(null)
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to update admin')
        }
    }

    async function handleResendInvite(adminId: string) {
        try {
            const data = await apiFetch<{ message: string; inviteSent?: boolean }>(
                `/api/users/${adminId}/resend-invite`,
                { method: 'POST' }
            )
            window.alert(data.inviteSent ? data.message : (data.message || 'Failed to resend invitation'))
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to resend invitation')
        }
    }

    async function handleDeleteAdmin(adminId: string) {
        if (!window.confirm('Delete this admin?')) return

        try {
            await apiFetch(`/api/users/${adminId}`, { method: 'DELETE' })
            setAdmins((current) => current.filter((a) => a.id !== adminId))
            if (editingAdmin?.id === adminId) {
                setEditingAdmin(null)
            }
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to delete admin')
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

    const canCreate = createForm.email && (createForm.sendInvite || createForm.password)

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
                                        <Button variant="outline" size="sm" onClick={() => handleResendInvite(admin.id)}>
                                            <Mail className="mr-2 h-4 w-4" />
                                            Resend invite
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => handleDeleteAdmin(admin.id)}>
                                            <Trash2 className="h-4 w-4 text-gray-500 hover:text-red-500 transition-colors" />
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>

            {showCreateModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowCreateModal(false)}>
                    <Card className="w-full max-w-lg max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
                        <CardHeader>
                            <CardTitle>Create administrator</CardTitle>
                            <CardDescription>Admins have full access to the platform.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
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

                            <div className="flex justify-end gap-2">
                                <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                                    Cancel
                                </Button>
                                <Button onClick={handleCreateAdmin} disabled={!canCreate}>
                                    Create admin
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {editingAdmin && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setEditingAdmin(null)}>
                    <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
                        <CardHeader>
                            <CardTitle>Edit admin</CardTitle>
                            <CardDescription>{editingAdmin.email}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
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
                            <div className="flex justify-end gap-2">
                                <Button variant="outline" onClick={() => setEditingAdmin(null)}>
                                    Cancel
                                </Button>
                                <Button onClick={handleUpdateAdmin}>Save changes</Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
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
