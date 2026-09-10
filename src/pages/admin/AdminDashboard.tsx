import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { AlertCircle, Building2, Globe, Users, Mail, HardDrive } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Progress } from '../../components/ui/progress'
import { toast } from '../../components/ui/toaster'
import { apiFetch, loadDomains } from './helpers'

interface DashboardStats {
    organizations: number
    domains: number
    users: number
    messages: {
        sent: number
        delivered: number
        bounced: number
        pending: number
    }
}

interface UserUsage {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    messageCount: number
    attachmentBytes: number
}

interface SystemUsage {
    storage: {
        used: number
        limit: number
        path?: string
    }
    users: UserUsage[]
}

function formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return '0 MB'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(1024))
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

interface OrgStatisticsSummary {
    summary: {
        sent: number
        delivered: number
        bounced: number
        pending: number
    }
}

export default function AdminDashboard() {
    const [, navigate] = useLocation()
    const [stats, setStats] = useState<DashboardStats>({
        organizations: 0,
        domains: 0,
        users: 0,
        messages: { sent: 0, delivered: 0, bounced: 0, pending: 0 },
    })
    const [systemUsage, setSystemUsage] = useState<SystemUsage | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [usageLoading, setUsageLoading] = useState(true)

    useEffect(() => {
        void fetchStats()
        void fetchUsage()
    }, [])

    async function fetchStats() {
        setIsLoading(true)
        setError(null)
        try {
            const [orgPayload, userPayload] = await Promise.all([
                apiFetch<{ organizations: { id: string }[] }>('/api/organizations'),
                apiFetch<{ users: unknown[] }>('/api/users'),
            ])
            const organizations = orgPayload.organizations || []

            // No system-wide domains/messages endpoint exists — these are per-organization
            // (?organizationId= required), so fan out in parallel rather than loop sequentially.
            const [domainLists, statsLists] = await Promise.all([
                Promise.all(organizations.map((organization) => loadDomains(organization.id).catch(() => []))),
                Promise.all(
                    organizations.map((organization) =>
                        apiFetch<OrgStatisticsSummary>(`/api/organizations/${organization.id}/statistics?days=30`).catch(() => null)
                    )
                ),
            ])

            const verifiedDomains = domainLists
                .flat()
                .filter((domain) => domain.verificationStatus === 'verified').length

            const messages = statsLists.reduce(
                (totals, orgStats) => {
                    if (!orgStats) return totals
                    return {
                        sent: totals.sent + orgStats.summary.sent,
                        delivered: totals.delivered + orgStats.summary.delivered,
                        bounced: totals.bounced + orgStats.summary.bounced,
                        pending: totals.pending + orgStats.summary.pending,
                    }
                },
                { sent: 0, delivered: 0, bounced: 0, pending: 0 }
            )

            setStats({
                organizations: organizations.length,
                domains: verifiedDomains,
                users: (userPayload.users || []).length,
                messages,
            })
        } catch (err) {
            console.error('Error fetching stats:', err)
            setError(err instanceof Error ? err.message : 'Failed to load dashboard stats')
        } finally {
            setIsLoading(false)
        }
    }

    async function fetchUsage() {
        try {
            const data = await apiFetch<SystemUsage>('/api/system/usage')
            setSystemUsage(data)
        } catch (error) {
            console.error('Error fetching usage:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load system usage', variant: 'destructive' })
        } finally {
            setUsageLoading(false)
        }
    }

    const storagePercent = systemUsage
        ? Math.min(100, (systemUsage.storage.used / systemUsage.storage.limit) * 100)
        : 0

    const maxUserMessages = systemUsage?.users.length
        ? Math.max(...systemUsage.users.map((u) => u.messageCount), 1)
        : 1

    const maxUserBytes = systemUsage?.users.length
        ? Math.max(...systemUsage.users.map((u) => u.attachmentBytes), 1)
        : 1

    return (
        <div className="space-y-8 pb-8">
            {isLoading ? (
                <div className="grid gap-6 md:grid-cols-3">
                    {[1, 2, 3].map((i) => (
                        <Card key={i} className="animate-pulse">
                            <CardHeader className="pb-2">
                                <div className="h-4 w-24 rounded bg-muted"></div>
                            </CardHeader>
                            <CardContent>
                                <div className="h-8 w-16 rounded bg-muted"></div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            ) : error ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => void fetchStats()}>
                        Try again
                    </Button>
                </div>
            ) : (
                <>
                    {/* Top Row: Primary Infrastructure Metrics */}
                    <div className="grid gap-6 md:grid-cols-3">
                        <Card className="bg-card">
                            <CardContent className="flex min-h-24 items-center gap-4 p-6 pt-6">
                                <div className="p-3 rounded-xl bg-primary/10 text-primary shrink-0">
                                    <Building2 className="h-6 w-6" />
                                </div>
                                <div className="flex min-h-12 flex-col justify-center">
                                    <p className="text-sm font-medium text-muted-foreground">Organizations</p>
                                    <h3 className="mt-1 text-2xl font-semibold tracking-tight text-foreground leading-none">{stats.organizations}</h3>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="bg-card">
                            <CardContent className="flex min-h-24 items-center gap-4 p-6 pt-6">
                                <div className="p-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0">
                                    <Globe className="h-6 w-6" />
                                </div>
                                <div className="flex min-h-12 flex-col justify-center">
                                    <p className="text-sm font-medium text-muted-foreground">Verified Domains</p>
                                    <h3 className="mt-1 text-2xl font-semibold tracking-tight text-foreground leading-none">{stats.domains}</h3>
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="bg-card">
                            <CardContent className="flex min-h-24 items-center gap-4 p-6 pt-6">
                                <div className="p-3 rounded-xl bg-secondary text-secondary-foreground shrink-0">
                                    <Users className="h-6 w-6" />
                                </div>
                                <div className="flex min-h-12 flex-col justify-center">
                                    <p className="text-sm font-medium text-muted-foreground">Total Users</p>
                                    <h3 className="mt-1 text-2xl font-semibold tracking-tight text-foreground leading-none">{stats.users}</h3>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Middle Section: Deliverability & Storage Bento */}
                    <div className="grid gap-6 md:grid-cols-3">
                        {/* Deliverability Card (Spans 2 columns) */}
                        <Card className="md:col-span-2">
                            <CardHeader className="pb-4">
                                <CardTitle className="text-lg font-medium flex items-center gap-2">
                                    <Mail className="h-5 w-5 text-muted-foreground" />
                                    Email Deliverability
                                </CardTitle>
                                <CardDescription>Message processing metrics across all organizations, last 30 days</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    <div className="space-y-2 p-4 rounded-xl bg-muted/50 border border-border/50">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sent</p>
                                        <div className="text-2xl font-semibold text-foreground">{stats.messages.sent}</div>
                                    </div>
                                    <div className="space-y-2 p-4 rounded-xl bg-primary/5 border border-primary/10">
                                        <p className="text-xs font-medium text-primary uppercase tracking-wider">Delivered</p>
                                        <div className="text-2xl font-semibold text-foreground">{stats.messages.delivered}</div>
                                    </div>
                                    <div className="space-y-2 p-4 rounded-xl bg-destructive/5 border border-destructive/10">
                                        <p className="text-xs font-medium text-destructive uppercase tracking-wider">Bounced</p>
                                        <div className="text-2xl font-semibold text-foreground">{stats.messages.bounced}</div>
                                    </div>
                                    <div className="space-y-2 p-4 rounded-xl bg-muted/50 border border-border/50">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pending</p>
                                        <div className="text-2xl font-semibold text-foreground">{stats.messages.pending}</div>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Storage Card */}
                        <Card>
                            <CardHeader className="pb-4">
                                <CardTitle className="text-lg font-medium flex items-center gap-2">
                                    <HardDrive className="h-5 w-5 text-muted-foreground" />
                                    System Storage
                                </CardTitle>
                                <CardDescription>Server disk usage</CardDescription>
                            </CardHeader>
                            <CardContent>
                                {usageLoading ? (
                                    <div className="space-y-4">
                                        <div className="h-2 w-full rounded-full bg-muted animate-pulse"></div>
                                        <div className="h-4 w-2/3 rounded bg-muted animate-pulse"></div>
                                    </div>
                                ) : (
                                    <div className="space-y-6">
                                        <div className="flex items-end justify-between">
                                            <div>
                                                <div className="text-3xl font-semibold tracking-tight">
                                                    {systemUsage ? formatBytes(systemUsage.storage.used) : '0 MB'}
                                                </div>
                                                <p className="text-sm text-muted-foreground mt-1">
                                                    of {systemUsage ? formatBytes(systemUsage.storage.limit) : '10 GB'} limit
                                                </p>
                                                {systemUsage?.storage.path && (
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        Path: {systemUsage.storage.path}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <Progress
                                                value={storagePercent}
                                                className="h-3"
                                                indicatorClassName={
                                                    storagePercent > 90
                                                        ? 'bg-destructive'
                                                        : storagePercent > 70
                                                            ? 'bg-secondary-foreground'
                                                            : 'bg-primary'
                                                }
                                            />
                                            <div className="flex justify-between text-xs font-medium text-muted-foreground">
                                                <span>0%</span>
                                                <span>{storagePercent.toFixed(1)}% Used</span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {/* Bottom Section: User Usage List */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between border-b border-border/40 pb-4">
                            <div>
                                <CardTitle className="text-lg font-medium flex items-center gap-2">
                                    <Users className="h-5 w-5 text-muted-foreground" />
                                    Top Users Activity
                                </CardTitle>
                                <CardDescription className="mt-1">Messages sent and storage consumed</CardDescription>
                            </div>
                            <Button variant="ghost" size="sm" onClick={() => navigate('/admin/users')}>
                                View All
                            </Button>
                        </CardHeader>
                        <CardContent className="p-0">
                            {usageLoading ? (
                                <div className="p-6 space-y-6">
                                    {[1, 2, 3].map((i) => (
                                        <div key={i} className="flex gap-4 animate-pulse">
                                            <div className="h-10 w-10 rounded-full bg-muted shrink-0"></div>
                                            <div className="flex-1 space-y-2">
                                                <div className="h-4 w-48 rounded bg-muted"></div>
                                                <div className="h-2 w-full rounded bg-muted"></div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : !systemUsage?.users.length ? (
                                <div className="p-8 text-center text-sm text-muted-foreground">
                                    No active users found in the system.
                                </div>
                            ) : (
                                <div className="divide-y divide-border/40">
                                    {systemUsage.users.slice(0, 5).map((u) => {
                                        const msgPercent = (u.messageCount / maxUserMessages) * 100
                                        const bytesPercent = (u.attachmentBytes / maxUserBytes) * 100
                                        const displayName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email
                                        const initial = displayName.charAt(0).toUpperCase()

                                        return (
                                            <div key={u.id} className="flex items-center gap-6 p-4 md:p-6 hover:bg-muted/20 transition-colors">
                                                <div className="hidden sm:flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground font-semibold shrink-0">
                                                    {initial}
                                                </div>
                                                <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                                                    <div className="md:col-span-4">
                                                        <p className="text-sm font-medium text-foreground truncate" title={u.email}>
                                                            {displayName}
                                                        </p>
                                                        <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                                                    </div>
                                                    
                                                    <div className="md:col-span-4 space-y-1.5">
                                                        <div className="flex justify-between text-xs text-muted-foreground">
                                                            <span>Messages</span>
                                                            <span className="font-medium text-foreground">{u.messageCount}</span>
                                                        </div>
                                                        <Progress value={msgPercent} className="h-1.5 bg-muted/50" />
                                                    </div>

                                                    <div className="md:col-span-4 space-y-1.5">
                                                        <div className="flex justify-between text-xs text-muted-foreground">
                                                            <span>Storage</span>
                                                            <span className="font-medium text-foreground">{formatBytes(u.attachmentBytes)}</span>
                                                        </div>
                                                        <Progress value={bytesPercent} className="h-1.5 bg-muted/50" indicatorClassName="bg-secondary-foreground" />
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    )
}
