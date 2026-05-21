import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    Users,
    Send,
    TrendingUp,
    MousePointerClick,
    MessageCircle,
    AlertOctagon,
} from 'lucide-react'
import { apiFetch } from '../../../../lib/api-client'

interface Stats {
    totalLeads: number
    contacted: number
    replied: number
    bounced: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
}

interface StatsResponse {
    stats: Stats
}

interface Step {
    id: string
    stepOrder: number
    subject: string | null
    totalSent: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
}

interface Sequence {
    id: string
    steps: Step[]
}

interface SequencesResponse {
    sequences: Sequence[]
}

interface StatsTabProps {
    campaignId: string
    organizationId: string
}

export default function StatsTab({ campaignId, organizationId }: StatsTabProps) {
    const { data: statsData, isLoading: statsLoading } = useQuery({
        queryKey: ['campaign-stats', organizationId, campaignId],
        queryFn: () => apiFetch<StatsResponse>(
            `/api/outreach/campaigns/${campaignId}/stats`
        ),
        enabled: !!campaignId,
    })

    const { data: seqData, isLoading: seqLoading } = useQuery({
        queryKey: ['campaign-sequences', organizationId, campaignId],
        queryFn: () => apiFetch<SequencesResponse>(
            `/api/outreach/campaigns/${campaignId}/sequences`
        ),
        enabled: !!campaignId,
    })

    const s = statsData?.stats
    const contacted = Number(s?.contacted ?? 0)
    const denom = Math.max(contacted, 1)
    const openRate = ((Number(s?.totalOpens ?? 0) / denom) * 100).toFixed(1)
    const clickRate = ((Number(s?.totalClicks ?? 0) / denom) * 100).toFixed(1)
    const replyRate = ((Number(s?.replied ?? 0) / denom) * 100).toFixed(1)
    const bounceRate = ((Number(s?.bounced ?? 0) / denom) * 100).toFixed(1)

    const sequence = seqData?.sequences?.[0]
    const steps = sequence?.steps ?? []
    const sortedSteps = React.useMemo(
        () => [...steps].sort((a, b) => a.stepOrder - b.stepOrder),
        [steps]
    )
    const hasSteps = sortedSteps.length > 0

    const cards = [
        {
            label: 'Total Leads',
            icon: Users,
            value: statsLoading ? '—' : String(Number(s?.totalLeads ?? 0)),
            valueClass: '',
        },
        {
            label: 'Emails Sent',
            icon: Send,
            value: statsLoading ? '—' : String(contacted),
            valueClass: '',
        },
        {
            label: 'Open Rate',
            icon: TrendingUp,
            value: statsLoading ? '—' : `${openRate}%`,
            valueClass: '',
        },
        {
            label: 'Click Rate',
            icon: MousePointerClick,
            value: statsLoading ? '—' : `${clickRate}%`,
            valueClass: '',
        },
        {
            label: 'Reply Rate',
            icon: MessageCircle,
            value: statsLoading ? '—' : `${replyRate}%`,
            valueClass: '',
        },
        {
            label: 'Bounce Rate',
            icon: AlertOctagon,
            value: statsLoading ? '—' : `${bounceRate}%`,
            valueClass: Number(bounceRate) > 5 ? 'text-red-600 dark:text-red-400' : '',
        },
    ]

    return (
        <div className="space-y-6">
            {/* KPI grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                {cards.map((card) => {
                    const Icon = card.icon
                    return (
                        <div
                            key={card.label}
                            className="bg-card border border-border rounded-lg p-4"
                        >
                            <div className="flex items-center gap-2 text-muted-foreground mb-2">
                                <Icon className="w-4 h-4" />
                                <span className="text-xs uppercase font-medium tracking-wide">
                                    {card.label}
                                </span>
                            </div>
                            <p className={`text-2xl font-bold text-foreground ${card.valueClass}`}>
                                {card.value}
                            </p>
                        </div>
                    )
                })}
            </div>

            {/* Step-by-step performance table */}
            <div className="bg-card border border-border rounded-lg overflow-hidden">
                <h3 className="px-4 py-3 text-sm font-semibold border-b border-border text-foreground">
                    Per-step breakdown
                </h3>

                {seqLoading && (
                    <div className="p-4 space-y-2">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="h-8 bg-muted animate-pulse rounded" />
                        ))}
                    </div>
                )}

                {!seqLoading && !hasSteps && (
                    <p className="px-4 py-6 text-center text-muted-foreground text-sm">
                        No sequence steps yet
                    </p>
                )}

                {!seqLoading && hasSteps && (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/50">
                                <tr>
                                    <th className="text-left px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
                                        Step
                                    </th>
                                    <th className="text-left px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
                                        Subject
                                    </th>
                                    <th className="text-right px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
                                        Sent
                                    </th>
                                    <th className="text-right px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
                                        Opens
                                    </th>
                                    <th className="text-right px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
                                        Clicks
                                    </th>
                                    <th className="text-right px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
                                        Replies
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedSteps.map((step) => (
                                    <tr
                                        key={step.id}
                                        className="border-t border-border"
                                    >
                                        <td className="px-4 py-2 text-sm text-foreground font-medium whitespace-nowrap">
                                            Step {step.stepOrder + 1}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-foreground max-w-xs truncate">
                                            {step.subject ?? (
                                                <span className="italic text-muted-foreground">
                                                    (no subject)
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-right text-foreground">
                                            {step.totalSent}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-right text-foreground">
                                            {step.totalOpens}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-right text-foreground">
                                            {step.totalClicks}
                                        </td>
                                        <td className="px-4 py-2 text-sm text-right text-foreground">
                                            {step.totalReplies}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}
