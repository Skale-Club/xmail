import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { AlertCircle, Building2, Plus, Search, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/Dialog'
import { toast } from '../../components/ui/toaster'
import { generateSlug, timezoneOptions } from '../../components/admin/org-tabs/shared'
import { apiFetch } from './helpers'

interface Organization {
    id: string
    name: string
    slug: string
    timezone: string
    ownerId: string
    createdAt: string
}

export default function OrganizationsPage() {
    const [, navigate] = useLocation()
    const [organizations, setOrganizations] = useState<Organization[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [isCreating, setIsCreating] = useState(false)
    const [newOrg, setNewOrg] = useState({ name: '', slug: '', timezone: 'UTC' })
    const [orgToDelete, setOrgToDelete] = useState<Organization | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    useEffect(() => {
        void fetchOrganizations()
    }, [])

    async function fetchOrganizations() {
        setIsLoading(true)
        setError(null)
        try {
            const data = await apiFetch<{ organizations: Organization[] }>('/api/organizations')
            setOrganizations(data.organizations || [])
        } catch (err) {
            console.error('Error fetching organizations:', err)
            setError(err instanceof Error ? err.message : 'Failed to load organizations')
        } finally {
            setIsLoading(false)
        }
    }

    const filteredOrganizations = organizations.filter((org) =>
        org.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        org.slug.toLowerCase().includes(searchQuery.toLowerCase())
    )

    async function handleCreateOrg() {
        setIsCreating(true)
        try {
            const data = await apiFetch<{ organization: Organization }>('/api/organizations', {
                method: 'POST',
                body: JSON.stringify(newOrg),
            })
            setOrganizations((current) => [...current, data.organization])
            setShowCreateModal(false)
            setNewOrg({ name: '', slug: '', timezone: 'UTC' })
            toast({ title: 'Organization created', variant: 'success' })
        } catch (error) {
            console.error('Error creating organization:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to create organization', variant: 'destructive' })
        } finally {
            setIsCreating(false)
        }
    }

    async function handleDeleteOrg() {
        if (!orgToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/organizations/${orgToDelete.id}`, { method: 'DELETE' })
            setOrganizations((current) => current.filter((org) => org.id !== orgToDelete.id))
            toast({ title: 'Organization deleted', variant: 'success' })
            setOrgToDelete(null)
        } catch (error) {
            console.error('Error deleting organization:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete organization', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4 justify-between">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        placeholder="Search organizations..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 shadow-sm-soft"
                    />
                </div>
                <Button className="shadow-sm-soft" onClick={() => setShowCreateModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Organization
                </Button>
            </div>

            {isLoading ? (
                <div className="flex items-center justify-center p-8">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
            ) : error ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => void fetchOrganizations()}>
                        Try again
                    </Button>
                </div>
            ) : filteredOrganizations.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12 pt-12">
                        <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
                        <p className="text-muted-foreground">No organizations found</p>
                        <Button className="mt-4" onClick={() => setShowCreateModal(true)}>
                            Create your first organization
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {filteredOrganizations.map((org) => (
                        <Card
                            key={org.id}
                            className="cursor-pointer transition-shadow hover:shadow-md"
                            onClick={() => navigate(`/admin/organizations/${org.id}`)}
                        >
                            <CardHeader>
                                <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                                            <Building2 className="h-5 w-5 text-primary" />
                                        </div>
                                        <div>
                                            <CardTitle className="text-lg">{org.name}</CardTitle>
                                            <CardDescription className="text-sm">{org.slug}</CardDescription>
                                        </div>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Delete ${org.name}`}
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setOrgToDelete(org)
                                        }}
                                    >
                                        <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-sm text-muted-foreground">
                                    <span>Timezone: {org.timezone}</span>
                                    <span>Created: {org.createdAt && !isNaN(new Date(org.createdAt).getTime()) ? new Date(org.createdAt).toLocaleDateString() : 'N/A'}</span>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <ConfirmDialog
                open={orgToDelete !== null}
                onOpenChange={(open) => { if (!open) setOrgToDelete(null) }}
                title="Delete organization"
                description={orgToDelete ? `This will permanently delete "${orgToDelete.name}" and all of its data. This action cannot be undone.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteOrg()}
            />

            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Organization</DialogTitle>
                        <DialogDescription>Create a new organization to manage your email</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="name">Name</Label>
                            <Input
                                id="name"
                                placeholder="My Organization"
                                value={newOrg.name}
                                onChange={(e) => {
                                    const name = e.target.value
                                    setNewOrg((current) => ({
                                        ...current,
                                        name,
                                        slug: generateSlug(name),
                                    }))
                                }}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="slug">Slug</Label>
                            <Input
                                id="slug"
                                placeholder="my-organization"
                                value={newOrg.slug}
                                onChange={(e) => setNewOrg((current) => ({ ...current, slug: e.target.value }))}
                            />
                            <p className="text-xs text-muted-foreground">
                                Used in API endpoints and identifiers
                            </p>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="timezone">Timezone</Label>
                            <Select
                                value={newOrg.timezone}
                                onValueChange={(value) => setNewOrg((current) => ({ ...current, timezone: value }))}
                            >
                                <SelectTrigger id="timezone">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {timezoneOptions.map((timezone) => (
                                        <SelectItem key={timezone} value={timezone}>{timezone}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreateOrg()} disabled={!newOrg.name || !newOrg.slug || isCreating}>
                            {isCreating ? 'Creating...' : 'Create Organization'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
