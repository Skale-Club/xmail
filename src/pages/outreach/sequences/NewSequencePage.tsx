import React from 'react'
import { useLocation, useParams } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Save, Clock, Mail, Trash2 } from 'lucide-react'
import { OutreachLayout } from '../../../components/outreach/OutreachLayout'
import { toast } from '../../../components/ui/toaster'
import { apiFetch } from '../../../lib/api-client'

interface Step {
    id: string
    type: 'email' | 'delay'
    order: number
    delayHours: number
    subject: string
    htmlBody: string
}

interface CanonicalStep {
    id: string
    stepOrder: number
    type: 'email' | 'delay' | 'condition'
    delayHours: number
    subject: string | null
    htmlBody: string | null
    plainBody: string | null
}

interface SequenceResponse {
    sequence: {
        id: string
        name: string | null
        steps: CanonicalStep[]
    } | null
}

function makeEmptyStep(order: number): Step {
    return { id: crypto.randomUUID(), type: 'email', order, delayHours: 0, subject: '', htmlBody: '' }
}

export function NewSequencePage() {
    const queryClient = useQueryClient()
    const [, setLocation] = useLocation()
    const params = useParams<{ id: string }>()
    const campaignId = params?.id
    const [name, setName] = React.useState('')
    const [steps, setSteps] = React.useState<Step[]>([makeEmptyStep(1)])

    // Load the campaign's single canonical sequence so editing preserves existing steps rather than
    // appending a second sequence (Phase 20 replaces the many-sequence write surface).
    const { data, isLoading } = useQuery({
        queryKey: ['campaign-sequence-editor', campaignId],
        queryFn: () => apiFetch<SequenceResponse>(`/api/outreach/campaigns/${campaignId}/sequence`),
        enabled: !!campaignId,
    })

    React.useEffect(() => {
        if (!data) return
        const sequence = data.sequence
        setName(sequence?.name ?? 'Main Sequence')
        const loaded = (sequence?.steps ?? [])
            .filter((step) => step.type === 'email' || step.type === 'delay')
            .sort((a, b) => a.stepOrder - b.stepOrder)
            .map<Step>((step, index) => ({
                id: crypto.randomUUID(),
                type: step.type === 'delay' ? 'delay' : 'email',
                order: index + 1,
                delayHours: step.delayHours,
                subject: step.subject ?? '',
                htmlBody: step.htmlBody ?? step.plainBody ?? '',
            }))
        setSteps(loaded.length > 0 ? loaded : [makeEmptyStep(1)])
    }, [data])

    const addStep = (type: 'email' | 'delay') => {
        setSteps(prev => [
            ...prev,
            {
                id: crypto.randomUUID(),
                type,
                order: prev.length + 1,
                delayHours: type === 'delay' ? 72 : 0,
                subject: '',
                htmlBody: ''
            }
        ])
    }

    const removeStep = (id: string) => {
        setSteps(prev => prev.filter(s => s.id !== id).map((s, i) => ({ ...s, order: i + 1 })))
    }

    const updateStep = (id: string, updates: Partial<Step>) => {
        setSteps(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s))
    }

    const saveMutation = useMutation({
        mutationFn: async (payload: { name: string; steps: Step[] }) => {
            if (!campaignId) throw new Error('No campaign ID — check route configuration')
            // Single transactional replace of the entire ordered step set — the server derives
            // one-based step order from array position and preserves step ids across edits.
            const body = {
                name: payload.name || undefined,
                steps: payload.steps.map((step) =>
                    step.type === 'delay'
                        ? { type: 'delay' as const, delayHours: step.delayHours }
                        : {
                            type: 'email' as const,
                            delayHours: step.delayHours,
                            subject: step.subject,
                            htmlBody: step.htmlBody,
                        }
                ),
            }
            return apiFetch<SequenceResponse>(`/api/outreach/campaigns/${campaignId}/sequence`, {
                method: 'PUT',
                body: JSON.stringify(body),
            })
        },
        onSuccess: () => {
            toast({ title: 'Sequence saved', variant: 'success' })
            queryClient.invalidateQueries({ queryKey: ['campaign-sequence'] })
            queryClient.invalidateQueries({ queryKey: ['campaign-sequence-editor'] })
            queryClient.invalidateQueries({ queryKey: ['sequences'] })
            setLocation(campaignId ? `/outreach/campaigns/${campaignId}` : '/outreach/sequences')
        },
        onError: (error: Error) => {
            toast({ title: 'Failed to save sequence', description: error.message, variant: 'destructive' })
        },
    })

    const handleSave = () => {
        if (!campaignId) {
            toast({ title: 'Campaign not found — navigate from a campaign page', variant: 'destructive' })
            return
        }
        if (steps.length === 0) {
            toast({ title: 'Add at least one step', variant: 'destructive' })
            return
        }
        const invalidEmail = steps.some(s => s.type === 'email' && (!s.subject.trim() || !s.htmlBody.trim()))
        if (invalidEmail) {
            toast({ title: 'Each email step needs a subject and a message body', variant: 'destructive' })
            return
        }
        saveMutation.mutate({ name, steps })
    }

    return (
        <OutreachLayout>
            <div className="mx-auto max-w-4xl space-y-6">
                <div className="flex items-center justify-between border-b border-border pb-6">
                    <div className="flex items-center gap-4">
                        <a href="/outreach/sequences" className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
                            <ArrowLeft className="h-5 w-5" />
                        </a>
                        <div>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Main Sequence"
                                className="bg-transparent text-2xl font-bold text-foreground outline-none placeholder:text-muted-foreground"
                            />
                            <p className="text-sm text-muted-foreground">
                                {isLoading ? 'Loading…' : `Draft • ${steps.length} steps`}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={handleSave}
                        disabled={saveMutation.isPending || isLoading}
                        className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        <Save className="h-5 w-5" />
                        {saveMutation.isPending ? 'Saving...' : 'Save Sequence'}
                    </button>
                </div>

                <div className="space-y-6 py-4">
                    {steps.map((step, index) => (
                        <div key={step.id} className="relative rounded-xl border border-border bg-card shadow-sm">
                            {/* Step Connector Line */}
                            {index > 0 && (
                                <div className="absolute -top-6 left-8 h-6 w-0.5 bg-border" />
                            )}

                            <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent font-semibold text-foreground">
                                        {step.order}
                                    </div>
                                    <h3 className="font-medium text-foreground">
                                        {step.type === 'email' ? 'Send Email' : 'Wait'}
                                    </h3>
                                </div>
                                {steps.length > 1 && (
                                    <button
                                        onClick={() => removeStep(step.id)}
                                        className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                )}
                            </div>

                            <div className="p-4">
                                {step.type === 'delay' ? (
                                    <div className="flex items-center gap-3">
                                        <Clock className="h-5 w-5 text-muted-foreground" />
                                        <span className="text-sm text-foreground">Wait for</span>
                                        <input
                                            type="number"
                                            min={0}
                                            value={step.delayHours}
                                            onChange={(e) => updateStep(step.id, { delayHours: Math.max(0, parseInt(e.target.value) || 0) })}
                                            className="w-20 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                                        />
                                        <span className="text-sm text-foreground">hours</span>
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        <div>
                                            <label className="mb-1 block text-sm font-medium text-foreground">Subject</label>
                                            <input
                                                type="text"
                                                value={step.subject}
                                                onChange={(e) => updateStep(step.id, { subject: e.target.value })}
                                                placeholder="e.g., Quick question about {{companyName}}"
                                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="mb-1 block text-sm font-medium text-foreground">Message Body</label>
                                            <textarea
                                                value={step.htmlBody}
                                                onChange={(e) => updateStep(step.id, { htmlBody: e.target.value })}
                                                rows={5}
                                                placeholder="Hi {{firstName}}, ..."
                                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}

                    {/* Add Action Buttons */}
                    <div className="flex justify-center gap-4 pt-4">
                        <button
                            onClick={() => addStep('email')}
                            className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent"
                        >
                            <Mail className="h-4 w-4" />
                            Add Email
                        </button>
                        <button
                            onClick={() => addStep('delay')}
                            className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm hover:bg-accent"
                        >
                            <Clock className="h-4 w-4" />
                            Add Delay
                        </button>
                    </div>
                </div>
            </div>
        </OutreachLayout>
    )
}

export default NewSequencePage
