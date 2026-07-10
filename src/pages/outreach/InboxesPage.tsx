import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'wouter'
import {
    Plus,
    Mail,
    CheckCircle,
    XCircle,
    Clock,
    MoreVertical,
    RefreshCw,
    Trash2,
    Settings,
    Send,
    Inbox,
    AlertCircle
} from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { apiFetch, apiRequest } from '../../lib/api-client'
import { toast } from '../../components/ui/toaster'
import { useOrganization } from '../../hooks/useOrganization'

interface EmailAccount {
    id: string
    email: string
    displayName: string | null
    status: 'pending' | 'verified' | 'failed' | 'paused'
    provider: string
    dailyLimit: number
    sentToday: number
    warmupEnabled: boolean
    warmupDay: number
    warmupProgress: number
    lastSyncAt: string | null
    createdAt: string
}

interface EmailAccountsResponse {
    accounts: EmailAccount[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
}

async function fetchEmailAccounts(organizationId: string, page = 1, limit = 25): Promise<EmailAccountsResponse> {
    const data = await apiFetch<{ emailAccounts?: EmailAccount[]; pagination?: { page: number; limit: number; total: number; totalPages: number } }>(
        `/api/outreach/email-accounts?organizationId=${organizationId}&page=${page}&limit=${limit}`
    )
    return {
        accounts: data.emailAccounts || [],
        pagination: data.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 },
    }
}

async function verifyEmailAccount(organizationId: string, id: string): Promise<void> {
    await apiRequest(`/api/outreach/email-accounts/${id}/verify?organizationId=${organizationId}`, {
        method: 'POST',
    })
}

async function deleteEmailAccount(organizationId: string, id: string): Promise<void> {
    await apiRequest(`/api/outreach/email-accounts/${id}?organizationId=${organizationId}`, {
        method: 'DELETE',
    })
}

const statusConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    verified: {
        color: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
        icon: <CheckCircle className="w-4 h-4" />,
        label: 'Verified'
    },
    pending: {
        color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
        icon: <Clock className="w-4 h-4" />,
        label: 'Pending'
    },
    failed: {
        color: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
        icon: <XCircle className="w-4 h-4" />,
        label: 'Failed'
    },
    paused: {
        color: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
        icon: <AlertCircle className="w-4 h-4" />,
        label: 'Paused'
    },
}

