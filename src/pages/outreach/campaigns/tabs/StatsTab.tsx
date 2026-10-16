import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    Activity,
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    Clock3,
    Eye,
    Heart,
    Mail,
    MessageCircle,
    MousePointerClick,
    Send,
    ShieldCheck,
    Users,
} from 'lucide-react'
import { apiFetch } from '../../../../lib/api-client'
import {
    buildCampaignDashboardModel,
    fillDailyCampaignSeries,
    type CampaignDailyStat,
    type CampaignDashboardStats,
    type CampaignHealthTone,
} from './campaign-dashboard'

interface StatsResponse {
    stats: CampaignDashboardStats & {
        contacted: number
        replied: number
        bounced: number
    }
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

interface SequenceResponse {
    sequence: { id: string; steps: Step[] } | null
}

interface StatsTabProps {
    campaignId: string
    organizationId: string
}

const EMPTY_STATS: CampaignDashboardStats = {
    totalLeads: 0,
    eligibleLeads: 0,
    contactedLeads: 0,
    sentEmails: 0,
    preSendExcludedLeads: 0,
    uniqueOpeners: 0,
    uniqueClickers: 0,
    repliedLeads: 0,
    interestedLeads: 0,
    bouncedLeads: 0,
    totalOpens: 0,
    totalClicks: 0,
    totalReplies: 0,
    openRate: 0,
    clickRate: 0,
    replyRate: 0,
    positiveReplyRate: 0,
    bounceRate: 0,
}

const integer = (value: number) => Number(value || 0).toLocaleString()
const rate = (value: number) => `${Number(value || 0).toFixed(1)}%`
const stepRate = (value: number, sent: number) => sent > 0 ? `${((value / sent) * 100).toFixed(1)}%` : '—'

const toneStyles: Record<CampaignHealthTone, { badge: string; icon: string; panel: string }> = {
    neutral: {
        badge: 'border-white/15 bg-white/10 text-slate-100',
        icon: 'text-slate-500 dark:text-slate-400',
        panel: 'border-border bg-muted/30',
    },
    positive: {
        badge: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
        icon: 'text-emerald-500 dark:text-emerald-400',
        panel: 'border-emerald-500/20 bg-emerald-500/5',
    },
    warning: {
        badge: 'border-amber-400/25 bg-amber-400/10 text-amber-100',
        icon: 'text-amber-600 dark:text-amber-400',
        panel: 'border-amber-500/25 bg-amber-500/5',
    },
}

function DashboardSkeleton() {
    return (
        <div className="space-y-5 animate-pulse" aria-label="Loading campaign performance">
            <div className="h-72 rounded-2xl bg-muted" />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 rounded-xl bg-muted" />)}
            </div>
            <div className="h-80 rounded-xl bg-muted" />
        </div>
    )
}

function MetricCard({
    label,
    value,
    note,
    icon: Icon,
    alert = false,
}: {
    label: string
    value: string
    note: string
    icon: React.ComponentType<{ className?: string }>
    alert?: boolean
}) {
    return (
        <article className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <div className="mb-5 flex items-start justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
                <span className={`rounded-lg p-2 ${alert ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-muted text-foreground'}`}>
                    <Icon className="h-4 w-4" />
                </span>
            </div>
            <p className={`text-3xl font-semibold tracking-tight tabular-nums ${alert ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                {value}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{note}</p>
        </article>
    )
}

function DailyDeliveryChart({ rows }: { rows: CampaignDailyStat[] }) {
    const maxSent = Math.max(1, ...rows.map((row) => Number(row.emailsSent) || 0))
    const totalSent = rows.reduce((sum, row) => sum + (Number(row.emailsSent) || 0), 0)
    const totalReplies = rows.reduce((sum, row) => sum + (Number(row.replies) || 0), 0)
    const hasActivity = totalSent > 0

    return (
        <section className="rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Delivery rhythm</p>
                    <h3 className="mt-1 text-lg font-semibold text-foreground">Last 30 days</h3>
                </div>
                <div className="flex gap-6 text-sm">
                    <div><span className="font-semibold tabular-nums text-foreground">{integer(totalSent)}</span> <span className="text-muted-foreground">sent</span></div>
                    <div><span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{integer(totalReplies)}</span> <span className="text-muted-foreground">replies</span></div>
                </div>
            </div>
            <div className="p-5">
                {!hasActivity ? (
                    <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-center">
                        <Clock3 className="mb-3 h-6 w-6 text-muted-foreground" />
                        <p className="text-sm font-medium text-foreground">No sends in this window</p>
                        <p className="mt-1 text-xs text-muted-foreground">Daily delivery will appear after the first email is sent.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto pb-2">
                        <div className="min-w-[680px]">
                            <div className="flex h-44 items-end gap-1.5 border-b border-border" role="img" aria-label="Emails sent and replies by day for the last 30 days">
                                {rows.map((row) => {
                                    const sent = Number(row.emailsSent) || 0
                                    const replies = Number(row.replies) || 0
                                    const height = sent > 0 ? Math.max(4, (sent / maxSent) * 100) : 0
                                    return (
                                        <div
                                            key={row.date}
                                            className="group relative flex h-full min-w-0 flex-1 items-end"
                                            aria-label={`${row.date}: ${sent} sent, ${replies} replies`}
                                            title={`${row.date} · ${sent} sent · ${replies} replies`}
                                        >
                                            <div
                                                className="relative w-full rounded-t-sm bg-slate-300 transition-colors group-hover:bg-slate-500 dark:bg-slate-700 dark:group-hover:bg-slate-500"
                                                style={{ height: `${height}%` }}
                                            >
                                                {replies > 0 && (
                                                    <span className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-card bg-emerald-500" />
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                            <div className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                                <span>{rows[0]?.date.slice(5)}</span>
                                <span>{rows[Math.floor(rows.length / 2)]?.date.slice(5)}</span>
                                <span>{rows.at(-1)?.date.slice(5)}</span>
                            </div>
                            <div className="mt-4 flex items-center gap-5 text-xs text-muted-foreground">
                                <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-slate-400 dark:bg-slate-600" /> Emails sent</span>
                                <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Day with replies</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </section>
    )
}

export default function StatsTab({ campaignId, organizationId }: StatsTabProps) {
    const { data: statsData, isLoading: statsLoading, isError: statsError } = useQuery({
        queryKey: ['campaign-stats', organizationId, campaignId],
        queryFn: () => apiFetch<StatsResponse>(`/api/outreach/campaigns/${campaignId}/stats`),
        enabled: !!campaignId,
        refetchInterval: 60_000,
    })

    const { data: seqData, isLoading: seqLoading } = useQuery({
        queryKey: ['campaign-sequence', organizationId, campaignId],
        queryFn: () => apiFetch<SequenceResponse>(`/api/outreach/campaigns/${campaignId}/sequence`),
        enabled: !!campaignId,
    })

    const { data: dailyData = [], isLoading: dailyLoading } = useQuery({
        queryKey: ['campaign-daily-performance', organizationId, campaignId],
        queryFn: () => apiFetch<CampaignDailyStat[]>(
            `/api/outreach/campaigns/analytics/daily?organizationId=${encodeURIComponent(organizationId)}&days=30&campaignId=${encodeURIComponent(campaignId)}`,
        ),
        enabled: !!campaignId && !!organizationId,
        refetchInterval: 60_000,
    })

    const stats = statsData?.stats ?? EMPTY_STATS
    const model = React.useMemo(() => buildCampaignDashboardModel(stats), [stats])
    const dailySeries = React.useMemo(() => fillDailyCampaignSeries(dailyData, 30), [dailyData])
    const sortedSteps = React.useMemo(
        () => [...(seqData?.sequence?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder),
        [seqData],
    )

    if (statsLoading) return <DashboardSkeleton />

    if (statsError) {
        return (
            <div role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center">
                <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-red-600 dark:text-red-400" />
                <p className="font-medium text-foreground">Campaign performance could not be loaded.</p>
                <p className="mt-1 text-sm text-muted-foreground">Refresh the page before making a campaign decision.</p>
            </div>
        )
    }

    const healthStyle = toneStyles[model.health.tone]
    const HealthIcon = model.health.tone === 'warning' ? AlertTriangle : model.health.tone === 'positive' ? CheckCircle2 : Activity

    return (
        <div className="space-y-5">
            <section className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 p-6 text-white shadow-sm sm:p-8">
                <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full border border-white/5" />
                <div className="pointer-events-none absolute -right-4 -top-10 h-40 w-40 rounded-full border border-white/5" />

                <div className="relative grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
                    <div>
                        <div className="mb-8 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                            <Activity className="h-4 w-4" />
                            Campaign performance
                        </div>
                        <p className="text-sm text-slate-400">Primary outcome</p>
                        <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">
                            <p className="text-6xl font-semibold tracking-[-0.06em] tabular-nums sm:text-7xl">{integer(stats.interestedLeads)}</p>
                            <div className="pb-2">
                                <p className="flex items-center gap-2 text-lg font-medium text-emerald-300"><Heart className="h-5 w-5" /> Positive replies</p>
                                <p className="mt-1 text-sm tabular-nums text-slate-400">{rate(stats.positiveReplyRate)} of contacted leads</p>
                            </div>
                        </div>

                        <div className="mt-8 max-w-2xl">
                            <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                                <span>{integer(stats.contactedLeads)} of {integer(stats.eligibleLeads)} eligible leads contacted</span>
                                <span className="tabular-nums">{rate(model.contactedProgress)}</span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-white/10">
                                <div className="h-full rounded-full bg-emerald-400" style={{ width: `${model.contactedProgress}%` }} />
                            </div>
                        </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-sm">
                        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${healthStyle.badge}`}>
                            <HealthIcon className="h-3.5 w-3.5" />
                            {model.health.label}
                        </span>
                        <p className="mt-4 text-sm leading-6 text-slate-300">{model.health.description}</p>
                        <div className="mt-5 grid grid-cols-2 gap-4 border-t border-white/10 pt-4">
                            <div>
                                <p className="text-[11px] uppercase tracking-wider text-slate-500">Remaining</p>
                                <p className="mt-1 text-xl font-semibold tabular-nums">{integer(model.remainingEligible)}</p>
                            </div>
                            <div>
                                <p className="text-[11px] uppercase tracking-wider text-slate-500">Excluded pre-send</p>
                                <p className="mt-1 text-xl font-semibold tabular-nums">{integer(stats.preSendExcludedLeads)}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Campaign key performance indicators">
                <MetricCard label="Emails sent" value={integer(stats.sentEmails)} note="Actual deliveries, including follow-ups" icon={Send} />
                <MetricCard label="Leads contacted" value={integer(stats.contactedLeads)} note={`${integer(stats.totalLeads)} total leads enrolled`} icon={Users} />
                <MetricCard label="Reply rate" value={rate(stats.replyRate)} note={`${integer(stats.repliedLeads)} unique leads replied`} icon={MessageCircle} />
                <MetricCard label="Bounce rate" value={rate(stats.bounceRate)} note={`${integer(stats.bouncedLeads)} unique leads bounced`} icon={ShieldCheck} alert={stats.bounceRate > 5} />
            </section>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
                <section className="rounded-xl border border-border bg-card p-5 sm:p-6">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Lead funnel</p>
                            <h3 className="mt-1 text-lg font-semibold text-foreground">From audience to interest</h3>
                        </div>
                        <p className="text-xs text-muted-foreground">Rates use unique contacted leads</p>
                    </div>

                    <div className="mt-7 space-y-5">
                        {model.funnel.map((stage, index) => (
                            <div key={stage.label}>
                                <div className="mb-2 flex items-center justify-between gap-4 text-sm">
                                    <span className="flex items-center gap-2 font-medium text-foreground">
                                        <span className={`h-2 w-2 rounded-full ${stage.label === 'Interested' ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-600'}`} />
                                        {stage.label}
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                        <strong className="font-semibold text-foreground">{integer(stage.value)}</strong> · {rate(stage.rate)}
                                    </span>
                                </div>
                                <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                                    <div
                                        className={`h-full rounded-full ${stage.label === 'Interested' ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-600'}`}
                                        style={{ width: `${stage.rate > 0 ? Math.max(stage.rate, 1.5) : 0}%` }}
                                    />
                                </div>
                                {index < model.funnel.length - 1 && <ArrowRight className="ml-3 mt-2 h-3.5 w-3.5 rotate-90 text-muted-foreground/50" />}
                            </div>
                        ))}
                    </div>

                    <div className="mt-7 grid gap-3 border-t border-border pt-5 sm:grid-cols-3">
                        <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                            <Eye className="h-4 w-4 text-muted-foreground" />
                            <div><p className="text-xs text-muted-foreground">Open rate</p><p className="font-semibold tabular-nums text-foreground">{rate(stats.openRate)}</p></div>
                        </div>
                        <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                            <MousePointerClick className="h-4 w-4 text-muted-foreground" />
                            <div><p className="text-xs text-muted-foreground">Click rate</p><p className="font-semibold tabular-nums text-foreground">{rate(stats.clickRate)}</p></div>
                        </div>
                        <div className="flex items-center gap-3 rounded-lg bg-muted/40 p-3">
                            <Mail className="h-4 w-4 text-muted-foreground" />
                            <div><p className="text-xs text-muted-foreground">Emails / lead</p><p className="font-semibold tabular-nums text-foreground">{stats.contactedLeads > 0 ? (stats.sentEmails / stats.contactedLeads).toFixed(1) : '—'}</p></div>
                        </div>
                    </div>
                </section>

                <aside className="rounded-xl border border-border bg-card p-5 sm:p-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">What to watch</p>
                    <h3 className="mt-1 text-lg font-semibold text-foreground">Decision signals</h3>
                    <div className="mt-6 space-y-3">
                        {model.insights.map((insight) => {
                            const style = toneStyles[insight.tone]
                            const Icon = insight.tone === 'warning' ? AlertTriangle : insight.tone === 'positive' ? CheckCircle2 : Activity
                            return (
                                <div key={insight.title} className={`rounded-lg border p-4 ${style.panel}`}>
                                    <div className="flex items-start gap-3">
                                        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon}`} />
                                        <div>
                                            <p className="text-sm font-semibold text-foreground">{insight.title}</p>
                                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{insight.body}</p>
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </aside>
            </div>

            {dailyLoading ? <div className="h-72 animate-pulse rounded-xl bg-muted" /> : <DailyDeliveryChart rows={dailySeries} />}

            <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-col gap-1 border-b border-border p-5 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Sequence performance</p>
                        <h3 className="mt-1 text-lg font-semibold text-foreground">Performance by step</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">Event totals and send-level rates</p>
                </div>

                {seqLoading && (
                    <div className="space-y-2 p-5">
                        {[0, 1, 2].map((item) => <div key={item} className="h-10 animate-pulse rounded bg-muted" />)}
                    </div>
                )}

                {!seqLoading && sortedSteps.length === 0 && (
                    <div className="p-10 text-center">
                        <Mail className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                        <p className="text-sm font-medium text-foreground">No sequence steps yet</p>
                        <p className="mt-1 text-xs text-muted-foreground">Add a step to compare subject and reply performance.</p>
                    </div>
                )}

                {!seqLoading && sortedSteps.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px]">
                            <thead className="bg-muted/40">
                                <tr>
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Step</th>
                                    <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">Subject</th>
                                    <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sent</th>
                                    <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Opens</th>
                                    <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Clicks</th>
                                    <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Replies</th>
                                    <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reply rate</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedSteps.map((step) => (
                                    <tr key={step.id} className="border-t border-border transition-colors hover:bg-muted/20">
                                        <td className="px-5 py-4 text-sm font-semibold text-foreground">#{step.stepOrder}</td>
                                        <td className="max-w-xs truncate px-5 py-4 text-sm text-foreground">
                                            {step.subject ?? <span className="italic text-muted-foreground">No subject</span>}
                                        </td>
                                        <td className="px-5 py-4 text-right text-sm tabular-nums text-foreground">{integer(step.totalSent)}</td>
                                        <td className="px-5 py-4 text-right text-sm tabular-nums text-muted-foreground">{integer(step.totalOpens)}</td>
                                        <td className="px-5 py-4 text-right text-sm tabular-nums text-muted-foreground">{integer(step.totalClicks)}</td>
                                        <td className="px-5 py-4 text-right text-sm tabular-nums text-muted-foreground">{integer(step.totalReplies)}</td>
                                        <td className="px-5 py-4 text-right text-sm font-semibold tabular-nums text-foreground">{stepRate(step.totalReplies, step.totalSent)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </div>
    )
}
