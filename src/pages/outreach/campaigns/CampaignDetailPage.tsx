import React from 'react'
import { useParams, useLocation, Link } from 'wouter'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Play, Pause, Trash2 } from 'lucide-react'
import { OutreachLayout } from '../../../components/outreach/OutreachLayout'
import { apiFetch, apiRequest } from '../../../lib/api-client'
import { useOrganization } from '../../../hooks/useOrganization'
import { toast } from '../../../components/ui/toaster'
import OverviewTab from './tabs/OverviewTab'
import LeadsTab from './tabs/LeadsTab'
import SequenceTab from './tabs/SequenceTab'
import StatsTab from './tabs/StatsTab'

export interface Campaign {
    id: string
    organizationId: string
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
    updatedAt: string
    startedAt: string | null
}

interface CampaignDetailResponse {
    campaign: Campaign
}

const statusColors: Record<string, string> = {
    active: 'bg-primary/10 text-primary',
    paused: 'bg-secondary text-secondary-foreground',
    draft: 'bg-muted text-muted-foreground',
    completed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    archived: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

type TabKey = 'overview' | 'leads' | 'sequence' | 'stats'

function CampaignDetailPage() {
    const { id } = useParams<{ id: string }>()
    const [, setLocation] = useLocation()
    const { currentOrganization } = useOrganization()
    const queryClient = useQueryClient()
    const [activeTab, setActiveTab] = React.useState<TabKey>('overview')

    const { data, isLoading, error } = useQuery({
        queryKey: ['campaign', currentOrganization?.id, id],
        queryFn: () => apiFetch<CampaignDetailResponse>(
            `/api/outreach/campaigns/${id}?organizationId=${currentOrganization!.id}`
        ),
        enabled: !!currentOrganization?.id && !!id,
    })

    const statusMutation = useMutation({
        mutationFn: (newStatus: 'active' | 'paused') => apiRequest(
            `/api/outreach/campaigns/${id}?organizationId=${currentOrganization!.id}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
            }
        ),
        onMutate: async (newStatus) => {
            await queryClient.cancelQueries({ queryKey: ['campaign', currentOrganization?.id, id] })
            const previous = queryClient.getQueryData<CampaignDetailResponse>(['campaign', currentOrganization?.id, id])
            if (previous) {
                queryClient.setQueryData<CampaignDetailResponse>(
                    ['campaign', currentOrganization?.id, id],
                    { campaign: { ...previous.campaign, status: newStatus } }
                )
            }
            return { previous }
        },
        onError: (err, _newStatus, ctx) => {
            if (ctx?.previous) {
                queryClient.setQueryData(['campaign', currentOrganization?.id, id], ctx.previous)
            }
            toast({ title: 'Failed to update status', description: (err as Error).message, variant: 'destructive' })
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['campaign', currentOrganization?.id, id] })
            queryClient.invalidateQueries({ queryKey: ['campaigns'] })
            toast({ title: 'Status updated', variant: 'success' })
        },
    })

    const deleteMutation = useMutation({
        mutationFn: () => apiRequest(
            `/api/outreach/campaigns/${id}?organizationId=${currentOrganization!.id}`,
            { method: 'DELETE' }
        ),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['campaigns'] })
            toast({ title: 'Campaign deleted', variant: 'success' })
            setLocation('/outreach/campaigns')
        },
        onError: (err) => {
            toast({ title: 'Failed to delete', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const handleDelete = () => {
        if (window.confirm('Delete this campaign? This action cannot be undone and will cascade-delete all leads, sequences, and emails.')) {
            deleteMutation.mutate()
        }
    }

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view this campaign</p>
                </div>
            ) : isLoading ? (
                <div className="space-y-4">
                    <div className="animate-pulse h-4 bg-muted rounded w-32" />
                    <div className="animate-pulse h-8 bg-muted rounded w-1/3" />
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="animate-pulse h-24 bg-muted rounded" />
                        ))}
                    </div>
                </div>
            ) : error || !data?.campaign ? (
                <div className="bg-card border border-border rounded-lg p-8 text-center space-y-4">
                    <h2 className="text-lg font-medium text-foreground">Campaign not found</h2>
                    <p className="text-sm text-muted-foreground">
                        This campaign may have been deleted or you may not have access to it.
                    </p>
                    <Link
                        href="/outreach/campaigns"
                        className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                    >
                        <ArrowLeft className="w-4 h-4" /> Back to campaigns
                    </Link>
                </div>
            ) : (
                <div className="space-y-6">
                    {/* Breadcrumb */}
                    <Link
                        href="/outreach/campaigns"
                        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="w-4 h-4" /> Back to campaigns
                    </Link>

                    {/* Header */}
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-3 flex-wrap">
                                <h1 className="text-2xl font-bold text-foreground truncate">{data.campaign.name}</h1>
                                <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[data.campaign.status]}`}>
                                    {data.campaign.status}
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                                Created {new Date(data.campaign.createdAt).toLocaleDateString()}
                            </p>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            {(data.campaign.status === 'draft' || data.campaign.status === 'paused') && (
                                <button
                                    onClick={() => statusMutation.mutate('active')}
                                    disabled={statusMutation.isPending || deleteMutation.isPending}
                                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                >
                                    <Play className="w-4 h-4" /> Activate
                                </button>
                            )}
                            {data.campaign.status === 'active' && (
                                <button
                                    onClick={() => statusMutation.mutate('paused')}
                                    disabled={statusMutation.isPending || deleteMutation.isPending}
                                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
                                >
                                    <Pause className="w-4 h-4" /> Pause
                                </button>
                            )}
                            <button
                                onClick={handleDelete}
                                disabled={statusMutation.isPending || deleteMutation.isPending}
                                className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            >
                                <Trash2 className="w-4 h-4" /> Delete
                            </button>
                        </div>
                    </div>

                    {/* Tab nav */}
                    <div className="border-b border-border flex gap-1 overflow-x-auto">
                        <button
                            onClick={() => setActiveTab('overview')}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                activeTab === 'overview'
                                    ? 'border-primary text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            Overview
                        </button>
                        <button
                            onClick={() => setActiveTab('leads')}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                activeTab === 'leads'
                                    ? 'border-primary text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            Leads
                        </button>
                        <button
                            onClick={() => setActiveTab('sequence')}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                activeTab === 'sequence'
                                    ? 'border-primary text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            Sequence
                        </button>
                        <button
                            onClick={() => setActiveTab('stats')}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                activeTab === 'stats'
                                    ? 'border-primary text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            Stats
                        </button>
                    </div>

                    {/* Tab content */}
                    <div className="mt-4">
                        {activeTab === 'overview' && (
                            <OverviewTab campaign={data.campaign} organizationId={data.campaign.organizationId} />
                        )}
                        {activeTab === 'leads' && (
                            <LeadsTab campaignId={data.campaign.id} organizationId={data.campaign.organizationId} />
                        )}
                        {activeTab === 'sequence' && (
                            <SequenceTab campaignId={data.campaign.id} organizationId={data.campaign.organizationId} />
                        )}
                        {activeTab === 'stats' && (
                            <StatsTab campaignId={data.campaign.id} organizationId={data.campaign.organizationId} />
                        )}
                    </div>
                </div>
            )}
        </OutreachLayout>
    )
}

export default CampaignDetailPage
