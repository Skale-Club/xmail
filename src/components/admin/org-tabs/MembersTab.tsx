import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Trash2, UserPlus, Users, KeyRound } from 'lucide-react'
import { Card, CardContent } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/Table'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { toast } from '../../ui/toaster'
import { apiFetch } from './shared'

interface Member {
    id: string
    userId: string
    role: string
    user: {
        id: string
        email: string
        firstName: string | null
        lastName: string | null
    }
}

interface Domain {
    id: string
    name: string
    verificationStatus: 'pending' | 'verified' | 'failed'
}

type MemberRole = 'admin' | 'member' | 'viewer'

interface MembersTabProps {
    orgId: string
    members: Member[]
    isAdmin: boolean
    ownerId: string
    onRefresh: () => Promise<void>
    onNavigateToDomains?: () => void
}

function getRoleBadgeColor(role: string): string {
    switch (role) {
        case 'admin':
        case 'owner':
            return 'bg-primary text-primary-foreground'
        case 'member':
            return 'bg-secondary text-secondary-foreground'
        default:
            return 'bg-muted text-muted-foreground'
    }
}

export default function MembersTab({ orgId, members, isAdmin, ownerId, onRefresh, onNavigateToDomains }: MembersTabProps) {
    const [showAddMember, setShowAddMember] = useState(false)
    const [localPart, setLocalPart] = useState('')
    const [password, setPassword] = useState('')
    const [role, setRole] = useState<MemberRole>('member')
    const [selectedDomain, setSelectedDomain] = useState('')
    const [domains, setDomains] = useState<Domain[]>([])
    const [isLoadingDomains, setIsLoadingDomains] = useState(true)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [editingMember, setEditingMember] = useState<Member | null>(null)
    const [newPassword, setNewPassword] = useState('')
    const [isSavingPassword, setIsSavingPassword] = useState(false)
    const [memberToRemove, setMemberToRemove] = useState<Member | null>(null)
    const [isRemoving, setIsRemoving] = useState(false)
    const [roleChangeId, setRoleChangeId] = useState<string | null>(null)

    const verifiedDomains = useMemo(() => domains.filter((d) => d.verificationStatus === 'verified'), [domains])

    useEffect(() => {
        void fetchDomains()
    }, [orgId])

    async function fetchDomains() {
        setIsLoadingDomains(true)
        try {
            const data = await apiFetch<{ domains: Domain[] }>(`/api/domains?organizationId=${orgId}`)
            const list = data.domains || []
            setDomains(list)
            const verified = list.filter((d) => d.verificationStatus === 'verified')
            if (verified.length > 0) setSelectedDomain(verified[0].name)
        } catch (error) {
            console.error('Error fetching domains:', error)
        } finally {
            setIsLoadingDomains(false)
        }
    }

    function openModal() {
        setLocalPart('')
        setPassword('')
        setRole('member')
        if (verifiedDomains.length > 0) setSelectedDomain(verifiedDomains[0].name)
        setShowAddMember(true)
    }

    async function handleAddMember() {
        const email = `${localPart.trim()}@${selectedDomain}`
        setIsSubmitting(true)
        try {
            await apiFetch(`/api/organizations/${orgId}/members`, {
                method: 'POST',
                body: JSON.stringify({ email, password: password.trim() || undefined, role }),
            })

            setLocalPart('')
            setPassword('')
            setShowAddMember(false)
            toast({ title: 'Member added', variant: 'success' })
            await onRefresh()
        } catch (error) {
            console.error('Error adding member:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to add member', variant: 'destructive' })
        } finally {
            setIsSubmitting(false)
        }
    }

    async function handleRemoveMember() {
        if (!memberToRemove) return
        setIsRemoving(true)
        try {
            await apiFetch(`/api/organizations/${orgId}/members/${memberToRemove.userId}`, {
                method: 'DELETE',
            })
            setMemberToRemove(null)
            toast({ title: 'Member removed', variant: 'success' })
            await onRefresh()
        } catch (error) {
            console.error('Error removing member:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to remove member', variant: 'destructive' })
        } finally {
            setIsRemoving(false)
        }
    }

    async function handleRoleChange(member: Member, nextRole: MemberRole) {
        setRoleChangeId(member.id)
        try {
            await apiFetch(`/api/organizations/${orgId}/members/${member.userId}`, {
                method: 'PATCH',
                body: JSON.stringify({ role: nextRole }),
            })
            toast({ title: 'Role updated', variant: 'success' })
            await onRefresh()
        } catch (error) {
            console.error('Error updating member role:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to update role', variant: 'destructive' })
        } finally {
            setRoleChangeId(null)
        }
    }

    async function handleUpdatePassword() {
        if (!editingMember || !newPassword.trim()) return
        setIsSavingPassword(true)
        try {
            await apiFetch(`/api/users/${editingMember.userId}/password`, {
                method: 'PUT',
                body: JSON.stringify({ password: newPassword }),
            })
            setEditingMember(null)
            setNewPassword('')
            toast({ title: 'Password updated', variant: 'success' })
        } catch (error) {
            console.error('Error updating password:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to update password', variant: 'destructive' })
        } finally {
            setIsSavingPassword(false)
        }
    }

    const canAddMember = verifiedDomains.length > 0

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Members</h3>
                    <p className="text-sm text-muted-foreground">Manage organization access and roles.</p>
                </div>
                {isAdmin && (
                    <Button onClick={openModal} disabled={isLoadingDomains}>
                        <UserPlus className="mr-2 h-4 w-4" />
                        Add Member
                    </Button>
                )}
            </div>

            {members.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <Users className="mb-4 h-12 w-12 text-muted-foreground" />
                        <p className="text-muted-foreground">No members found.</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="rounded-lg border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>User</TableHead>
                                <TableHead>Role</TableHead>
                                {isAdmin && <TableHead className="text-right">Actions</TableHead>}

                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {members.map((member) => (
                                <TableRow key={member.id}>
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                                                {(member.user.firstName?.[0] || member.user.email[0]).toUpperCase()}
                                            </div>
                                            <div>
                                                {(member.user.firstName || member.user.lastName) && (
                                                    <div className="font-medium">
                                                        {[member.user.firstName, member.user.lastName].filter(Boolean).join(' ')}
                                                    </div>
                                                )}
                                                <div className={`text-sm ${(member.user.firstName || member.user.lastName) ? 'text-muted-foreground' : 'font-medium'}`}>
                                                    {member.user.email}
                                                </div>
                                            </div>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        {isAdmin && member.userId !== ownerId ? (
                                            <Select
                                                value={member.role}
                                                disabled={roleChangeId === member.id}
                                                onValueChange={(value) => void handleRoleChange(member, value as MemberRole)}
                                            >
                                                <SelectTrigger
                                                    aria-label={`Role for ${member.user.email}`}
                                                    className="h-8 w-28 px-2 text-xs capitalize"
                                                >
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="admin">admin</SelectItem>
                                                    <SelectItem value="member">member</SelectItem>
                                                    <SelectItem value="viewer">viewer</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize ${getRoleBadgeColor(member.role)}`}>
                                                {member.role}
                                            </span>
                                        )}
                                    </TableCell>
                                    {isAdmin && (
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Change password for ${member.user.email}`}
                                                    onClick={() => { setEditingMember(member); setNewPassword('') }}
                                                >
                                                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                                                </Button>
                                                {member.userId !== ownerId && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Remove ${member.user.email}`}
                                                        onClick={() => setMemberToRemove(member)}
                                                    >
                                                        <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                                    </Button>
                                                )}
                                            </div>
                                        </TableCell>
                                    )}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <ConfirmDialog
                open={memberToRemove !== null}
                onOpenChange={(open) => { if (!open) setMemberToRemove(null) }}
                title="Remove member"
                description={
                    memberToRemove
                        ? `${memberToRemove.user.email} will lose access to this organization. If this is their last organization, their mailbox and password will also be deleted.`
                        : ''
                }
                confirmLabel="Remove"
                variant="danger"
                loading={isRemoving}
                onConfirm={() => void handleRemoveMember()}
            />

            <Dialog open={editingMember !== null} onOpenChange={(open) => { if (!open) setEditingMember(null) }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Change Password</DialogTitle>
                        <DialogDescription>{editingMember?.user.email}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2 py-2">
                        <Label>New Password</Label>
                        <Input
                            type="password"
                            placeholder="Enter new password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditingMember(null)}>Cancel</Button>
                        <Button onClick={() => void handleUpdatePassword()} disabled={!newPassword.trim() || isSavingPassword}>
                            {isSavingPassword ? 'Saving...' : 'Save Password'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add Member</DialogTitle>
                        <DialogDescription>Add a user to this organization.</DialogDescription>
                    </DialogHeader>

                    {!canAddMember ? (
                        <div className="flex flex-col items-center gap-3 rounded-lg border border-amber-300/50 bg-amber-500/10 p-6 text-center">
                            <AlertCircle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                            <p className="text-sm text-foreground">
                                This organization has no verified domain yet. Members can only be added with an email on a
                                verified domain of this organization.
                            </p>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => { setShowAddMember(false); onNavigateToDomains?.() }}
                            >
                                Go to Domains
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <Label>Email</Label>
                                {verifiedDomains.length === 1 ? (
                                    <div className="flex items-center rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                                        <input
                                            className="flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
                                            placeholder="username"
                                            value={localPart}
                                            onChange={(e) => setLocalPart(e.target.value)}
                                        />
                                        <span className="select-none border-l border-input px-3 py-2 text-sm text-muted-foreground">
                                            @{verifiedDomains[0].name}
                                        </span>
                                    </div>
                                ) : (
                                    <div className="flex items-center rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                                        <input
                                            className="flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
                                            placeholder="username"
                                            value={localPart}
                                            onChange={(e) => setLocalPart(e.target.value)}
                                        />
                                        <span className="select-none px-1 text-sm text-muted-foreground">@</span>
                                        <Select value={selectedDomain} onValueChange={setSelectedDomain}>
                                            <SelectTrigger
                                                aria-label="Domain"
                                                className="h-auto rounded-none border-0 border-l border-input bg-transparent px-3 py-2 text-sm shadow-none focus:ring-0 focus:border-l focus:border-input"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {verifiedDomains.map((d) => (
                                                    <SelectItem key={d.id} value={d.name}>{d.name}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label>Role</Label>
                                <Select value={role} onValueChange={(value) => setRole(value as MemberRole)}>
                                    <SelectTrigger aria-label="Role">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="admin">Admin</SelectItem>
                                        <SelectItem value="member">Member</SelectItem>
                                        <SelectItem value="viewer">Viewer</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label>Password</Label>
                                <Input
                                    type="password"
                                    placeholder="Set a password for this member"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">
                                    Leave empty if this person already has an account on the platform.
                                </p>
                            </div>

                            <DialogFooter>
                                <Button variant="outline" onClick={() => setShowAddMember(false)}>
                                    Cancel
                                </Button>
                                <Button
                                    onClick={() => void handleAddMember()}
                                    disabled={!localPart.trim() || !selectedDomain || isSubmitting}
                                >
                                    {isSubmitting ? 'Adding...' : 'Add Member'}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    )
}
