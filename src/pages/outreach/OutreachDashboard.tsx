import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'wouter'
import {
    Target,
    Users,
    Mail,
    TrendingUp,
    Plus,
    ArrowRight,
    Send,
    Eye,
    MousePointer,
    Reply
} from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { apiFetch } from '../../lib/api-client'
import { useOrganization } from '../../hooks/useOrganization'

interface DashboardStats {
    totalCampaigns: number
    activeCampaigns: number
    totalLeads: number
    totalEmails: number
    openRate: number
    clickRate: number
    replyRate: number
    bounceRate: number
}

interface RecentCampaign {
    id: string
    name: string
    status: string
    totalLeads: number
    emailsSent: number
    openRate: number
    replyRate: number
}

async function fetchDashboardStats(organizationId: string): Promise<DashboardStats> {
    return apiFetch<DashboardStats>(`/api/outreach/campaigns/stats?organizationId=${organizationId}`)
}

async function fetchRecentCampaigns(organizationId: string): Promise<RecentCampaign[]> {
    const data = await apiFetch<{ campaigns?: RecentCampaign[] }>(`/api/outreach/campaigns?organizationId=${organizationId}&limit=5`)
    return data.campaigns || []
}

function StatCard({
    title,
    value,
    icon,
    trend,
    color = 'blue'
}: {
    title: string
    value: string | number
    icon: React.ReactNode
    trend?: string
    color?: 'blue' | 'green' | 'purple' | 'orange'
}) {
    const colorClasses = {
        blue: 'bg-primary/10 text-primary',
        green: 'bg-muted text-muted-foreground',
        purple: 'bg-muted text-muted-foreground',
        orange: 'bg-muted text-muted-foreground',
    }

    return (
        <div className="bg-card rounded-lg p-6 shadow-sm border border-border">
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-sm text-muted-foreground">{title}</p>
                    <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
                    {trend && (
                        <p className="text-sm text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                            <TrendingUp className="w-4 h-4" />
                            {trend}
                        </p>
                    )}
                </div>
                <div className={`p-3 rounded-lg ${colorClasses[color]}`}>
                    {icon}
                </div>
            </div>
        </div>
    )
}

function QuickAction({ title, description, href, icon }: {
    title: string
    description: string
    href: string
    icon: React.ReactNode
}) {
    return (
        <Link
            href={href}
            className="flex items-center gap-4 p-4 bg-card rounded-lg border border-border hover:border-primary/50 transition-colors group"
        >
            <div className="p-2 bg-primary/10 rounded-lg text-primary shrink-0">
                {icon}
            </div>
            <div className="flex-1 min-w-0">
                <h3 className="font-medium text-foreground truncate">{title}</h3>
                <p className="text-sm text-muted-foreground truncate">{description}</p>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-primary transition-colors shrink-0" />
        </Link>
    )
}

