import React from 'react'
import { useLocation, useParams } from 'wouter'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Save, Clock, Mail, Trash2, Split, Sparkles } from 'lucide-react'
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
    subjectB: string
    htmlBodyB: string
    abTestEnabled: boolean
    abTestPercentage: number
}

interface CanonicalStep {
    id: string
    stepOrder: number
    type: 'email' | 'delay' | 'condition'
    delayHours: number
    subject: string | null
    htmlBody: string | null
    plainBody: string | null
    subjectB: string | null
    htmlBodyB: string | null
    plainBodyB: string | null
    abTestEnabled: boolean
    abTestPercentage: number | null
}

interface SequenceResponse {
    sequence: {
        id: string
        name: string | null
        steps: CanonicalStep[]
    } | null
}

function makeEmptyStep(order: number): Step {
    return {
        id: crypto.randomUUID(),
        type: 'email',
        order,
        delayHours: 0,
        subject: '',
        htmlBody: '',
        subjectB: '',
        htmlBodyB: '',
        abTestEnabled: false,
        abTestPercentage: 50,
    }
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
                subjectB: step.subjectB ?? '',
                htmlBodyB: step.htmlBodyB ?? step.plainBodyB ?? '',
                abTestEnabled: step.abTestEnabled,
                abTestPercentage: step.abTestPercentage ?? 50,
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
                htmlBody: '',
                subjectB: '',
                htmlBodyB: '',
                abTestEnabled: false,
                abTestPercentage: 50,
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
                            subjectB: step.abTestEnabled ? step.subjectB : undefined,
                            htmlBodyB: step.abTestEnabled ? step.htmlBodyB : undefined,
                            abTestEnabled: step.abTestEnabled,
                            abTestPercentage: step.abTestPercentage,
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
        const invalidVariant = steps.some(s => s.type === 'email' && s.abTestEnabled && (!s.subjectB.trim() || !s.htmlBodyB.trim()))
        if (invalidVariant) {
            toast({ title: 'Each enabled B variant needs a subject and message body', variant: 'destructive' })
            return
        }
        saveMutation.mutate({ name, steps })
    }

    const appendBodyToken = (stepId: string, field: 'htmlBody' | 'htmlBodyB', token: string) => {
        const step = steps.find(item => item.id === stepId)
        if (!step || step[field].includes(token)) return
        const separator = step[field].trim() ? '\n\n' : ''
        updateStep(stepId, { [field]: `${step[field]}${separator}${token}` })
    }

    const firstEmailIndex = steps.findIndex(step => step.type === 'email')

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
                                        {index === firstEmailIndex && (
                                            <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                                    <div>
                                                        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                                            <Sparkles className="h-4 w-4 text-primary" /> Website personalization
                                                        </p>
                                                        <p className="mt-1 text-xs text-muted-foreground">
                                                            Insert the two-sentence website insight supplied by Xphere in the campaign language.
                                                        </p>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => appendBodyToken(step.id, 'htmlBody', '{{websiteInsight}}')}
                                                        className="shrink-0 rounded-lg border border-primary/30 bg-background px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                                                    >
                                                        {step.htmlBody.includes('{{websiteInsight}}') ? 'Insight added' : 'Add website insight'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex flex-wrap items-center gap-2 text-xs">
                                            <span className="font-medium text-muted-foreground">Personalization:</span>
                                            {['{{firstName}}', '{{companyName}}', '{{websiteInsight}}'].map(token => (
                                                <button
                                                    key={token}
                                                    type="button"
                                                    onClick={() => appendBodyToken(step.id, 'htmlBody', token)}
                                                    className="rounded-md bg-muted px-2 py-1 font-mono text-foreground hover:bg-accent"
                                                >
                                                    {token}
                                                </button>
                                            ))}
                                        </div>

                                        <div>
                                            <label className="mb-1 block text-sm font-medium text-foreground">Variant A subject</label>
                                            <input
                                                type="text"
                                                value={step.subject}
                                                onChange={(e) => updateStep(step.id, { subject: e.target.value })}
                                                placeholder="e.g., Quick question about {{companyName}}"
                                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="mb-1 block text-sm font-medium text-foreground">Variant A message</label>
                                            <textarea
                                                value={step.htmlBody}
                                                onChange={(e) => updateStep(step.id, { htmlBody: e.target.value })}
                                                rows={5}
                                                placeholder="Hi {{firstName}}, ..."
                                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                                            />
                                        </div>

                                        <div className="rounded-xl border border-border bg-muted/20 p-4">
                                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                                <div>
                                                    <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                                        <Split className="h-4 w-4 text-primary" /> A/B test
                                                    </p>
                                                    <p className="mt-1 text-xs text-muted-foreground">
                                                        Leads are assigned deterministically, so retries always keep the same variant.
                                                    </p>
                                                </div>
                                                <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
                                                    <input
                                                        type="checkbox"
                                                        checked={step.abTestEnabled}
                                                        onChange={(e) => updateStep(step.id, { abTestEnabled: e.target.checked })}
                                                        className="h-4 w-4 rounded border-border accent-primary"
                                                    />
                                                    Enable variant B
                                                </label>
                                            </div>

                                            {step.abTestEnabled && (
                                                <div className="mt-4 space-y-4 border-t border-border pt-4">
                                                    <div className="grid gap-3 sm:grid-cols-[1fr_150px] sm:items-end">
                                                        <div>
                                                            <label className="mb-1 block text-sm font-medium text-foreground">Variant B subject</label>
                                                            <input
                                                                type="text"
                                                                value={step.subjectB}
                                                                onChange={(e) => updateStep(step.id, { subjectB: e.target.value })}
                                                                placeholder="Alternative subject line"
                                                                className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                                                            />
                                                        </div>
                                                        <div>
                                                            <label className="mb-1 block text-sm font-medium text-foreground">Variant A share</label>
                                                            <select
                                                                value={step.abTestPercentage}
                                                                onChange={(e) => updateStep(step.id, { abTestPercentage: Number(e.target.value) })}
                                                                className="w-full rounded-lg border border-border bg-background px-3 py-2 focus:border-primary focus:outline-none"
                                                            >
                                                                <option value={50}>50% / 50%</option>
                                                                <option value={70}>70% / 30%</option>
                                                                <option value={80}>80% / 20%</option>
                                                            </select>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="mb-1 flex items-center justify-between gap-3">
                                                            <label className="block text-sm font-medium text-foreground">Variant B message</label>
                                                            <button
                                                                type="button"
                                                                onClick={() => appendBodyToken(step.id, 'htmlBodyB', '{{websiteInsight}}')}
                                                                className="text-xs font-medium text-primary hover:underline"
                                                            >
                                                                Add website insight
                                                            </button>
                                                        </div>
                                                        <textarea
                                                            value={step.htmlBodyB}
                                                            onChange={(e) => updateStep(step.id, { htmlBodyB: e.target.value })}
                                                            rows={5}
                                                            placeholder="Alternative message using the same factual personalization"
                                                            className="w-full rounded-lg border border-border bg-background px-4 py-2 focus:border-primary focus:outline-none"
                                                        />
                                                    </div>
                                                </div>
                                            )}
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
