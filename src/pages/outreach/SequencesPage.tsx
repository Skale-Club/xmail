import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'wouter'
import { Plus, Mail, Clock, Trash2 } from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { apiFetch } from '../../lib/api-client'
import { useOrganization } from '../../hooks/useOrganization'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/Dialog'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/toaster'

interface Sequence {
    id: string
    campaignId: string
    name: string
    description: string | null
    isActive: boolean
    steps: SequenceStep[]
    campaign?: {
        id: string
        name: string
    }
    createdAt: string
}

interface SequenceStep {
    id: string
    stepOrder: number
    type: 'email' | 'delay' | 'condition'
    delayHours: number
    subject: string | null
    htmlBody: string | null
    plainBody: string | null
}

interface CampaignOption {
    id: string
    name: string
    isActive: boolean
}

interface SequencesResponse {
    sequences: Sequence[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
}

async function fetchSequences(organizationId: string, page = 1, limit = 25): Promise<SequencesResponse> {
    const data = await apiFetch<{ sequences?: Sequence[]; pagination?: { page: number; limit: number; total: number; totalPages: number } }>(
        `/api/outreach/campaigns/sequences?organizationId=${organizationId}&page=${page}&limit=${limit}`
    )
    return {
        sequences: data.sequences || [],
        pagination: data.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 },
    }
}

async function fetchCampaignOptions(organizationId: string): Promise<CampaignOption[]> {
    const data = await apiFetch<{ campaigns?: CampaignOption[] }>(`/api/outreach/campaigns?organizationId=${organizationId}`)
    return data.campaigns || []
}

interface DraftStep {
    id: string
    type: 'email' | 'delay'
    stepOrder: number
    delayHours: number
    subject: string
    htmlBody: string
    plainBody: string
}

const createDraftStep = (stepOrder: number, type: 'email' | 'delay' = 'email'): DraftStep => ({
    id: crypto.randomUUID(),
    type,
    stepOrder,
    delayHours: type === 'delay' ? 72 : 0,
    subject: '',
    htmlBody: '',
    plainBody: '',
})

async function saveCampaignSequence(params: {
    campaignId: string
    name: string
    description?: string
    steps: DraftStep[]
}) {
    // One transactional replace of the campaign's single canonical sequence. Step order is derived
    // from array position on the server, so there is no client append loop and no second sequence.
    const body = {
        name: params.name,
        description: params.description || undefined,
        steps: params.steps.map((step) =>
            step.type === 'delay'
                ? { type: 'delay' as const, delayHours: step.delayHours }
                : {
                    type: 'email' as const,
                    delayHours: step.delayHours,
                    subject: step.subject,
                    htmlBody: step.htmlBody,
                    plainBody: step.plainBody || undefined,
                }
        ),
    }
    const response = await apiFetch<{ sequence: Sequence }>(`/api/outreach/campaigns/${params.campaignId}/sequence`, {
        method: 'PUT',
        body: JSON.stringify(body),
    })
    return response.sequence
}