function CampaignRow({ campaign }: { campaign: RecentCampaign }) {
    const statusColors: Record<string, string> = {
        active: 'bg-primary/10 text-primary',
        paused: 'bg-secondary text-secondary-foreground',
        draft: 'bg-muted text-muted-foreground',
        completed: 'bg-muted text-muted-foreground',
    }

    return (
        <tr className="border-b border-border last:border-0">
            <td className="py-3">
                <Link
                    href={`/outreach/campaigns/${campaign.id}`}
                    className="font-medium text-foreground hover:text-primary"
                >
                    {campaign.name}
                </Link>
            </td>
            <td className="py-3">
                <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[campaign.status] || statusColors.draft}`}>
                    {campaign.status}
                </span>
            </td>
            <td className="py-3 text-sm text-muted-foreground">{campaign.totalLeads ?? 0}</td>
            <td className="py-3 text-sm text-muted-foreground">{campaign.emailsSent ?? 0}</td>
            <td className="py-3 text-sm text-muted-foreground">{(campaign.openRate ?? 0).toFixed(1)}%</td>
            <td className="py-3 text-sm text-muted-foreground">{(campaign.replyRate ?? 0).toFixed(1)}%</td>
        </tr>
    )
}

export function OutreachDashboard() {
    const { currentOrganization } = useOrganization()

    const { data: stats, isLoading: statsLoading } = useQuery({
        queryKey: ['outreach-stats', currentOrganization?.id],
        queryFn: () => fetchDashboardStats(currentOrganization!.id),
        enabled: !!currentOrganization?.id,
    })

    const { data: campaigns, isLoading: campaignsLoading } = useQuery({
        queryKey: ['recent-campaigns', currentOrganization?.id],
        queryFn: () => fetchRecentCampaigns(currentOrganization!.id),
        enabled: !!currentOrganization?.id,
    })

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view outreach data</p>
                </div>
            ) : (
            <div className="space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Outreach Dashboard</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage your cold email campaigns and track performance
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

                {/* Stats Grid */}
                {statsLoading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="bg-card rounded-lg p-6 animate-pulse">
                                <div className="h-4 bg-muted rounded w-1/2 mb-2"></div>
                                <div className="h-8 bg-muted rounded w-3/4"></div>
                            </div>
                        ))}
                    </div>
                ) : stats && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <StatCard
                            title="Active Campaigns"
                            value={stats.activeCampaigns}
                            icon={<Target className="w-6 h-6" />}
                            color="blue"
                        />
                        <StatCard
                            title="Total Leads"
                            value={stats.totalLeads.toLocaleString()}
                            icon={<Users className="w-6 h-6" />}
                            color="green"
                        />
                        <StatCard
                            title="Emails Sent"
                            value={stats.totalEmails.toLocaleString()}
                            icon={<Send className="w-6 h-6" />}
                            color="purple"
                        />
                        <StatCard
                            title="Open Rate"
                            value={`${stats.openRate.toFixed(1)}%`}
                            icon={<Eye className="w-6 h-6" />}
                            color="orange"
                        />
                    </div>
                )}

                {/* Secondary Stats */}
                {stats && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="bg-card rounded-lg p-4 border border-border">
                            <div className="flex items-center gap-3">
                                <MousePointer className="w-5 h-5 text-primary" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Click Rate</p>
                                    <p className="text-lg font-semibold text-foreground">{stats.clickRate.toFixed(1)}%</p>
                                </div>
                            </div>
                        </div>
                        <div className="bg-card rounded-lg p-4 border border-border">
                            <div className="flex items-center gap-3">
                                <Reply className="w-5 h-5 text-green-500" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Reply Rate</p>
                                    <p className="text-lg font-semibold text-foreground">{stats.replyRate.toFixed(1)}%</p>
                                </div>
                            </div>
                        </div>
                        <div className="bg-card rounded-lg p-4 border border-border">
                            <div className="flex items-center gap-3">
                                <Mail className="w-5 h-5 text-red-500" />
                                <div>
                                    <p className="text-sm text-muted-foreground">Bounce Rate</p>
                                    <p className="text-lg font-semibold text-foreground">{stats.bounceRate.toFixed(1)}%</p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Quick Actions */}
                <div>
                    <h2 className="text-lg font-semibold text-foreground mb-4">Quick Actions</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                        <QuickAction
                            title="Create Campaign"
                            description="Start a new cold email campaign"
                            href="/outreach/campaigns/new"
                            icon={<Plus className="w-5 h-5" />}
                        />
                        <QuickAction
                            title="Import Leads"
                            description="Add new leads to your lists"
                            href="/outreach/leads/import"
                            icon={<Users className="w-5 h-5" />}
                        />
                        <QuickAction
                            title="Add Inbox"
                            description="Connect an email account"
                            href="/outreach/inboxes/new"
                            icon={<Mail className="w-5 h-5" />}
                        />
                        <QuickAction
                            title="View Analytics"
                            description="Check detailed performance"
                            href="/outreach/analytics"
                            icon={<TrendingUp className="w-5 h-5" />}
                        />
                    </div>
                </div>

                {/* Recent Campaigns */}
                <div className="bg-card rounded-lg border border-border">
                    <div className="p-4 border-b border-border flex items-center justify-between">
                        <h2 className="text-lg font-semibold text-foreground">Recent Campaigns</h2>
                        <Link
                            href="/outreach/campaigns"
                            className="text-sm text-primary hover:underline"
                        >
                            View all
                        </Link>
                    </div>
                    {campaignsLoading ? (
                        <div className="p-4 space-y-3">
                            {[...Array(3)].map((_, i) => (
                                <div key={i} className="animate-pulse flex gap-4">
                                    <div className="h-4 bg-muted rounded w-1/3"></div>
                                    <div className="h-4 bg-muted rounded w-16"></div>
                                    <div className="h-4 bg-muted rounded w-16"></div>
                                </div>
                            ))}
                        </div>
                    ) : campaigns && campaigns.length > 0 ? (
                        <table className="w-full">
                            <thead>
                                <tr className="text-left text-sm text-muted-foreground border-b border-border">
                                    <th className="px-4 py-3 font-medium">Campaign</th>
                                    <th className="px-4 py-3 font-medium">Status</th>
                                    <th className="px-4 py-3 font-medium">Leads</th>
                                    <th className="px-4 py-3 font-medium">Sent</th>
                                    <th className="px-4 py-3 font-medium">Opens</th>
                                    <th className="px-4 py-3 font-medium">Replies</th>
                                </tr>
                            </thead>
                            <tbody>
                                {campaigns.map((campaign) => (
                                    <CampaignRow key={campaign.id} campaign={campaign} />
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <div className="p-8 text-center">
                            <Target className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-3" />
                            <p className="text-muted-foreground mb-4">No campaigns yet</p>
                            <Link
                                href="/outreach/campaigns/new"
                                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                            >
                                <Plus className="w-5 h-5" />
                                Create your first campaign
                            </Link>
                        </div>
                    )}
                </div>
            </div>
            )}
        </OutreachLayout>
    )
}

export default OutreachDashboard
