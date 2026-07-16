import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../../../../lib/api-client'
import { CampaignAiAutomationControl } from '../../../../components/outreach/inbox/AiAutonomyControls'
import {
    getCampaignAiAutomation,
    updateCampaignAiAutomation,
    type CampaignAiAutomation,
} from '../../../../lib/unified-inbox-api'
import { useOrganization } from '../../../../hooks/useOrganization'

interface Campaign {
    id: string
    name: string
    description: string | null
    status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
    totalLeads: number
    leadsContacted: number
    totalOpens: number
    totalReplies: number
    totalBounces: number
    fromName: string | null
    replyToEmail: string | null
    createdAt: string
}

interface CampaignStats {
    totalLeads: number
    // Named denominators from the shared metric DTO (src/server/lib/outreach-campaign-metrics.ts).
    contactedLeads: number
    sentEmails: number
    eligibleLeads: number
    contacted: number
    replied: number
    bounced: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
    // Server-computed, per unique contacted lead.
    openRate: number
    replyRate: number
}

interface CampaignStatsResponse {
    stats: CampaignStats
}

interface OverviewTabProps {
    campaign: Campaign
    organizationId: string
}

export default function OverviewTab({ campaign, organizationId }: OverviewTabProps) {
    const queryClient = useQueryClient()
    const { currentOrganization } = useOrganization()
    const canManage = currentOrganization?.role === 'admin' || currentOrganization?.role === 'member'

    const { data, isLoading } = useQuery({
        queryKey: ['campaign-stats', organizationId, campaign.id],
        queryFn: () => apiFetch<CampaignStatsResponse>(
            `/api/outreach/campaigns/${campaign.id}/stats?organizationId=${organizationId}`
        ),
        enabled: !!organizationId && !!campaign.id,
    })

    // --- Autonomous AI replies control (Phase 23 AI-03/AI-06) ---
    const aiKey = ['campaign-ai-automation', organizationId, campaign.id]
    const aiQuery = useQuery({
        queryKey: aiKey,
        queryFn: () => getCampaignAiAutomation(organizationId, campaign.id),
        enabled: !!organizationId && !!campaign.id,
    })
    const [aiError, setAiError] = React.useState<string | null>(null)
    const aiMutation = useMutation({
        mutationFn: (enabled: boolean) =>
            updateCampaignAiAutomation(organizationId, campaign.id, { aiAutonomousEnabled: enabled, expectedUpdatedAt: aiQuery.data?.updatedAt ?? null }),
        onSuccess: (updated: CampaignAiAutomation) => {
            setAiError(null)
            queryClient.setQueryData(aiKey, updated)
        },
        onError: (err: unknown) => {
            setAiError(err instanceof Error ? err.message : 'Could not update autonomous replies.')
            aiQuery.refetch()
        },
    })

    const stats = data?.stats
    // Counts still fall back to the campaign row while stats loads, but rates do not: the
    // campaign.* counters are a cache that drifts, and deriving a rate from them here was one of
    // the ways this tab disagreed with the dashboard. Rates come from the server or not at all.
    const totalLeads = Number(stats?.totalLeads ?? campaign.totalLeads ?? 0)
    // "Emails Sent" is the email-grain sentEmails from the shared DTO, not the lead-grain
    // contacted count (they differ when a lead is emailed more than once).
    const sentEmails = Number(stats?.sentEmails ?? 0)

    const cards = [
        { label: 'Total Leads', value: isLoading ? '--' : String(totalLeads) },
        { label: 'Emails Sent', value: isLoading || !stats ? '--' : String(sentEmails) },
        { label: 'Open Rate', value: isLoading || !stats ? '--' : `${stats.openRate.toFixed(1)}%` },
        { label: 'Reply Rate', value: isLoading || !stats ? '--' : `${stats.replyRate.toFixed(1)}%` },
    ]

    return (
        <div className="space-y-6">
            {/* Description */}
            {campaign.description ? (
                <p className="text-muted-foreground whitespace-pre-wrap">{campaign.description}</p>
            ) : (
                <p className="text-muted-foreground italic">No description</p>
            )}

            {/* KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {cards.map((card) => (
                    <div key={card.label} className="bg-card border border-border rounded-lg p-4">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {card.label}
                        </p>
                        <p className="mt-2 text-2xl font-semibold text-foreground">{card.value}</p>
                    </div>
                ))}
            </div>

            {/* Metadata */}
            <div className="bg-card border border-border rounded-lg p-4 space-y-2 text-sm">
                <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                    <span className="text-muted-foreground min-w-[140px]">Default inbox</span>
                    <span className="text-foreground">{campaign.fromName ?? 'Default'}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                    <span className="text-muted-foreground min-w-[140px]">Reply-to</span>
                    <span className="text-foreground">{campaign.replyToEmail ?? '—'}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2">
                    <span className="text-muted-foreground min-w-[140px]">Created</span>
                    <span className="text-foreground">{new Date(campaign.createdAt).toLocaleString()}</span>
                </div>
            </div>

            {/* Autonomous AI replies (default-off, confirmed, effective scope shows the org intersection) */}
            <CampaignAiAutomationControl
                automation={aiQuery.data}
                isLoading={aiQuery.isLoading}
                canManage={canManage}
                pending={aiMutation.isPending}
                error={aiError}
                onSetEnabled={(enabled) => aiMutation.mutate(enabled)}
            />
        </div>
    )
}
