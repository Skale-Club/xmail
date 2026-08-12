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
    subjectB: string
    htmlBodyB: string
    plainBodyB: string
    abTestEnabled: boolean
    abTestPercentage: number
}

const createDraftStep = (stepOrder: number, type: 'email' | 'delay' = 'email'): DraftStep => ({
    id: crypto.randomUUID(),
    type,
    stepOrder,
    delayHours: type === 'delay' ? 72 : 0,
    subject: '',
    htmlBody: '',
    plainBody: '',
    subjectB: '',
    htmlBodyB: '',
    plainBodyB: '',
    abTestEnabled: false,
    abTestPercentage: 50,
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
                    subjectB: step.abTestEnabled ? step.subjectB : undefined,
                    htmlBodyB: step.abTestEnabled ? step.htmlBodyB : undefined,
                    plainBodyB: step.abTestEnabled && step.plainBodyB ? step.plainBodyB : undefined,
                    abTestEnabled: step.abTestEnabled,
                    abTestPercentage: step.abTestPercentage,
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
// legacy delete (409). So this row is read-only; the step set is edited via the New Sequence
// dialog, which does a history-safe transactional replace.
function SequenceRow({
    sequence,
    stepsCount,
}: {
    sequence: Sequence
    stepsCount: number
}) {
    return (
        <article className="group w-full rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/30 hover:bg-accent/20">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:grid-cols-[minmax(0,1fr)_minmax(160px,0.35fr)_110px_120px]">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Mail className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <h3 className="truncate font-semibold text-foreground">{sequence.name}</h3>
                        <p className="mt-0.5 truncate text-sm text-muted-foreground">
                            {sequence.description || 'Automated email follow-up sequence'}
                        </p>
                    </div>
                </div>

                <div className="min-w-0 sm:text-right lg:text-left">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Campaign</p>
                    <p className="mt-1 truncate text-sm text-foreground">{sequence.campaign?.name || 'Unassigned'}</p>
                </div>

                <div className="sm:text-right lg:text-left">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Steps</p>
                    <p className="mt-1 text-sm font-medium tabular-nums text-foreground">{stepsCount}</p>
                </div>

                <div className="sm:text-right lg:text-left">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sequence.isActive
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                        }`}>
                        {sequence.isActive ? 'Active' : 'Inactive'}
                    </span>
                </div>
            </div>
        </article>
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
        const hasInvalidVariant = steps.some(step => step.type === 'email' && step.abTestEnabled
            && (!step.subjectB.trim() || (!step.htmlBodyB.trim() && !step.plainBodyB.trim())))
        if (hasInvalidVariant) {
            toast({ title: 'Each enabled B variant needs a subject and message', variant: 'destructive' })
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
                                                <div className="rounded-lg border border-border bg-muted/20 p-3">
                                                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
                                                        <input
                                                            type="checkbox"
                                                            checked={step.abTestEnabled}
                                                            onChange={(e) => updateStep(step.id, { abTestEnabled: e.target.checked })}
                                                            className="h-4 w-4 rounded accent-primary"
                                                        />
                                                        Enable Variant B
                                                    </label>
                                                    {step.abTestEnabled && (
                                                        <div className="mt-3 space-y-3 border-t border-border pt-3">
                                                            <div className="grid gap-3 md:grid-cols-[1fr_150px]">
                                                                <input
                                                                    value={step.subjectB}
                                                                    onChange={(e) => updateStep(step.id, { subjectB: e.target.value })}
                                                                    placeholder="Variant B subject"
                                                                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                                                                />
                                                                <select
                                                                    value={step.abTestPercentage}
                                                                    onChange={(e) => updateStep(step.id, { abTestPercentage: Number(e.target.value) })}
                                                                    className="w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground"
                                                                >
                                                                    <option value={50}>50% / 50%</option>
                                                                    <option value={70}>70% / 30%</option>
                                                                    <option value={80}>80% / 20%</option>
                                                                </select>
                                                            </div>
                                                            <textarea
                                                                value={step.htmlBodyB}
                                                                onChange={(e) => updateStep(step.id, { htmlBodyB: e.target.value })}
                                                                rows={5}
                                                                placeholder="Variant B message — use {{websiteInsight}} for the site analysis"
                                                                className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm text-foreground"
                                                            />
                                                        </div>
                                                    )}
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
                    <div className="space-y-3">
                        {[...Array(6)].map((_, i) => (
                            <div key={i} className="flex w-full animate-pulse items-center gap-4 rounded-xl border border-border bg-card px-5 py-4">
                                <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                                <div className="flex-1 space-y-2">
                                    <div className="h-4 w-1/3 rounded bg-muted" />
                                    <div className="h-3 w-1/2 rounded bg-muted" />
                                </div>
                                <div className="hidden h-4 w-24 rounded bg-muted sm:block" />
                            </div>
                        ))}
                    </div>
                ) : sequencesData?.sequences && sequencesData.sequences.length > 0 ? (
                    <>
                    <div className="space-y-3">
                        {sequencesData.sequences.map((sequence) => (
                            <SequenceRow
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
