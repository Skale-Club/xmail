import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'wouter'
import { Edit, Clock, Mail, AlertCircle } from 'lucide-react'
import { apiFetch } from '../../../../lib/api-client'

interface Step {
    id: string
    stepOrder: number
    type: 'email' | 'delay' | 'condition'
    delayHours: number
    subject: string | null
    abTestEnabled: boolean
    totalSent: number
}

interface Sequence {
    id: string
    name: string
    description: string | null
    steps: Step[]
}

interface SequencesResponse {
    sequences: Sequence[]
}

interface SequenceTabProps {
    campaignId: string
    organizationId: string
}

export default function SequenceTab({ campaignId, organizationId }: SequenceTabProps) {
    const { data, isLoading } = useQuery({
        queryKey: ['campaign-sequences', organizationId, campaignId],
        queryFn: () => apiFetch<SequencesResponse>(
            `/api/outreach/campaigns/${campaignId}/sequences`
        ),
        enabled: !!campaignId,
    })

    const sequence = data?.sequences?.[0]
    const steps = sequence?.steps ?? []
    const sortedSteps = React.useMemo(
        () => [...steps].sort((a, b) => a.stepOrder - b.stepOrder),
        [steps]
    )
    const hasSteps = sortedSteps.length > 0

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                    <h2 className="text-lg font-semibold text-foreground inline-flex items-center gap-2">
                        <Mail className="w-4 h-4" /> Sequence
                    </h2>
                    {sequence?.name && (
                        <p className="text-xs text-muted-foreground mt-0.5">{sequence.name}</p>
                    )}
                </div>
                <Link
                    href={`/outreach/campaigns/${campaignId}/sequences/new`}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 text-sm font-medium"
                >
                    <Edit className="w-4 h-4" /> Edit Sequence
                </Link>
            </div>

            {/* Loading skeleton */}
            {isLoading && (
                <div className="space-y-3">
                    {[0, 1, 2].map((i) => (
                        <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
                    ))}
                </div>
            )}

            {/* Empty state */}
            {!isLoading && !hasSteps && (
                <div className="bg-card border border-border rounded-lg p-12 text-center">
                    <AlertCircle className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
                    <p className="text-muted-foreground mb-4">No sequence steps yet</p>
                    <Link
                        href={`/outreach/campaigns/${campaignId}/sequences/new`}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 text-sm font-medium"
                    >
                        <Edit className="w-4 h-4" /> Create your first step
                    </Link>
                </div>
            )}

            {/* Step list */}
            {!isLoading && hasSteps && (
                <div className="space-y-3">
                    {sortedSteps.map((step) => (
                        <div
                            key={step.id}
                            className="bg-card border border-border rounded-lg p-4"
                        >
                            <div className="flex items-center gap-3 flex-wrap">
                                <span className="text-sm font-semibold text-foreground">
                                    Step {step.stepOrder + 1}
                                </span>
                                <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {step.delayHours === 0
                                        ? 'Immediate'
                                        : `Wait ${step.delayHours}h`}
                                </span>
                                <span className="text-xs text-muted-foreground capitalize">
                                    {step.type}
                                </span>
                                {step.abTestEnabled && (
                                    <span className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 px-2 py-0.5 rounded">
                                        A/B
                                    </span>
                                )}
                            </div>
                            <p className="text-sm mt-2 font-medium text-foreground">
                                {step.subject || (
                                    <span className="italic text-muted-foreground">
                                        (no subject)
                                    </span>
                                )}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Sent {step.totalSent} time{step.totalSent === 1 ? '' : 's'}
                            </p>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
