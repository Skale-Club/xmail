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
        <div className="bg-card rounded-lg border border-border p-4 hover:border-border transition-colors">
            <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                    <Link
                        href={`/outreach/campaigns/${campaign.id}`}
                        className="font-semibold text-foreground hover:text-primary"
                    >
                        {campaign.name}
                    </Link>
                    <div className="flex items-center gap-2 mt-1">
                        <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${statusColors[campaign.status]}`}>
                            {campaign.status}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            Created {new Date(campaign.createdAt).toLocaleDateString()}
                        </span>
                    </div>
                </div>
                <div className="relative">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="p-1 rounded hover:bg-accent"
                    >
                        <MoreVertical className="w-5 h-5 text-muted-foreground" />
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

            <div className="grid grid-cols-4 gap-4 mt-4">
                <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Users className="w-4 h-4" />
                    </div>
                    <p className="text-lg font-semibold text-foreground">{campaign.totalLeads}</p>
                    <p className="text-xs text-muted-foreground">Leads</p>
                </div>
                <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Mail className="w-4 h-4" />
                    </div>
                    <p className="text-lg font-semibold text-foreground">{campaign.emailsSent ?? 0}</p>
                    <p className="text-xs text-muted-foreground">Sent</p>
                </div>
                <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <TrendingUp className="w-4 h-4" />
                    </div>
                    <p className="text-lg font-semibold text-foreground">{(campaign.openRate ?? 0).toFixed(1)}%</p>
                    <p className="text-xs text-muted-foreground">Opens</p>
                </div>
                <div className="text-center">
                    <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
                        <Target className="w-4 h-4" />
                    </div>
                    <p className="text-lg font-semibold text-foreground">{(campaign.replyRate ?? 0).toFixed(1)}%</p>
                    <p className="text-xs text-muted-foreground">Replies</p>
                </div>
            </div>
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
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[...Array(6)].map((_, i) => (
                            <div key={i} className="bg-card rounded-lg border border-border p-4 animate-pulse">
                                <div className="h-5 bg-muted rounded w-2/3 mb-2"></div>
                                <div className="h-4 bg-muted rounded w-1/3 mb-4"></div>
                                <div className="grid grid-cols-4 gap-4">
                                    {[...Array(4)].map((_, j) => (
                                        <div key={j} className="text-center">
                                            <div className="h-6 bg-muted rounded mx-auto w-12 mb-1"></div>
                                            <div className="h-3 bg-muted rounded mx-auto w-8"></div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : data?.campaigns && data.campaigns.length > 0 ? (
                    <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
