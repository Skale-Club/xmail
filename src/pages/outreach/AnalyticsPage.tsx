import * as React from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp, Mail, Users, Target, Eye, MousePointer } from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { apiFetch } from '../../lib/api-client'
import { useOrganization } from '../../hooks/useOrganization'

interface AnalyticsData {
    overview: {
        totalCampaigns: number
        activeCampaigns: number
        totalLeads: number
        totalEmailsSent: number
        totalOpens: number
        totalClicks: number
        totalReplies: number
        totalBounces: number
        avgOpenRate: number
        avgClickRate: number
        avgReplyRate: number
        avgBounceRate: number
    }
}

type DailyStat = {
    date: string
    emailsSent: number
    opens: number
    clicks: number
    replies: number
}

type StatColor = 'blue' | 'green' | 'purple' | 'orange' | 'red'

type AnalyticsWindowDays = 7 | 30 | 90

interface CampaignOption {
    id: string
    name: string
}

function analyticsQuery(organizationId: string, days: AnalyticsWindowDays, campaignId: string) {
    const params = new URLSearchParams({ organizationId, days: String(days) })
    if (campaignId !== 'all') params.set('campaignId', campaignId)
    return params.toString()
}

async function fetchAnalytics(organizationId: string, days: AnalyticsWindowDays, campaignId: string): Promise<AnalyticsData> {
    return apiFetch<AnalyticsData>(`/api/outreach/campaigns/analytics?${analyticsQuery(organizationId, days, campaignId)}`)
}

async function fetchDailyStats(organizationId: string, days: AnalyticsWindowDays, campaignId: string): Promise<DailyStat[]> {
    return apiFetch<DailyStat[]>(`/api/outreach/campaigns/analytics/daily?${analyticsQuery(organizationId, days, campaignId)}`)
}

async function fetchCampaignOptions(organizationId: string): Promise<CampaignOption[]> {
    const data = await apiFetch<{ campaigns?: CampaignOption[] }>(`/api/outreach/campaigns?organizationId=${organizationId}&limit=100`)
    return data.campaigns || []
}

// Short weekday + day-of-month (e.g. "Mon 10"), tabular-nums so the day digits line up across
// rows instead of jittering per label width.
function formatDayLabel(isoDate: string): string {
    const parsed = new Date(isoDate)
    if (Number.isNaN(parsed.getTime())) return isoDate
    return parsed.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })
}

function StatCard({
    title,
    value,
    icon,
    color = 'blue',
}: {
    title: string
    value: string | number
    icon: ReactNode
    color?: StatColor
}) {
    const colorClasses: Record<StatColor, string> = {
        blue: 'text-primary',
        green: 'text-green-600 dark:text-green-400',
        purple: 'text-purple-600 dark:text-purple-400',
        orange: 'text-orange-600 dark:text-orange-400',
        red: 'text-red-600 dark:text-red-400',
    }

    const displayValue = typeof value === 'number' ? value.toLocaleString() : value

    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-sm text-muted-foreground">{title}</p>
                    <p className="text-2xl font-bold text-foreground">{displayValue}</p>
                </div>
                <div className={`rounded-lg bg-muted p-2 ${colorClasses[color]}`}>
                    {icon}
                </div>
            </div>
        </div>
    )
}

