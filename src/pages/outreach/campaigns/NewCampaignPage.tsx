import React from 'react'
import { useLocation } from 'wouter'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Save } from 'lucide-react'
import { toast } from '../../../components/ui/toaster'
import { apiFetch } from '../../../lib/api-client'
import { useOrganization } from '../../../hooks/useOrganization'

interface CreateCampaignResponse {
    campaign: { id: string; name: string }
}

export function NewCampaignPage() {
    const { currentOrganization } = useOrganization()
    const [, setLocation] = useLocation()
    const queryClient = useQueryClient()
    const [name, setName] = React.useState('')
    const [description, setDescription] = React.useState('')
    const [contentLanguage, setContentLanguage] = React.useState('en')

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
                        contentLanguage,
                        // Inboxes are assigned per lead, not per campaign — createCampaignSchema has
                        // no sending-inbox field (see src/server/routes/outreach/campaigns.ts).
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
                            <label className="mb-1 block text-sm font-medium text-foreground">Email language</label>
                            <select
                                value={contentLanguage}
                                onChange={(e) => setContentLanguage(e.target.value)}
                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                            >
                                <option value="en">English</option>
                                <option value="pt-BR">Portuguese (Brazil)</option>
                                <option value="es">Spanish</option>
                            </select>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Template tokens stay in English; personalized values render in this language.
                            </p>
                        </div>
                        {/* No "default sending inbox" field: the backend assigns an inbox per lead,
                            not per campaign — see campaigns.ts createCampaignSchema. */}
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
    )
}

export default NewCampaignPage
