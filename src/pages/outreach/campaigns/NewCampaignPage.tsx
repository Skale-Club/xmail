import React from 'react'
import { useLocation } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Save } from 'lucide-react'
import { OutreachLayout } from '../../../components/outreach/OutreachLayout'
import { toast } from '../../../components/ui/toaster'
import { apiFetch } from '../../../lib/api-client'
import { useOrganization } from '../../../hooks/useOrganization'

interface EmailAccount {
    id: string
    email: string
    displayName: string | null
    status: string
}

interface EmailAccountsResponse {
    emailAccounts: EmailAccount[]
}

interface CreateCampaignResponse {
    campaign: { id: string; name: string }
}

export function NewCampaignPage() {
    const { currentOrganization } = useOrganization()
    const [, setLocation] = useLocation()
    const queryClient = useQueryClient()
    const [name, setName] = React.useState('')
    const [description, setDescription] = React.useState('')
    const [fromEmailAccountId, setFromEmailAccountId] = React.useState<string>('')

    const { data: accountsData, isLoading: accountsLoading } = useQuery({
        queryKey: ['outreach-email-accounts', currentOrganization?.id],
        queryFn: () => apiFetch<EmailAccountsResponse>(
            `/api/outreach/email-accounts?organizationId=${currentOrganization!.id}&limit=100`
        ),
        enabled: !!currentOrganization?.id,
    })

    const verifiedAccounts = (accountsData?.emailAccounts ?? []).filter(a => a.status === 'verified')

    const createMutation = useMutation({
        mutationFn: async () => {
            if (!currentOrganization) throw new Error('No organization selected')
            if (!name.trim()) throw new Error('Campaign name is required')
            return apiFetch<CreateCampaignResponse>(
                `/api/outreach/campaigns?organizationId=${currentOrganization.id}`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        name: name.trim(),
                        description: description.trim() || undefined,
                        // NOTE: from_email_account_id is collected but NOT in createCampaignSchema today;
                        // the backend stores assignment per-campaign-lead, not per-campaign.
                        // We capture it here for future use AND so the user knows which inbox the
                        // campaign will default to when they add leads. For v1 we just don't send it.
                    }),
                }
            )
        },
        onSuccess: (data) => {
            toast({ title: 'Campaign created', variant: 'success' })
            queryClient.invalidateQueries({ queryKey: ['campaigns'] })
            // Phase 15: detail page now exists — land the user there.
            if (data?.campaign?.id) {
                setLocation(`/outreach/campaigns/${data.campaign.id}`)
            } else {
                // Defensive fallback: if the response shape ever changes, don't drop the user on a blank screen.
                setLocation('/outreach/campaigns')
            }
        },
        onError: (err: Error) => {
            toast({ title: 'Failed to create campaign', description: err.message, variant: 'destructive' })
        },
    })

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        createMutation.mutate()
    }

    return (
        <OutreachLayout>
            <div className="mx-auto max-w-2xl space-y-6">
                <div className="flex items-center gap-4 border-b border-border pb-6">
                    <a href="/outreach/campaigns" className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
                        <ArrowLeft className="h-5 w-5" />
                    </a>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">New Campaign</h1>
                        <p className="text-sm text-muted-foreground">Create a cold-outreach campaign</p>
                    </div>
                </div>

                {!currentOrganization ? (
                    <p className="text-muted-foreground">Select an organization first.</p>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-6">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-foreground">
                                Campaign name <span className="text-destructive">*</span>
                            </label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                maxLength={100}
                                placeholder="Q2 enterprise outbound"
                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-foreground">Description</label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={3}
                                placeholder="Optional notes about audience or goal"
                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-foreground">Default sending inbox</label>
                            <select
                                value={fromEmailAccountId}
                                onChange={(e) => setFromEmailAccountId(e.target.value)}
                                disabled={accountsLoading}
                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                            >
                                <option value="">{accountsLoading ? 'Loading…' : 'Select an inbox (assign per-lead later)'}</option>
                                {verifiedAccounts.map(acc => (
                                    <option key={acc.id} value={acc.id}>
                                        {acc.displayName ? `${acc.displayName} <${acc.email}>` : acc.email}
                                    </option>
                                ))}
                            </select>
                            {!accountsLoading && verifiedAccounts.length === 0 && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    No verified inboxes yet. <a href="/outreach/inboxes/new" className="text-primary hover:underline">Add one</a>.
                                </p>
                            )}
                        </div>
                        <div className="flex justify-end gap-3 border-t border-border pt-6">
                            <a
                                href="/outreach/campaigns"
                                className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
                            >
                                Cancel
                            </a>
                            <button
                                type="submit"
                                disabled={createMutation.isPending || !name.trim()}
                                className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                            >
                                <Save className="h-4 w-4" />
                                {createMutation.isPending ? 'Creating…' : 'Create Campaign'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </OutreachLayout>
    )
}

export default NewCampaignPage
