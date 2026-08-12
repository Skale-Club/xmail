import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'wouter'
import {
    Plus,
    Search,
    Filter,
    MoreVertical,
    Play,
    Pause,
    Copy,
    Trash2,
    Target,
    Users,
    Mail,
    TrendingUp
} from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { apiFetch, apiRequest } from '../../lib/api-client'
import { useOrganization } from '../../hooks/useOrganization'
import { toast } from '../../components/ui/toaster'

interface Campaign {
    id: string
    name: string
    status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
    totalLeads: number
    emailsSent: number
    openRate: number
    clickRate: number
    replyRate: number
    bounceRate: number
    createdAt: string
    updatedAt: string
}

interface CampaignsResponse {
    campaigns: Campaign[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
}

async function fetchCampaigns(organizationId: string, params: { status?: string; search?: string; page?: number; limit?: number }): Promise<CampaignsResponse> {
    const query = new URLSearchParams({ organizationId })
    if (params.status && params.status !== 'all') query.set('status', params.status)
    if (params.search) query.set('search', params.search)
    if (params.page) query.set('page', String(params.page))
    if (params.limit) query.set('limit', String(params.limit))

    return apiFetch<CampaignsResponse>(`/api/outreach/campaigns?${query.toString()}`)
}

async function updateCampaignStatus(organizationId: string, id: string, status: string): Promise<void> {
    await apiRequest(`/api/outreach/campaigns/${id}?organizationId=${organizationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
    })
}

async function deleteCampaign(organizationId: string, id: string): Promise<void> {
    await apiRequest(`/api/outreach/campaigns/${id}?organizationId=${organizationId}`, {
        method: 'DELETE',
    })
}

function CampaignCard({ campaign, onStatusChange, onDelete }: {
    campaign: Campaign
    onStatusChange: (id: string, status: string) => void
    onDelete: (id: string) => void
}) {
    const [showMenu, setShowMenu] = React.useState(false)

    const statusColors: Record<string, string> = {
        active: 'bg-primary/10 text-primary',
        paused: 'bg-secondary text-secondary-foreground',
        draft: 'bg-muted text-muted-foreground',
        completed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
        archived: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
    }

    return (
        <div className="group w-full rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/30 hover:bg-accent/20">
            <div className="grid gap-5 lg:grid-cols-[minmax(280px,1.6fr)_minmax(420px,1.8fr)_auto] lg:items-center">
                {/* Campaign identity */}
                <div className="flex min-w-0 items-center gap-3.5">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10">
                        <Target className="h-5 w-5 text-primary" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <Link
                            href={`/outreach/campaigns/${campaign.id}`}
                            className="block truncate font-semibold text-foreground transition-colors hover:text-primary"
                            title={campaign.name}
                        >
                            {campaign.name}
                        </Link>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span className={`rounded-full px-2 py-1 text-xs font-medium capitalize ${statusColors[campaign.status]}`}>
                                {campaign.status}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                Created {new Date(campaign.createdAt).toLocaleDateString()}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Campaign metrics */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <CampaignMetric icon={<Users className="h-4 w-4" />} label="Leads" value={campaign.totalLeads} />
                    <CampaignMetric icon={<Mail className="h-4 w-4" />} label="Sent" value={campaign.emailsSent ?? 0} />
                    <CampaignMetric icon={<TrendingUp className="h-4 w-4" />} label="Opens" value={`${(campaign.openRate ?? 0).toFixed(1)}%`} />
                    <CampaignMetric icon={<Target className="h-4 w-4" />} label="Replies" value={`${(campaign.replyRate ?? 0).toFixed(1)}%`} />
                </div>

                {/* Actions */}
                <div className="relative flex justify-end border-t border-border pt-3 lg:border-0 lg:pt-0">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={`Actions for ${campaign.name}`}
                        aria-expanded={showMenu}
                    >
                        <MoreVertical className="h-5 w-5" />
                    </button>
                    {showMenu && (
                        <>
                            <div
                                className="fixed inset-0 z-10"
                                onClick={() => setShowMenu(false)}
                            />
                            <div className="absolute right-0 top-8 z-20 w-48 bg-popover rounded-lg shadow-lg border border-border py-1">
                                {campaign.status === 'active' && (
                                    <button
                                        onClick={() => { onStatusChange(campaign.id, 'paused'); setShowMenu(false) }}
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                    >
                                        <Pause className="w-4 h-4" /> Pause
                                    </button>
                                )}
                                {campaign.status === 'paused' && (
                                    <button
                                        onClick={() => { onStatusChange(campaign.id, 'active'); setShowMenu(false) }}
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                    >
                                        <Play className="w-4 h-4" /> Resume
                                    </button>
                                )}
                                {campaign.status === 'draft' && (
                                    <button
                                        onClick={() => { onStatusChange(campaign.id, 'active'); setShowMenu(false) }}
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                    >
                                        <Play className="w-4 h-4" /> Start
                                    </button>
                                )}
                                <button
                                    onClick={() => setShowMenu(false)}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                >
                                    <Copy className="w-4 h-4" /> Duplicate
                                </button>
                                <button
                                    onClick={() => { onDelete(campaign.id); setShowMenu(false) }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-500 hover:text-red-600 dark:hover:text-red-400 flex items-center gap-2 transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" /> Delete
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}

function CampaignMetric({ icon, label, value }: {
    icon: React.ReactNode
    label: string
    value: React.ReactNode
}) {
    return (
        <div className="rounded-lg border border-border/70 bg-background/40 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {icon}
                <span>{label}</span>
            </div>
            <p className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</p>
        </div>
    )
}

export function CampaignsPage() {
    const { currentOrganization } = useOrganization()
    const [search, setSearch] = React.useState('')
    const [statusFilter, setStatusFilter] = React.useState('all')
    const [page, setPage] = React.useState(1)
    const queryClient = useQueryClient()

    const { data, isLoading } = useQuery({
        queryKey: ['campaigns', currentOrganization?.id, statusFilter, search, page],
        queryFn: () => fetchCampaigns(currentOrganization!.id, { status: statusFilter, search, page, limit: 25 }),
        enabled: !!currentOrganization?.id,
    })

    const statusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: string }) => updateCampaignStatus(currentOrganization!.id, id, status),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['campaigns'] })
            queryClient.invalidateQueries({ queryKey: ['recent-campaigns'] })
            queryClient.invalidateQueries({ queryKey: ['outreach-stats'] })
        },
        onError: (err) => {
            toast({ title: 'Failed to update campaign', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteCampaign(currentOrganization!.id, id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['campaigns'] })
            queryClient.invalidateQueries({ queryKey: ['recent-campaigns'] })
            queryClient.invalidateQueries({ queryKey: ['outreach-stats'] })
            toast({ title: 'Campaign deleted', variant: 'success' })
        },
        onError: (err) => {
            toast({ title: 'Failed to delete campaign', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const handleStatusChange = (id: string, status: string) => {
        statusMutation.mutate({ id, status })
    }

    const handleDelete = (id: string) => {
        if (confirm('Are you sure you want to delete this campaign?')) {
            deleteMutation.mutate(id)
        }
    }

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view campaigns</p>
                </div>
            ) : (
            <div className="space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Campaigns</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage your cold email outreach campaigns
                        </p>
                    </div>
                    <Link
                        href="/outreach/campaigns/new"
                        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                        <Plus className="w-5 h-5" />
                        New Campaign
                    </Link>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-4">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Search campaigns..."
                            value={search}
                            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                            className="w-full pl-10 pr-4 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Filter className="w-5 h-5 text-muted-foreground" />
                        <select
                            value={statusFilter}
                            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
                            className="px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary"
                        >
                            <option value="all">All Status</option>
                            <option value="draft">Draft</option>
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                            <option value="completed">Completed</option>
                            <option value="archived">Archived</option>
                        </select>
                    </div>
                </div>

                {/* Campaign List */}
                {isLoading ? (
                    <div className="space-y-3">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="w-full animate-pulse rounded-xl border border-border bg-card px-5 py-4">
                                <div className="grid gap-5 lg:grid-cols-[minmax(280px,1.6fr)_minmax(420px,1.8fr)_auto] lg:items-center">
                                    <div className="flex items-center gap-3.5">
                                        <div className="h-11 w-11 rounded-xl bg-muted" />
                                        <div className="min-w-0 flex-1">
                                            <div className="mb-2 h-4 w-2/3 rounded bg-muted" />
                                            <div className="h-3 w-1/2 rounded bg-muted" />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                    {[...Array(4)].map((_, j) => (
                                            <div key={j} className="h-14 rounded-lg bg-muted" />
                                    ))}
                                    </div>
                                    <div className="h-8 w-8 justify-self-end rounded-lg bg-muted" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : data?.campaigns && data.campaigns.length > 0 ? (
                    <>
                    <div className="space-y-3">
                        {data.campaigns.map((campaign) => (
                            <CampaignCard
                                key={campaign.id}
                                campaign={campaign}
                                onStatusChange={handleStatusChange}
                                onDelete={handleDelete}
                            />
                        ))}
                    </div>
                    {data?.pagination && data.pagination.totalPages > 1 && (
                        <PaginationControls
                            page={data.pagination.page}
                            totalPages={data.pagination.totalPages}
                            total={data.pagination.total}
                            itemName="campaigns"
                            onPageChange={setPage}
                        />
                    )}
                    </>
                ) : (
                    <div className="bg-card rounded-lg border border-border p-12 text-center">
                        <Target className="w-16 h-16 text-muted-foreground/50 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-foreground mb-2">
                            {search || statusFilter !== 'all' ? 'No campaigns found' : 'No campaigns yet'}
                        </h3>
                        <p className="text-muted-foreground mb-4">
                            {search || statusFilter !== 'all'
                                ? 'Try adjusting your search or filter criteria'
                                : 'Create your first campaign to start reaching out to leads'
                            }
                        </p>
                        {!search && statusFilter === 'all' && (
                            <Link
                                href="/outreach/campaigns/new"
                                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                            >
                                <Plus className="w-5 h-5" />
                                Create Campaign
                            </Link>
                        )}
                    </div>
                )}
            </div>
            )}
        </OutreachLayout>
    )
}

export default CampaignsPage
