import { useEffect, useState } from 'react'
import { AlertCircle, BarChart2, CheckCircle, Eye, Mail, MousePointer, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card'
import { Progress } from '../../ui/progress'
import { Button } from '../../ui/button'
import { apiFetch } from './shared'

interface DailyStat {
    date: string
    sent: number
    delivered: number
    opened: number
    clicked: number
    bounced: number
    held: number
}

interface Summary {
    total: number
    sent: number
    delivered: number
    bounced: number
    held: number
    pending: number
    opened: number
    clicked: number
}

interface Rates {
    deliveryRate: number
    openRate: number
    clickRate: number
    bounceRate: number
}

interface RecentMessage {
    id: string
    subject: string | null
    fromAddress: string
    toAddresses: string[]
    status: string
    direction: string
    openedAt: string | null
    sentAt: string | null
    deliveredAt: string | null
    createdAt: string
}

interface Analytics {
    summary: Summary
    rates: Rates
    daily: DailyStat[]
    recentMessages: RecentMessage[]
}

function pct(value: number) {
    return `${value.toFixed(1)}%`
}

function formatDate(value: string | null) {
    return value ? new Date(value).toLocaleString() : '-'
}

function formatShortDate(value: string) {
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getStatusColor(status: string) {
    switch (status) {
        case 'delivered':
            return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
        case 'sent':
            return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
        case 'bounced':
        case 'failed':
            return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
        case 'held':
            return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
        default:
            return 'bg-muted text-muted-foreground'
    }
}

interface AnalyticsTabProps {
    organizationId: string
}

export default function AnalyticsTab({ organizationId }: AnalyticsTabProps) {
    const [days, setDays] = useState(30)
    const [analytics, setAnalytics] = useState<Analytics | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        void fetchAnalytics()
    }, [organizationId, days])

    async function fetchAnalytics() {
        if (!organizationId) return

        setIsLoading(true)
        setError(null)
        try {
            const data = await apiFetch<Analytics>(`/api/organizations/${organizationId}/statistics?days=${days}`)
            setAnalytics(data)
        } catch (err) {
            console.error('Error fetching analytics:', err)
            setError(err instanceof Error ? err.message : 'Failed to load analytics')
        } finally {
            setIsLoading(false)
        }
    }

    const dailyData = analytics?.daily ?? []
    const maxBarValue = dailyData.length ? Math.max(...dailyData.map((day) => day.sent + day.bounced), 1) : 1
    const { summary, rates } = analytics ?? { summary: null, rates: null }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-end gap-2">
                <select
                    className="flex h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={days}
                    onChange={(event) => setDays(Number(event.target.value))}
                >
                    <option value={7}>Last 7 days</option>
                    <option value={30}>Last 30 days</option>
                    <option value={90}>Last 90 days</option>
                </select>
                <Button variant="outline" size="sm" onClick={() => void fetchAnalytics()} disabled={isLoading}>
                    <RefreshCw className={`mr-1 h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
            </div>

            {isLoading && (
                <div className="flex justify-center p-12">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
            )}

            {!isLoading && analytics && (
                <>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <MetricCard
                            icon={<Mail className="h-4 w-4 text-muted-foreground" />}
                            label="Total Sent"
                            value={summary!.sent}
                            sub={`${summary!.total} total messages`}
                        />
                        <MetricCard
                            icon={<CheckCircle className="h-4 w-4 text-green-500" />}
                            label="Delivery Rate"
                            value={pct(rates!.deliveryRate)}
                            sub={`${summary!.delivered} delivered`}
                            progress={rates!.deliveryRate}
                            progressColor="bg-green-500"
                        />
                        <MetricCard
                            icon={<Eye className="h-4 w-4 text-blue-500" />}
                            label="Open Rate"
                            value={pct(rates!.openRate)}
                            sub={`${summary!.opened} opened`}
                            progress={rates!.openRate}
                            progressColor="bg-blue-500"
                        />
                        <MetricCard
                            icon={<MousePointer className="h-4 w-4 text-violet-500" />}
                            label="Click Rate"
                            value={pct(rates!.clickRate)}
                            sub={`${summary!.clicked} clicks`}
                            progress={rates!.clickRate}
                            progressColor="bg-violet-500"
                        />
                        <MetricCard
                            icon={<AlertCircle className="h-4 w-4 text-red-500" />}
                            label="Bounce Rate"
                            value={pct(rates!.bounceRate)}
                            sub={`${summary!.bounced} bounced`}
                            progress={rates!.bounceRate}
                            progressColor="bg-red-500"
                        />
                        <MetricCard
                            icon={<BarChart2 className="h-4 w-4 text-yellow-500" />}
                            label="Held"
                            value={summary!.held}
                            sub="Waiting for release"
                        />
                        <MetricCard
                            icon={<BarChart2 className="h-4 w-4 text-muted-foreground" />}
                            label="Pending / Queued"
                            value={summary!.pending}
                            sub="In pipeline"
                        />
                    </div>

                    {dailyData.length > 0 && (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Daily Activity</CardTitle>
                                <CardDescription>Sent, opened and bounced per day</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="flex h-32 items-end gap-1 overflow-x-auto pb-2">
                                    {dailyData.map((day) => (
                                        <div
                                            key={day.date}
                                            className="flex flex-shrink-0 flex-col items-center gap-0.5"
                                            style={{ minWidth: 28 }}
                                            title={`${formatShortDate(day.date)}\nSent: ${day.sent}\nOpened: ${day.opened}\nBounced: ${day.bounced}`}
                                        >
                                            <div className="flex w-5 flex-col justify-end gap-px" style={{ height: 100 }}>
                                                <div
                                                    className="w-full rounded-t bg-red-400"
                                                    style={{ height: `${(day.bounced / maxBarValue) * 100}%`, minHeight: day.bounced > 0 ? 2 : 0 }}
                                                />
                                                <div
                                                    className="w-full bg-blue-400"
                                                    style={{ height: `${((day.sent - day.bounced) / maxBarValue) * 100}%`, minHeight: day.sent > 0 ? 2 : 0 }}
                                                />
                                                <div
                                                    className="w-full rounded-b bg-green-400"
                                                    style={{ height: `${(day.opened / maxBarValue) * 100}%`, minHeight: day.opened > 0 ? 2 : 0 }}
                                                />
                                            </div>
                                            <span className="mt-1 origin-left rotate-45 text-[9px] text-muted-foreground">
                                                {formatShortDate(day.date)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-4 flex gap-4 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-blue-400" /> Sent</span>
                                    <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-green-400" /> Opened</span>
                                    <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm bg-red-400" /> Bounced</span>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {dailyData.length === 0 && (
                        <Card>
                            <CardContent className="py-8 text-center text-sm text-muted-foreground">
                                No daily data yet. Stats are recorded as messages are sent and opened.
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Recent Messages</CardTitle>
                            <CardDescription>Last 20 messages - eye icon indicates opened</CardDescription>
                        </CardHeader>
                        <CardContent className="p-0">
                            <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-border text-sm">
                                    <thead>
                                        <tr className="bg-muted/50">
                                            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Status</th>
                                            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Subject</th>
                                            <th className="px-4 py-2 text-left font-medium text-muted-foreground">From</th>
                                            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Opened</th>
                                            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Sent</th>
                                            <th className="px-4 py-2 text-left font-medium text-muted-foreground">Created</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {analytics.recentMessages.length === 0 ? (
                                            <tr>
                                                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                                                    No messages yet.
                                                </td>
                                            </tr>
                                        ) : (
                                            analytics.recentMessages.map((message) => (
                                                <tr key={message.id} className="hover:bg-muted/30">
                                                    <td className="px-4 py-2">
                                                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getStatusColor(message.status)}`}>
                                                            {message.status}
                                                        </span>
                                                    </td>
                                                    <td className="max-w-[200px] truncate px-4 py-2" title={message.subject ?? ''}>
                                                        {message.subject || <span className="text-muted-foreground">(no subject)</span>}
                                                    </td>
                                                    <td className="max-w-[160px] truncate px-4 py-2 text-muted-foreground">
                                                        {message.fromAddress}
                                                    </td>
                                                    <td className="px-4 py-2">
                                                        {message.openedAt ? (
                                                            <span className="flex items-center gap-1 text-blue-600" title={formatDate(message.openedAt)}>
                                                                <Eye className="h-3.5 w-3.5" />
                                                                <span className="text-xs">{formatDate(message.openedAt)}</span>
                                                            </span>
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">-</span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(message.sentAt)}</td>
                                                    <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(message.createdAt)}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </>
            )}

            {!isLoading && error && (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => void fetchAnalytics()}>
                        Try again
                    </Button>
                </div>
            )}

            {!isLoading && !error && !analytics && (
                <Card>
                    <CardContent className="py-12 text-center text-muted-foreground">
                        No data found yet.
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

function MetricCard({
    icon,
    label,
    value,
    sub,
    progress,
    progressColor,
}: {
    icon: React.ReactNode
    label: string
    value: string | number
    sub: string
    progress?: number
    progressColor?: string
}) {
    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                {icon}
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{value}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
                {progress !== undefined && (
                    <Progress
                        value={progress}
                        className="mt-2 h-1.5"
                        indicatorClassName={progressColor}
                    />
                )}
            </CardContent>
        </Card>
    )
}