function InboxCard({ account, onVerify, onDelete }: {
    account: EmailAccount
    onVerify: (id: string) => void
    onDelete: (id: string) => void
}) {
    const [showMenu, setShowMenu] = React.useState(false)
    const status = statusConfig[account.status] || statusConfig.pending
    const dailyUsage = (account.sentToday / account.dailyLimit) * 100

    return (
        <div className="bg-card rounded-lg border border-border p-4">
            <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Mail className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                        <p className="font-medium text-foreground">{account.email}</p>
                        {account.displayName && (
                            <p className="text-sm text-muted-foreground">{account.displayName}</p>
                        )}
                    </div>
                </div>
                <div className="relative">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="p-1 rounded hover:bg-accent"
                    >
                        <MoreVertical className="w-5 h-5 text-gray-400" />
                    </button>
                    {showMenu && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                            <div className="absolute right-0 top-8 z-20 w-44 bg-popover rounded-lg shadow-lg border border-border py-1">
                                <Link
                                    href={`/outreach/inboxes/${account.id}`}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                    onClick={() => setShowMenu(false)}
                                >
                                    <Settings className="w-4 h-4" /> Settings
                                </Link>
                                {(account.status === 'pending' || account.status === 'failed') && (
                                    <button
                                        onClick={() => { onVerify(account.id); setShowMenu(false) }}
                                        className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                    >
                                        <RefreshCw className="w-4 h-4" /> {account.status === 'failed' ? 'Retry verification' : 'Verify'}
                                    </button>
                                )}
                                <button
                                    onClick={() => { onDelete(account.id); setShowMenu(false) }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-500 hover:text-red-600 dark:hover:text-red-400 flex items-center gap-2 transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" /> Delete
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2 mb-3">
                <span className={`px-2 py-1 text-xs font-medium rounded-full flex items-center gap-1 ${status.color}`}>
                    {status.icon}
                    {status.label}
                </span>
                <span className="text-xs text-muted-foreground capitalize">{account.provider}</span>
            </div>

            {/* Daily Usage */}
            <div className="mb-3">
                <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-muted-foreground">Daily Usage</span>
                    <span className="text-foreground font-medium">
                        {account.sentToday} / {account.dailyLimit}
                    </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2">
                    <div
                        className={`h-2 rounded-full ${dailyUsage >= 90 ? 'bg-red-500' : dailyUsage >= 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                        style={{ width: `${Math.min(dailyUsage, 100)}%` }}
                    />
                </div>
            </div>

            {/* Warmup Progress */}
            {account.warmupEnabled && (
                <div className="mb-3">
                    <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-muted-foreground">Warmup Progress</span>
                        <span className="text-foreground font-medium">
                            Day {account.warmupDay}
                        </span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                        <div
                            className="h-2 rounded-full bg-primary"
                            style={{ width: `${account.warmupProgress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 gap-2 pt-3 border-t border-border">
                <div className="text-center">
                    <p className="text-lg font-semibold text-foreground">{account.sentToday}</p>
                    <p className="text-xs text-muted-foreground">Sent Today</p>
                </div>
                <div className="text-center">
                    <p className="text-lg font-semibold text-foreground">{account.dailyLimit}</p>
                    <p className="text-xs text-muted-foreground">Daily Limit</p>
                </div>
            </div>
        </div>
    )
}

export function InboxesPage() {
    const { currentOrganization } = useOrganization()
    const [page, setPage] = React.useState(1)
    const queryClient = useQueryClient()

    const { data: accountsData, isLoading } = useQuery({
        queryKey: ['email-accounts', currentOrganization?.id, page],
        queryFn: () => fetchEmailAccounts(currentOrganization!.id, page, 25),
        enabled: !!currentOrganization,
    })

    const verifyMutation = useMutation({
        mutationFn: (id: string) => verifyEmailAccount(currentOrganization!.id, id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['email-accounts'] })
            toast({ title: 'Inbox verified', variant: 'success' })
        },
        onError: (err) => {
            // A failed verification sets the account to 'failed' server-side, so refetch to
            // reflect the new status (and expose the retry affordance for failed accounts).
            queryClient.invalidateQueries({ queryKey: ['email-accounts'] })
            toast({ title: 'Verification failed', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteEmailAccount(currentOrganization!.id, id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['email-accounts'] })
            toast({ title: 'Inbox deleted', variant: 'success' })
        },
        onError: (err) => {
            toast({ title: 'Failed to delete inbox', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const handleVerify = (id: string) => {
        verifyMutation.mutate(id)
    }

    const handleDelete = (id: string) => {
        if (confirm('Are you sure you want to delete this inbox?')) {
            deleteMutation.mutate(id)
        }
    }

    const totalAccounts = accountsData?.pagination?.total || 0
    const verifiedAccounts = accountsData?.accounts?.filter(a => a.status === 'verified').length || 0
    const totalSentToday = accountsData?.accounts?.reduce((sum, a) => sum + a.sentToday, 0) || 0
    const totalDailyLimit = accountsData?.accounts?.reduce((sum, a) => sum + a.dailyLimit, 0) || 0

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view inboxes</p>
                </div>
            ) : (
            <div className="space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Inboxes</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage your email accounts for cold outreach
                        </p>
                    </div>
                    <Link
                        href="/outreach/inboxes/new"
                        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                    >
                        <Plus className="w-5 h-5" />
                        Add Inbox
                    </Link>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-primary/10 rounded-lg">
                                <Inbox className="w-5 h-5 text-primary" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Total Inboxes</p>
                                <p className="text-xl font-semibold text-foreground">{totalAccounts}</p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
                                <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Verified</p>
                                <p className="text-xl font-semibold text-foreground">{verifiedAccounts}</p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                                <Send className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Sent Today</p>
                                <p className="text-xl font-semibold text-foreground">{totalSentToday}</p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-orange-50 dark:bg-orange-900/20 rounded-lg">
                                <Mail className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Daily Limit</p>
                                <p className="text-xl font-semibold text-foreground">{totalDailyLimit}</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Inbox List */}
                {isLoading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className="bg-card rounded-lg border border-border p-4 animate-pulse">
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-10 h-10 bg-muted rounded-full"></div>
                                    <div className="flex-1">
                                        <div className="h-4 bg-muted rounded w-2/3 mb-1"></div>
                                        <div className="h-3 bg-muted rounded w-1/2"></div>
                                    </div>
                                </div>
                                <div className="h-2 bg-muted rounded mb-3"></div>
                                <div className="h-2 bg-muted rounded w-3/4"></div>
                            </div>
                        ))}
                    </div>
                ) : accountsData?.accounts && accountsData.accounts.length > 0 ? (
                    <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {accountsData.accounts.map((account) => (
                            <InboxCard
                                key={account.id}
                                account={account}
                                onVerify={handleVerify}
                                onDelete={handleDelete}
                            />
                        ))}
                    </div>
                    {accountsData?.pagination && accountsData.pagination.totalPages > 1 && (
                        <PaginationControls
                            page={accountsData.pagination.page}
                            totalPages={accountsData.pagination.totalPages}
                            total={accountsData.pagination.total}
                            itemName="inboxes"
                            onPageChange={setPage}
                        />
                    )}
                    </>
                ) : (
                    <div className="bg-card rounded-lg border border-border p-12 text-center">
                        <Mail className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
                        <h3 className="text-lg font-medium text-foreground mb-2">
                            No inboxes connected
                        </h3>
                        <p className="text-muted-foreground mb-4 max-w-md mx-auto">
                            Connect your email accounts to start sending cold emails. You can add Gmail, Outlook,
                            or custom SMTP accounts.
                        </p>
                        <Link
                            href="/outreach/inboxes/new"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-5 h-5" />
                            Add Your First Inbox
                        </Link>
                    </div>
                )}

                {/* Help Section */}
                <div className="bg-primary/10 rounded-lg p-4">
                    <h3 className="font-medium text-primary mb-2">
                        💡 Tips for Better Deliverability
                    </h3>
                    <ul className="text-sm text-primary space-y-1">
                        <li>• Enable warmup for new email accounts to build sender reputation</li>
                        <li>• Keep daily sending limits reasonable (50-100 emails per day per account)</li>
                        <li>• Use multiple inboxes to distribute sending load</li>
                        <li>• Verify your domain and set up SPF, DKIM, and DMARC records</li>
                    </ul>
                </div>
            </div>
            )}
        </OutreachLayout>
    )
}

export default InboxesPage
