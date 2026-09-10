import { useEffect, useMemo, useState } from 'react'
import { Edit, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/Table'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { toast } from '../../ui/toaster'
import { apiFetch } from './shared'

interface RouteConfig {
    id: string
    organizationId: string
    name: string
    address: string
    mode: 'endpoint' | 'hold' | 'reject'
    spamMode: string
    spamThreshold: number
    createdAt: string
}

interface RoutesTabProps {
    organizationId: string
}

const emptyRoute = {
    name: '',
    address: '',
    mode: 'endpoint' as 'endpoint' | 'hold' | 'reject',
    spamMode: 'mark',
    spamThreshold: 5,
}

// Backend schema (src/server/routes/routes.ts): spamThreshold is z.number().int().min(0).max(100).
function parseSpamThreshold(value: string): number {
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) return 0
    return Math.min(100, Math.max(0, parsed))
}

export default function RoutesTab({ organizationId }: RoutesTabProps) {
    const [routes, setRoutes] = useState<RouteConfig[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [showEditModal, setShowEditModal] = useState(false)
    const [selectedRoute, setSelectedRoute] = useState<RouteConfig | null>(null)
    const [newRoute, setNewRoute] = useState(emptyRoute)
    const [editData, setEditData] = useState(emptyRoute)
    const [routeToDelete, setRouteToDelete] = useState<RouteConfig | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    useEffect(() => {
        void fetchRoutes()
    }, [organizationId])

    async function fetchRoutes() {
        setIsLoading(true)
        try {
            const data = await apiFetch<{ routes: RouteConfig[] }>(`/api/routes?organizationId=${organizationId}`)
            setRoutes(data.routes || [])
        } catch (error) {
            console.error('Error fetching routes:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load routes', variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    const filteredRoutes = useMemo(() => (
        routes.filter((route) =>
            route.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            route.address.toLowerCase().includes(searchQuery.toLowerCase())
        )
    ), [routes, searchQuery])

    async function handleCreateRoute() {
        try {
            const data = await apiFetch<{ route: RouteConfig }>('/api/routes', {
                method: 'POST',
                body: JSON.stringify({ ...newRoute, organizationId }),
            })

            setRoutes((current) => [data.route, ...current])
            setNewRoute(emptyRoute)
            setShowCreateModal(false)
            toast({ title: 'Route created', variant: 'success' })
        } catch (error) {
            console.error('Error creating route:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to create route', variant: 'destructive' })
        }
    }

    async function handleUpdateRoute() {
        if (!selectedRoute) return

        try {
            const data = await apiFetch<{ route: RouteConfig }>(`/api/routes/${selectedRoute.id}`, {
                method: 'PUT',
                body: JSON.stringify(editData),
            })

            setRoutes((current) => current.map((route) => route.id === selectedRoute.id ? data.route : route))
            setSelectedRoute(null)
            setShowEditModal(false)
            toast({ title: 'Route updated', variant: 'success' })
        } catch (error) {
            console.error('Error updating route:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to update route', variant: 'destructive' })
        }
    }

    async function handleDeleteRoute() {
        if (!routeToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/routes/${routeToDelete.id}`, {
                method: 'DELETE',
            })

            setRoutes((current) => current.filter((route) => route.id !== routeToDelete.id))
            toast({ title: 'Route deleted', variant: 'success' })
            setRouteToDelete(null)
        } catch (error) {
            console.error('Error deleting route:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete route', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Routes</h3>
                    <p className="text-sm text-muted-foreground">Configure email routing rules.</p>
                </div>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Route
                </Button>
            </div>

            <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-9"
                    placeholder="Search routes..."
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
                                <TableHead>Address</TableHead>
                                <TableHead>Mode</TableHead>
                                <TableHead>Spam Threshold</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filteredRoutes.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                                        No routes found. Create a route to get started.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredRoutes.map((route) => (
                                    <TableRow key={route.id}>
                                        <TableCell className="font-medium">{route.name}</TableCell>
                                        <TableCell>
                                            <code className="rounded bg-muted px-2 py-1 text-sm">{route.address}</code>
                                        </TableCell>
                                        <TableCell>
                                            <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                                                route.mode === 'endpoint'
                                                    ? 'bg-primary/10 text-primary'
                                                    : route.mode === 'hold'
                                                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                                        : 'bg-destructive/10 text-destructive'
                                            }`}>
                                                {route.mode}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground">{route.spamThreshold}</TableCell>
                                        <TableCell className="text-sm text-muted-foreground">
                                            {new Date(route.createdAt).toLocaleDateString()}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={`Edit ${route.name}`}
                                                onClick={() => {
                                                    setSelectedRoute(route)
                                                    setEditData({
                                                        name: route.name,
                                                        address: route.address,
                                                        mode: route.mode,
                                                        spamMode: route.spamMode,
                                                        spamThreshold: route.spamThreshold,
                                                    })
                                                    setShowEditModal(true)
                                                }}
                                            >
                                                <Edit className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" aria-label={`Delete ${route.name}`} onClick={() => setRouteToDelete(route)}>
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
                open={routeToDelete !== null}
                onOpenChange={(open) => { if (!open) setRouteToDelete(null) }}
                title="Delete route"
                description={routeToDelete ? `"${routeToDelete.name}" will stop routing mail. This action cannot be undone.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteRoute()}
            />

            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Route</DialogTitle>
                        <DialogDescription>Create a new email routing rule.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="routeName">Route Name</Label>
                            <Input
                                id="routeName"
                                placeholder="My Route"
                                value={newRoute.name}
                                onChange={(event) => setNewRoute((current) => ({ ...current, name: event.target.value }))}
                            />
                        </div>
                        <div>
                            <Label htmlFor="routeAddress">Email Address</Label>
                            <Input
                                id="routeAddress"
                                placeholder="support@example.com"
                                value={newRoute.address}
                                onChange={(event) => setNewRoute((current) => ({ ...current, address: event.target.value }))}
                            />
                        </div>
                        <div>
                            <Label htmlFor="routeMode">Mode</Label>
                            <select
                                id="routeMode"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                value={newRoute.mode}
                                onChange={(event) => setNewRoute((current) => ({ ...current, mode: event.target.value as 'endpoint' | 'hold' | 'reject' }))}
                            >
                                <option value="endpoint">Endpoint (Forward)</option>
                                <option value="hold">Hold (Review)</option>
                                <option value="reject">Reject (Block)</option>
                            </select>
                        </div>
                        <div>
                            <Label htmlFor="spamThreshold">Spam Threshold (0-100)</Label>
                            <Input
                                id="spamThreshold"
                                type="number"
                                min={0}
                                max={100}
                                value={newRoute.spamThreshold}
                                onChange={(event) => setNewRoute((current) => ({ ...current, spamThreshold: parseSpamThreshold(event.target.value) }))}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreateRoute()} disabled={!newRoute.name || !newRoute.address}>
                            Create Route
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showEditModal} onOpenChange={(open) => { setShowEditModal(open); if (!open) setSelectedRoute(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Edit Route</DialogTitle>
                        <DialogDescription>Update route configuration.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="editRouteName">Route Name</Label>
                            <Input
                                id="editRouteName"
                                value={editData.name}
                                onChange={(event) => setEditData((current) => ({ ...current, name: event.target.value }))}
                            />
                        </div>
                        <div>
                            <Label htmlFor="editRouteAddress">Email Address</Label>
                            <Input
                                id="editRouteAddress"
                                value={editData.address}
                                onChange={(event) => setEditData((current) => ({ ...current, address: event.target.value }))}
                            />
                        </div>
                        <div>
                            <Label htmlFor="editRouteMode">Mode</Label>
                            <select
                                id="editRouteMode"
                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                value={editData.mode}
                                onChange={(event) => setEditData((current) => ({ ...current, mode: event.target.value as 'endpoint' | 'hold' | 'reject' }))}
                            >
                                <option value="endpoint">Endpoint (Forward)</option>
                                <option value="hold">Hold (Review)</option>
                                <option value="reject">Reject (Block)</option>
                            </select>
                        </div>
                        <div>
                            <Label htmlFor="editSpamThreshold">Spam Threshold (0-100)</Label>
                            <Input
                                id="editSpamThreshold"
                                type="number"
                                min={0}
                                max={100}
                                value={editData.spamThreshold}
                                onChange={(event) => setEditData((current) => ({ ...current, spamThreshold: parseSpamThreshold(event.target.value) }))}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setSelectedRoute(null)
                                setShowEditModal(false)
                            }}
                        >
                            Cancel
                        </Button>
                        <Button onClick={() => void handleUpdateRoute()}>Save Changes</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