// A campaign has exactly one canonical sequence (Phase 20, CONS-01). "Deleting" a sequence is
// meaningless — a campaign always retains its sequence, and the backend refuses the destructive
// legacy delete (409). So this card is read-only; the step set is edited via the New Sequence
// dialog, which does a history-safe transactional replace.
function SequenceCard({
    sequence,
    stepsCount,
}: {
    sequence: Sequence
    stepsCount: number
}) {
    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between">
                <div className="flex-1">
                    <h3 className="font-medium text-foreground">{sequence.name}</h3>
                    <div className="mt-1 flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${sequence.isActive
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
                            : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                            }`}>
                            {sequence.isActive ? 'Active' : 'Inactive'}
                        </span>
                        <span className="text-sm text-muted-foreground">{stepsCount} steps</span>
                    </div>
                    {sequence.campaign?.name && (
                        <p className="mt-2 text-sm text-muted-foreground">
                            Campaign: {sequence.campaign.name}
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}

function NewSequenceDialog({
    open,
    onOpenChange,
    campaigns,
    isLoadingCampaigns,
    onSubmit,
    isSaving,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    campaigns: CampaignOption[]
    isLoadingCampaigns: boolean
    onSubmit: (payload: { campaignId: string; name: string; description: string; steps: DraftStep[] }) => void
    isSaving: boolean
}) {
    const [campaignId, setCampaignId] = React.useState('')
    const [name, setName] = React.useState('')
    const [description, setDescription] = React.useState('')
    const [steps, setSteps] = React.useState<DraftStep[]>([createDraftStep(1)])

    React.useEffect(() => {
        if (!open) return
        setCampaignId(prev => prev || campaigns[0]?.id || '')
    }, [open, campaigns])

    const resetForm = React.useCallback(() => {
        setCampaignId(campaigns[0]?.id || '')
        setName('')
        setDescription('')
        setSteps([createDraftStep(1)])
    }, [campaigns])

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen)
        if (!nextOpen) {
            resetForm()
        }
    }

    const addStep = (type: 'email' | 'delay') => {
        setSteps(prev => [...prev, createDraftStep(prev.length + 1, type)])
    }

    const updateStep = (id: string, updates: Partial<DraftStep>) => {
        setSteps(prev => prev.map(step => step.id === id ? { ...step, ...updates } : step))
    }

    const removeStep = (id: string) => {
        setSteps(prev => prev
            .filter(step => step.id !== id)
            .map((step, index) => ({ ...step, stepOrder: index + 1 })))
    }

    const handleSubmit = () => {
        if (!campaignId) {
            toast({ title: 'Select a campaign before creating the sequence', variant: 'destructive' })
            return
        }

        if (!name.trim()) {
            toast({ title: 'Sequence name is required', variant: 'destructive' })
            return
        }

        const hasInvalidEmailStep = steps.some(step => step.type === 'email' && (!step.subject.trim() || !step.htmlBody.trim()))
        if (hasInvalidEmailStep) {
            toast({ title: 'Each email step needs a subject and message', variant: 'destructive' })
            return
        }

        onSubmit({
            campaignId,
            name: name.trim(),
            description: description.trim(),
            steps,
        })
    }

    const noCampaigns = !isLoadingCampaigns && campaigns.length === 0

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>New Sequence</DialogTitle>
                    <DialogDescription>
                        Build the follow-up sequence in a popup and save it directly to a campaign.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 py-2">
                    <div className="grid gap-4 md:grid-cols-2">
                        <div>
                            <label className="mb-1 block text-sm font-medium text-foreground">Campaign</label>
                            <select
                                value={campaignId}
                                onChange={(e) => setCampaignId(e.target.value)}
                                disabled={isLoadingCampaigns || noCampaigns}
                                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                            >
                                <option value="">
                                    {isLoadingCampaigns ? 'Loading campaigns...' : 'Select a campaign'}
                                </option>
                                {campaigns.map((campaign) => (
                                    <option key={campaign.id} value={campaign.id}>
                                        {campaign.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-sm font-medium text-foreground">Sequence Name</label>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Main follow-up"
                                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="mb-1 block text-sm font-medium text-foreground">Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={2}
                            placeholder="Optional internal note about this sequence"
                            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                        />
                    </div>

                    {noCampaigns ? (
                        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
                            Create a campaign first. Sequences are always attached to a campaign in the current data model.
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {steps.map((step, index) => (
                                <div key={step.id} className="rounded-xl border border-border bg-card">
                                    <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent font-semibold text-foreground">
                                                {index + 1}
                                            </div>
                                            <div>
                                                <p className="font-medium text-foreground">
                                                    {step.type === 'email' ? 'Email Step' : 'Delay Step'}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {step.type === 'email' ? 'Send a message' : 'Wait before the next email'}
                                                </p>
                                            </div>
                                        </div>
                                        {steps.length > 1 && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => removeStep(step.id)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>

                                    <div className="space-y-4 p-4">
                                        {step.type === 'delay' ? (
                                            <div className="max-w-xs">
                                                <label className="mb-1 block text-sm font-medium text-foreground">Delay in Hours</label>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    value={step.delayHours}
                                                    onChange={(e) => updateStep(step.id, { delayHours: Math.max(0, Number(e.target.value) || 0) })}
                                                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                                                />
                                            </div>
                                        ) : (
                                            <>
                                                <div>
                                                    <label className="mb-1 block text-sm font-medium text-foreground">Subject</label>
                                                    <input
                                                        value={step.subject}
                                                        onChange={(e) => updateStep(step.id, { subject: e.target.value })}
                                                        placeholder="Quick question about {{companyName}}"
                                                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="mb-1 block text-sm font-medium text-foreground">HTML Body</label>
                                                    <textarea
                                                        value={step.htmlBody}
                                                        onChange={(e) => updateStep(step.id, { htmlBody: e.target.value })}
                                                        rows={6}
                                                        placeholder="<p>Hi {{firstName}}, ...</p>"
                                                        className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm text-foreground"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="mb-1 block text-sm font-medium text-foreground">Plain Text Body</label>
                                                    <textarea
                                                        value={step.plainBody}
                                                        onChange={(e) => updateStep(step.id, { plainBody: e.target.value })}
                                                        rows={4}
                                                        placeholder="Hi {{firstName}}, ..."
                                                        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                                                    />
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ))}

                            <div className="flex flex-wrap justify-center gap-3">
                                <Button type="button" variant="outline" onClick={() => addStep('email')}>
                                    <Mail className="mr-2 h-4 w-4" />
                                    Add Email
                                </Button>
                                <Button type="button" variant="outline" onClick={() => addStep('delay')}>
                                    <Clock className="mr-2 h-4 w-4" />
                                    Add Delay
                                </Button>
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleSubmit} disabled={isSaving || noCampaigns}>
                        {isSaving ? 'Saving...' : 'Save Sequence'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export function SequencesPage() {
    const { currentOrganization } = useOrganization()
    const [location, setLocation] = useLocation()
    const queryClient = useQueryClient()
    const isCreateOpen = location === '/outreach/sequences/new'
    const [page, setPage] = React.useState(1)

    const { data: sequencesData, isLoading } = useQuery({
        queryKey: ['sequences', currentOrganization?.id, page],
        queryFn: () => fetchSequences(currentOrganization!.id, page, 25),
        enabled: !!currentOrganization,
    })
    const { data: campaigns = [], isLoading: campaignsLoading } = useQuery({
        queryKey: ['campaigns', 'sequence-options', currentOrganization?.id],
        queryFn: () => fetchCampaignOptions(currentOrganization!.id),
        enabled: !!currentOrganization?.id,
    })

    const createMutation = useMutation({
        mutationFn: saveCampaignSequence,
        onSuccess: () => {
            toast({ title: 'Sequence saved successfully', variant: 'success' })
            queryClient.invalidateQueries({ queryKey: ['sequences'] })
            queryClient.invalidateQueries({ queryKey: ['campaign-sequence'] })
            setLocation('/outreach/sequences')
        },
        onError: (error: Error) => {
            toast({ title: 'Failed to save sequence', description: error.message, variant: 'destructive' })
        },
    })

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view sequences</p>
                </div>
            ) : (
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Sequences</h1>
                        <p className="mt-1 text-muted-foreground">
                            Create email sequences for automated follow-ups
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setLocation('/outreach/sequences/new')}
                        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
                    >
                        <Plus className="h-5 w-5" />
                        New Sequence
                    </button>
                </div>

                {isLoading ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {[...Array(6)].map((_, i) => (
                            <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse">
                                <div className="mb-2 h-5 w-2/3 rounded bg-gray-200 dark:bg-gray-700" />
                                <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-700" />
                            </div>
                        ))}
                    </div>
                ) : sequencesData?.sequences && sequencesData.sequences.length > 0 ? (
                    <>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {sequencesData.sequences.map((sequence) => (
                            <SequenceCard
                                key={sequence.id}
                                sequence={sequence}
                                stepsCount={sequence.steps?.length || 0}
                            />
                        ))}
                    </div>
                    {sequencesData?.pagination && sequencesData.pagination.totalPages > 1 && (
                        <PaginationControls
                            page={sequencesData.pagination.page}
                            totalPages={sequencesData.pagination.totalPages}
                            total={sequencesData.pagination.total}
                            itemName="sequences"
                            onPageChange={setPage}
                        />
                    )}
                    </>
                ) : (
                    <div className="rounded-lg border border-border bg-card p-12 text-center">
                        <Mail className="mx-auto mb-4 h-16 w-16 text-gray-300 dark:text-gray-600" />
                        <h3 className="mb-2 text-lg font-medium text-foreground">No sequences yet</h3>
                        <p className="mb-4 text-muted-foreground">
                            Create your first email sequence to automate follow-ups
                        </p>
                        <button
                            type="button"
                            onClick={() => setLocation('/outreach/sequences/new')}
                            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
                        >
                            <Plus className="h-5 w-5" />
                            Create Sequence
                        </button>
                    </div>
                )}
            </div>
            )}
            <NewSequenceDialog
                open={isCreateOpen}
                onOpenChange={(open) => setLocation(open ? '/outreach/sequences/new' : '/outreach/sequences')}
                campaigns={campaigns}
                isLoadingCampaigns={campaignsLoading}
                onSubmit={(payload) => createMutation.mutate(payload)}
                isSaving={createMutation.isPending}
            />
        </OutreachLayout>
    )
}

export default SequencesPage
