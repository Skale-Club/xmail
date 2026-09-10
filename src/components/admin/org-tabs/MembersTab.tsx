import { useEffect, useState } from 'react'
import { Trash2, UserPlus, Users, X, KeyRound } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/Table'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { toast } from '../../ui/toaster'
import { fetchWithAuth } from './shared'

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
}

interface MembersTabProps {
    orgId: string
    members: Member[]
    isAdmin: boolean
    ownerId: string
    onRefresh: () => Promise<void>
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

export default function MembersTab({ orgId, members, isAdmin, ownerId, onRefresh }: MembersTabProps) {
    const [showAddMember, setShowAddMember] = useState(false)
    const [localPart, setLocalPart] = useState('')
    const [password, setPassword] = useState('')
    const [selectedDomain, setSelectedDomain] = useState('')
    const [domains, setDomains] = useState<Domain[]>([])
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [editingMember, setEditingMember] = useState<Member | null>(null)
    const [newPassword, setNewPassword] = useState('')
    const [isSavingPassword, setIsSavingPassword] = useState(false)
    const [memberToRemove, setMemberToRemove] = useState<Member | null>(null)
    const [isRemoving, setIsRemoving] = useState(false)

    useEffect(() => {
        async function fetchDomains() {
            try {
                const response = await fetchWithAuth(`/api/domains?organizationId=${orgId}`)
                if (response.ok) {
                    const data = await response.json()
                    const list: Domain[] = (data.domains || []).map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }))
                    setDomains(list)
                    if (list.length > 0) setSelectedDomain(list[0].name)
                }
            } catch (error) {
                console.error('Error fetching domains:', error)
            }
        }
        void fetchDomains()
    }, [orgId])

    function openModal() {
        setLocalPart('')
        setPassword('')
        if (domains.length > 0) setSelectedDomain(domains[0].name)
        setShowAddMember(true)
    }

    async function handleAddMember() {
        const email = domains.length > 0
            ? `${localPart.trim()}@${selectedDomain}`
            : localPart.trim()
        setIsSubmitting(true)
        try {
            const response = await fetchWithAuth(`/api/organizations/${orgId}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: password || undefined, role: 'member' }),
            })

            if (response.ok) {
                setLocalPart('')
                setPassword('')
                setShowAddMember(false)
                await onRefresh()
            } else {
                const error = await response.json()
                alert(error.error || 'Failed to add member')
            }
        } catch (error) {
            console.error('Error adding member:', error)
        } finally {
            setIsSubmitting(false)
        }
    }

    async function handleRemoveMember() {
        if (!memberToRemove) return
        setIsRemoving(true)
        try {
            const response = await fetchWithAuth(`/api/organizations/${orgId}/members/${memberToRemove.userId}`, {
                method: 'DELETE',
            })

            if (response.ok) {
                setMemberToRemove(null)
                await onRefresh()
            } else {
                const error = await response.json()
                toast({ title: error.error || 'Failed to remove member', variant: 'destructive' })
            }
        } catch (error) {
            console.error('Error removing member:', error)
            toast({ title: 'Failed to remove member', variant: 'destructive' })
        } finally {
            setIsRemoving(false)
        }
    }

    async function handleUpdatePassword() {
        if (!editingMember || !newPassword.trim()) return
        setIsSavingPassword(true)
        try {
            const response = await fetchWithAuth(`/api/users/${editingMember.userId}/password`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: newPassword }),
            })
            if (response.ok) {
                setEditingMember(null)
                setNewPassword('')
            } else {
                const error = await response.json()
                alert(error.error || 'Failed to update password')
            }
        } catch (error) {
            console.error('Error updating password:', error)
        } finally {
            setIsSavingPassword(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Members</h3>
                    <p className="text-sm text-muted-foreground">Manage organization access and roles.</p>
                </div>
                {isAdmin && (
                    <Button onClick={openModal}>
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
                                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize ${getRoleBadgeColor(member.role)}`}>
                                            {member.role}
                                        </span>
                                    </TableCell>
                                    {isAdmin && (
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-1">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    title="Change password"
                                                    onClick={() => { setEditingMember(member); setNewPassword('') }}
                                                >
                                                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                                                </Button>
                                                {member.userId !== ownerId && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => setMemberToRemove(member)}
                                                    >
                                                        <Trash2 className="h-4 w-4 text-gray-500 hover:text-red-500 transition-colors" />
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

            {/* Edit Password Modal */}
            {editingMember && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <Card className="w-full max-w-md">
                        <CardHeader>
                            <div className="flex items-start justify-between">
                                <div>
                                    <CardTitle>Change Password</CardTitle>
                                    <CardDescription>{editingMember.user.email}</CardDescription>
                                </div>
                                <Button variant="ghost" size="icon" className="focus-visible:ring-0 focus-visible:ring-offset-0" onClick={() => setEditingMember(null)}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>New Password</Label>
                                <Input
                                    type="password"
                                    placeholder="Enter new password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                />
                            </div>
                            <div className="flex justify-end gap-2 pt-2">
                                <Button variant="outline" onClick={() => setEditingMember(null)}>Cancel</Button>
                                <Button onClick={() => void handleUpdatePassword()} disabled={!newPassword.trim() || isSavingPassword}>
                                    {isSavingPassword ? 'Saving...' : 'Save Password'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {showAddMember && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <Card className="w-full max-w-md">
                        <CardHeader>
                            <div className="flex items-start justify-between">
                                <div>
                                    <CardTitle>Add Member</CardTitle>
                                    <CardDescription>Add a user to this organization.</CardDescription>
                                </div>
                                <Button variant="ghost" size="icon" className="focus-visible:ring-0 focus-visible:ring-offset-0" onClick={() => setShowAddMember(false)}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Email</Label>
                                {domains.length === 0 ? (
                                    /* No domains registered — free input */
                                    <Input
                                        type="email"
                                        placeholder="user@example.com"
                                        value={localPart}
                                        onChange={(e) => setLocalPart(e.target.value)}
                                    />
                                ) : domains.length === 1 ? (
                                    /* Single domain — show suffix as static text */
                                    <div className="flex items-center rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                                        <input
                                            className="flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
                                            placeholder="username"
                                            value={localPart}
                                            onChange={(e) => setLocalPart(e.target.value)}
                                        />
                                        <span className="select-none border-l border-input px-3 py-2 text-sm text-muted-foreground">
                                            @{domains[0].name}
                                        </span>
                                    </div>
                                ) : (
                                    /* Multiple domains — show dropdown for domain part */
                                    <div className="flex items-center rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
                                        <input
                                            className="flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
                                            placeholder="username"
                                            value={localPart}
                                            onChange={(e) => setLocalPart(e.target.value)}
                                        />
                                        <span className="select-none px-1 text-sm text-muted-foreground">@</span>
                                        <select
                                            className="border-l border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-0"
                                            value={selectedDomain}
                                            onChange={(e) => setSelectedDomain(e.target.value)}
                                        >
                                            {domains.map((d) => (
                                                <option key={d.id} value={d.name}>{d.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label>Password</Label>
                                <Input
                                    type="password"
                                    placeholder="Set a password for this member"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                            </div>

                            <div className="flex justify-end gap-2 pt-4">
                                <Button variant="outline" onClick={() => setShowAddMember(false)}>
                                    Cancel
                                </Button>
                                <Button
                                    onClick={() => void handleAddMember()}
                                    disabled={!localPart.trim() || !password.trim() || (domains.length > 0 && !selectedDomain) || isSubmitting}
                                >
                                    {isSubmitting ? 'Adding...' : 'Add Member'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    )
}
