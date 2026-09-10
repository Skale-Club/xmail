import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/Dialog'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { apiFetch } from '../../../lib/api-client'
import { toast } from '../../../components/ui/toaster'

interface LeadList {
    id: string
    name: string
}

interface NewLeadInput {
    email: string
    firstName: string
    lastName: string
    companyName: string
    title: string
    phone: string
    linkedinUrl: string
    leadListId: string
}

const emptyForm: NewLeadInput = {
    email: '',
    firstName: '',
    lastName: '',
    companyName: '',
    title: '',
    phone: '',
    linkedinUrl: '',
    leadListId: '',
}

interface AddLeadDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    organizationId: string
    leadLists: LeadList[]
}

export function AddLeadDialog({ open, onOpenChange, organizationId, leadLists }: AddLeadDialogProps) {
    const queryClient = useQueryClient()
    const [form, setForm] = React.useState<NewLeadInput>(emptyForm)

    React.useEffect(() => {
        if (open) setForm(emptyForm)
    }, [open])

    const createMutation = useMutation({
        mutationFn: () =>
            apiFetch(`/api/outreach/leads?organizationId=${organizationId}`, {
                method: 'POST',
                body: JSON.stringify({
                    email: form.email.trim(),
                    firstName: form.firstName.trim() || undefined,
                    lastName: form.lastName.trim() || undefined,
                    companyName: form.companyName.trim() || undefined,
                    title: form.title.trim() || undefined,
                    phone: form.phone.trim() || undefined,
                    linkedinUrl: form.linkedinUrl.trim() || undefined,
                    leadListId: form.leadListId || undefined,
                }),
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['leads'] })
            queryClient.invalidateQueries({ queryKey: ['lead-lists'] })
            toast({ title: 'Lead added', variant: 'success' })
            onOpenChange(false)
        },
        onError: (err) => {
            toast({ title: 'Failed to add lead', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (!form.email.trim()) return
        createMutation.mutate()
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Add lead</DialogTitle>
                        <DialogDescription>Add a single prospect to your leads.</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-4 py-4">
                        <div>
                            <Label htmlFor="lead-email">Email *</Label>
                            <Input
                                id="lead-email"
                                type="email"
                                required
                                value={form.email}
                                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                                placeholder="jane@acme.example"
                                className="mt-1"
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="lead-first-name">First name</Label>
                                <Input
                                    id="lead-first-name"
                                    value={form.firstName}
                                    onChange={(e) => setForm((prev) => ({ ...prev, firstName: e.target.value }))}
                                    className="mt-1"
                                />
                            </div>
                            <div>
                                <Label htmlFor="lead-last-name">Last name</Label>
                                <Input
                                    id="lead-last-name"
                                    value={form.lastName}
                                    onChange={(e) => setForm((prev) => ({ ...prev, lastName: e.target.value }))}
                                    className="mt-1"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="lead-company">Company</Label>
                                <Input
                                    id="lead-company"
                                    value={form.companyName}
                                    onChange={(e) => setForm((prev) => ({ ...prev, companyName: e.target.value }))}
                                    className="mt-1"
                                />
                            </div>
                            <div>
                                <Label htmlFor="lead-title">Title</Label>
                                <Input
                                    id="lead-title"
                                    value={form.title}
                                    onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                                    className="mt-1"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label htmlFor="lead-phone">Phone</Label>
                                <Input
                                    id="lead-phone"
                                    value={form.phone}
                                    onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))}
                                    className="mt-1"
                                />
                            </div>
                            <div>
                                <Label htmlFor="lead-linkedin">LinkedIn URL</Label>
                                <Input
                                    id="lead-linkedin"
                                    value={form.linkedinUrl}
                                    onChange={(e) => setForm((prev) => ({ ...prev, linkedinUrl: e.target.value }))}
                                    className="mt-1"
                                />
                            </div>
                        </div>
                        <div>
                            <Label htmlFor="lead-list">Lead list (optional)</Label>
                            <select
                                id="lead-list"
                                value={form.leadListId}
                                onChange={(e) => setForm((prev) => ({ ...prev, leadListId: e.target.value }))}
                                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                            >
                                <option value="">No list</option>
                                {leadLists.map((list) => (
                                    <option key={list.id} value={list.id}>{list.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!form.email.trim() || createMutation.isPending}>
                            {createMutation.isPending ? 'Adding…' : 'Add lead'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