function MiniChart({
    data,
    title,
    unit = '',
    color = 'blue',
}: {
    data: { name: string; value: number }[]
    title: string
    unit?: string
    color?: 'blue' | 'green' | 'purple' | 'orange'
}) {
    // Guard against an empty window and an all-zero window (e.g. no sends yet in the selected
    // period) — both are real states now that this reads live data instead of fixture numbers,
    // and Math.max(...[]) / a zero max would otherwise divide by zero or throw.
    const max = Math.max(1, ...data.map((d) => d.value))
    const colorClasses = {
        blue: 'bg-primary',
        green: 'bg-green-500',
        purple: 'bg-purple-500',
        orange: 'bg-orange-500',
    }

    return (
        <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">{title}</h4>
            {data.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No data for this period</p>
            ) : (
                <div className="mt-2 space-y-2">
                    {data.map((item, index) => (
                        <div key={index} className="flex items-center gap-2">
                            <span className="w-16 shrink-0 text-sm tabular-nums text-muted-foreground">{item.name}</span>
                            <div className="h-2 flex-1 rounded-full bg-muted">
                                <div
                                    className={`h-2 rounded-full ${colorClasses[color]}`}
                                    style={{ width: `${(item.value / max) * 100}%` }}
                                />
                            </div>
                            <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums text-foreground">
                                {item.value}{unit}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

export function AnalyticsPage() {
    const { currentOrganization } = useOrganization()
    const [days, setDays] = React.useState<AnalyticsWindowDays>(30)
    const [campaignId, setCampaignId] = React.useState('all')

    const { data: campaignOptions = [] } = useQuery({
        queryKey: ['campaigns', 'analytics-options', currentOrganization?.id],
        queryFn: () => fetchCampaignOptions(currentOrganization!.id),
        enabled: !!currentOrganization?.id,
    })

    const { data: overview, isLoading: overviewLoading } = useQuery({
        queryKey: ['outreach-analytics', currentOrganization?.id, days, campaignId],
        queryFn: () => fetchAnalytics(currentOrganization!.id, days, campaignId),
        enabled: !!currentOrganization,
    })

    const { data: dailyStats, isLoading: dailyLoading } = useQuery({
        queryKey: ['outreach-daily-stats', currentOrganization?.id, days, campaignId],
        queryFn: () => fetchDailyStats(currentOrganization!.id, days, campaignId),
        enabled: !!currentOrganization,
    })

    const sentSeries = (dailyStats ?? []).map((stat) => ({ name: formatDayLabel(stat.date), value: stat.emailsSent }))
    const openRateSeries = (dailyStats ?? []).map((stat) => ({
        name: formatDayLabel(stat.date),
        value: stat.emailsSent > 0 ? Number(((stat.opens / stat.emailsSent) * 100).toFixed(1)) : 0,
    }))

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view analytics</p>
                </div>
            ) : (
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Analytics</h1>
                        <p className="mt-1 text-muted-foreground">
                            Track your cold email campaign performance
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <select
                            value={days}
                            onChange={(e) => setDays(Number(e.target.value) as AnalyticsWindowDays)}
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                        >
                            <option value={7}>Last 7 days</option>
                            <option value={30}>Last 30 days</option>
                            <option value={90}>Last 90 days</option>
                        </select>
                        <select
                            value={campaignId}
                            onChange={(e) => setCampaignId(e.target.value)}
                            className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                        >
                            <option value="all">All Campaigns</option>
                            {campaignOptions.map((campaign) => (
                                <option key={campaign.id} value={campaign.id}>
                                    {campaign.name}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                {overviewLoading ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                        {[...Array(4)].map((_, i) => (
                            <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse">
                                <div className="mb-2 h-4 w-1/2 rounded bg-muted" />
                                <div className="h-8 w-3/4 rounded bg-muted" />
                            </div>
                        ))}
                    </div>
                ) : overview?.overview && (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                        <StatCard
                            title="Active Campaigns"
                            value={overview.overview.activeCampaigns}
                            icon={<Target className="h-6 w-6" />}
                            color="blue"
                        />
                        <StatCard
                            title="Total Leads"
                            value={overview.overview.totalLeads.toLocaleString()}
                            icon={<Users className="h-6 w-6" />}
                            color="green"
                        />
                        <StatCard
                            title="Emails Sent"
                            value={overview.overview.totalEmailsSent.toLocaleString()}
                            icon={<Mail className="h-6 w-6" />}
                            color="purple"
                        />
                        <StatCard
                            title="Avg Open Rate"
                            value={`${overview.overview.avgOpenRate.toFixed(1)}%`}
                            icon={<Eye className="h-6 w-6" />}
                            color="orange"
                        />
                    </div>
                )}

                {overview?.overview && (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        <StatCard
                            title="Avg Click Rate"
                            value={`${overview.overview.avgClickRate.toFixed(1)}%`}
                            icon={<MousePointer className="h-5 w-5" />}
                            color="blue"
                        />
                        <StatCard
                            title="Avg Reply Rate"
                            value={`${overview.overview.avgReplyRate.toFixed(1)}%`}
                            icon={<TrendingUp className="h-5 w-5" />}
                            color="green"
                        />
                        <StatCard
                            title="Avg Bounce Rate"
                            value={`${overview.overview.avgBounceRate.toFixed(1)}%`}
                            icon={<Target className="h-5 w-5" />}
                            color="red"
                        />
                    </div>
                )}

                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    {dailyLoading ? (
                        [0, 1].map((i) => (
                            <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse">
                                <div className="mb-3 h-4 w-1/3 rounded bg-muted" />
                                <div className="space-y-2">
                                    {[...Array(5)].map((_, row) => (
                                        <div key={row} className="h-4 rounded bg-muted" />
                                    ))}
                                </div>
                            </div>
                        ))
                    ) : (
                        <>
                            <MiniChart
                                title="Emails Sent Over Time"
                                data={sentSeries}
                                color="blue"
                            />
                            <MiniChart
                                title="Open Rate by Day"
                                data={openRateSeries}
                                unit="%"
                                color="green"
                            />
                        </>
                    )}
                </div>

                <div className="rounded-lg border border-border bg-card">
                    <div className="border-b border-border p-4">
                        <h3 className="font-semibold text-foreground">Daily Performance</h3>
                    </div>
                    {dailyLoading ? (
                        <div className="space-y-3 p-4">
                            {[...Array(7)].map((_, i) => (
                                <div key={i} className="flex gap-4 animate-pulse">
                                    <div className="h-4 w-20 rounded bg-muted" />
                                    <div className="h-4 w-16 rounded bg-muted" />
                                </div>
                            ))}
                        </div>
                    ) : dailyStats && dailyStats.length > 0 ? (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-border">
                                        <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Date</th>
                                        <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Sent</th>
                                        <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Opens</th>
                                        <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Clicks</th>
                                        <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Replies</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {dailyStats.map((stat, index) => (
                                        <tr key={index} className="border-b border-border">
                                            <td className="px-4 py-3 text-sm text-foreground">
                                                {new Date(stat.date).toLocaleDateString()}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{stat.emailsSent}</td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{stat.opens}</td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{stat.clicks}</td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{stat.replies}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className="p-8 text-center text-muted-foreground">
                            No daily stats available
                        </div>
                    )}
                </div>
            </div>
            )}
        </OutreachLayout>
    )
}

export default AnalyticsPage
