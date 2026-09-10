import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Search, Shield, ShieldOff, Users as UsersIcon } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Badge } from '../../components/ui/Badge'
import { Skeleton } from '../../components/ui/Skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/toaster'
import { apiFetch, matchesSearch } from './helpers'

const PAGE_SIZE = 25

type UserOrgMembership = {
    id: string
    name: string
    slug: string
    role: 'admin' | 'member' | 'viewer'
}

type PlatformUser = {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    isAdmin: boolean
    emailVerified: boolean
    createdAt: string
    lastLoginAt: string | null
    organizations: UserOrgMembership[]
}

const roleOptions: Array<UserOrgMembership['role']> = ['admin', 'member', 'viewer']

export default function UsersPage() {
    const [users, setUsers] = useState<PlatformUser[]>([])
    const [searchQuery, setSearchQuery] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [page, setPage] = useState(1)
    const [adminToggleTarget, setAdminToggleTarget] = useState<PlatformUser | null>(null)
    const [isTogglingAdmin, setIsTogglingAdmin] = useState(false)
    const [roleChangeKey, setRoleChangeKey] = useState<string | null>(null)

    useEffect(() => {
        void fetchUsers()
    }, [])

    async function fetchUsers() {
        setIsLoading(true)
        setError(null)
        try {
            const data = await apiFetch<{ users: PlatformUser[] }>('/api/users')
            setUsers(data.users || [])
        } catch (err) {
            console.error('Error fetching users:', err)
            setError(err instanceof Error ? err.message : 'Failed to load users')
        } finally {
            setIsLoading(false)
        }
    }

    const filteredUsers = useMemo(
        () =>
            users.filter((user) =>
                matchesSearch(user.email, searchQuery) ||
                matchesSearch(user.firstName || '', searchQuery) ||
                matchesSearch(user.lastName || '', searchQuery)
            ),
        [users, searchQuery]
    )

    const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE))
    const pagedUsers = filteredUsers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

    async function handleConfirmAdminToggle() {
        if (!adminToggleTarget) return
        const nextIsAdmin = !adminToggleTarget.isAdmin
        setIsTogglingAdmin(true)
        try {
            const data = await apiFetch<{ user: PlatformUser }>(`/api/users/${adminToggleTarget.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isAdmin: nextIsAdmin }),
            })
            setUsers((current) => current.map((user) => user.id === adminToggleTarget.id ? { ...user, ...data.user } : user))
            toast({ title: nextIsAdmin ? 'User promoted to platform admin' : 'Platform admin access removed', variant: 'success' })
            setAdminToggleTarget(null)
        } catch (err) {
            console.error('Error updating admin status:', err)
            toast({ title: err instanceof Error ? err.message : 'Failed to update admin status', variant: 'destructive' })
        } finally {
            setIsTogglingAdmin(false)
        }
    }

    async function handleRoleChange(userId: string, organizationId: string, role: UserOrgMembership['role']) {
        const key = `${userId}:${organizationId}`
        setRoleChangeKey(key)
        try {
            await apiFetch(`/api/organizations/${organizationId}/members/${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role }),
            })
            setUsers((current) =>
                current.map((user) => user.id !== userId ? user : {
                    ...user,
                    organizations: user.organizations.map((org) =>
                        org.id === organizationId ? { ...org, role } : org
                    ),
                })
            )
            toast({ title: 'Role updated', variant: 'success' })
        } catch (err) {
            console.error('Error updating member role:', err)
            toast({ title: err instanceof Error ? err.message : 'Failed to update role', variant: 'destructive' })
        } finally {
            setRoleChangeKey(null)
        }
    }

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight">Users</h2>
                <p className="text-muted-foreground">All platform users, their admin status and organization roles.</p>
            </div>

            <Card>
                <CardContent className="pt-6">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            className="pl-10"
                            placeholder="Search by email or name"
                            value={searchQuery}
                            onChange={(event) => { setSearchQuery(event.target.value); setPage(1) }}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>All users</CardTitle>
                    <CardDescription>{filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {isLoading ? (
                        <div className="space-y-3">
                            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
                        </div>
                    ) : error ? (
                        <div className="flex flex-col items-center gap-3 py-12 text-center">
                            <AlertCircle className="h-8 w-8 text-destructive" />
                            <p className="text-sm text-destructive">{error}</p>
                            <Button variant="outline" size="sm" onClick={() => void fetchUsers()}>
                                Try again
                            </Button>
                        </div>
                    ) : filteredUsers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                            <UsersIcon className="mb-4 h-12 w-12 text-muted-foreground" />
                            <p className="text-muted-foreground">No users found.</p>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-lg border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>User</TableHead>
                                            <TableHead>Platform access</TableHead>
                                            <TableHead>Organizations</TableHead>
                                            <TableHead className="text-right">Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {pagedUsers.map((user) => (
                                            <TableRow key={user.id}>
                                                <TableCell>
                                                    <div className="font-medium">
                                                        {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
                                                    </div>
                                                    <div className="text-sm text-muted-foreground">{user.email}</div>
                                                </TableCell>
                                                <TableCell>
                                                    {user.isAdmin ? (
                                                        <Badge>Platform admin</Badge>
                                                    ) : (
                                                        <Badge variant="secondary">Standard</Badge>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    {user.organizations.length === 0 ? (
                                                        <span className="text-sm text-muted-foreground">No organizations</span>
                                                    ) : (
                                                        <div className="flex flex-wrap gap-2">
                                                            {user.organizations.map((org) => (
                                                                <div key={org.id} className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
                                                                    <span className="text-xs font-medium">{org.name}</span>
                                                                    <select
                                                                        aria-label={`Role for ${user.email} in ${org.name}`}
                                                                        className="h-6 rounded border border-input bg-background px-1 text-xs capitalize disabled:opacity-50"
                                                                        value={org.role}
                                                                        disabled={roleChangeKey === `${user.id}:${org.id}`}
                                                                        onChange={(event) => void handleRoleChange(user.id, org.id, event.target.value as UserOrgMembership['role'])}
                                                                    >
                                                                        {roleOptions.map((role) => (
                                                                            <option key={role} value={role}>{role}</option>
                                                                        ))}
                                                                    </select>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setAdminToggleTarget(user)}
                                                    >
                                                        {user.isAdmin ? (
                                                            <><ShieldOff className="mr-2 h-4 w-4" /> Demote</>
                                                        ) : (
                                                            <><Shield className="mr-2 h-4 w-4" /> Promote</>
                                                        )}
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                            <PaginationControls
                                page={page}
                                totalPages={totalPages}
                                onPageChange={setPage}
                                total={filteredUsers.length}
                                itemName="users"
                            />
                        </>
                    )}
                </CardContent>
            </Card>

            <ConfirmDialog
                open={adminToggleTarget !== null}
                onOpenChange={(open) => { if (!open) setAdminToggleTarget(null) }}
                title={adminToggleTarget?.isAdmin ? 'Remove platform admin access' : 'Grant platform admin access'}
                description={
                    adminToggleTarget
                        ? adminToggleTarget.isAdmin
                            ? `${adminToggleTarget.email} will lose full platform access and keep only their organization roles.`
                            : `${adminToggleTarget.email} will get full platform access, including every organization.`
                        : ''
                }
                confirmLabel={adminToggleTarget?.isAdmin ? 'Remove access' : 'Grant access'}
                variant={adminToggleTarget?.isAdmin ? 'danger' : 'warning'}
                loading={isTogglingAdmin}
                onConfirm={() => void handleConfirmAdminToggle()}
            />
        </div>
    )
}
