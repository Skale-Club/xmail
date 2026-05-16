import { useEffect, useState } from 'react'
import { Building2, Plus, Search, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { apiFetch } from './helpers'

interface Organization {
    id: string
    name: string
    slug: string
    timezone: string
    ownerId: string
    createdAt: string
    member_count?: number
    server_count?: number
}

export default function OrganizationsPage() {
    const [organizations, setOrganizations] = useState<Organization[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [newOrg, setNewOrg] = useState({ name: '', slug: '', timezone: 'UTC' })

    useEffect(() => {
        void fetchOrganizations()
    }, [])

    async function fetchOrganizations() {
        try {
            const data = await apiFetch<{ organizations: Organization[] }>('/api/organizations')
            setOrganizations(data.organizations || [])
        } catch (error) {
            console.error('Error fetching organizations:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const filteredOrganizations = organizations.filter((org) =>
        org.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        org.slug.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const handleCreateOrg = async () => {
        try {
            const data = await apiFetch<{ organization: Organization }>('/api/organizations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newOrg),
            })
            setOrganizations([...organizations, data.organization])
            setShowCreateModal(false)
            setNewOrg({ name: '', slug: '', timezone: 'UTC' })
        } catch (error) {
            console.error('Error creating organization:', error)
            alert(error instanceof Error ? error.message : 'Failed to create organization')
        }
    }

    const handleDeleteOrg = async (id: string) => {
        if (!confirm('Are you sure you want to delete this organization? This action cannot be undone.')) {
            return
        }

        try {
            await apiFetch(`/api/organizations/${id}`, { method: 'DELETE' })
            setOrganizations(organizations.filter((org) => org.id !== id))
        } catch (error) {
            console.error('Error deleting organization:', error)
        }
    }

    const generateSlug = (name: string) => {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50)
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
                            onClick={() => {
                                window.location.href = `/admin/organizations/${org.id}`
                            }}
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
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            void handleDeleteOrg(org.id)
                                        }}
                                    >
                                        <Trash2 className="h-4 w-4 text-gray-500 hover:text-red-500 transition-colors" />
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

            {showCreateModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <Card className="mx-4 w-full max-w-md">
                        <CardHeader>
                            <CardTitle>Create Organization</CardTitle>
                            <CardDescription>
                                Create a new organization to manage your email
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="name">Name</Label>
                                    <Input
                                        id="name"
                                        placeholder="My Organization"
                                        value={newOrg.name}
                                        onChange={(e) => {
                                            const name = e.target.value
                                            setNewOrg({
                                                ...newOrg,
                                                name,
                                                slug: generateSlug(name),
                                            })
                                        }}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="slug">Slug</Label>
                                    <Input
                                        id="slug"
                                        placeholder="my-organization"
                                        value={newOrg.slug}
                                        onChange={(e) => setNewOrg({ ...newOrg, slug: e.target.value })}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Used in API endpoints and identifiers
                                    </p>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="timezone">Timezone</Label>
                                    <select
                                        id="timezone"
                                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        value={newOrg.timezone}
                                        onChange={(e) => setNewOrg({ ...newOrg, timezone: e.target.value })}
                                    >
                                        <option value="UTC">UTC</option>
                                        <option value="America/New_York">America/New_York</option>
                                        <option value="America/Los_Angeles">America/Los_Angeles</option>
                                        <option value="Europe/London">Europe/London</option>
                                        <option value="Europe/Paris">Europe/Paris</option>
                                        <option value="Asia/Tokyo">Asia/Tokyo</option>
                                    </select>
                                </div>
                                <div className="flex justify-end gap-2 pt-4">
                                    <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                                        Cancel
                                    </Button>
                                    <Button onClick={handleCreateOrg} disabled={!newOrg.name || !newOrg.slug}>
                                        Create Organization
                                    </Button>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    )
}
