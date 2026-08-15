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
    AlertCircle,
    Upload
} from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { ImportInboxesDialog } from './inboxes/ImportInboxesDialog'
import { apiFetch, apiRequest } from '../../lib/api-client'
import { toast } from '../../components/ui/toaster'
import { useOrganization } from '../../hooks/useOrganization'

interface EmailAccount {
    id: string
    email: string
    displayName: string | null
    status: 'pending' | 'verified' | 'failed' | 'paused'
    provider: string
    mailboxProvider?: string
    smtpHost?: string | null
    dailyLimit: number
    sentToday: number
    warmupEnabled: boolean
    warmupDay: number
    warmupProgress: number
    warmupSource?: 'none' | 'internal' | 'vendor' | 'provider'
    warmupOnly?: boolean
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

function GoogleProviderIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.75 2.98-4.32 2.98-7.42Z" />
            <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.35l-3.24-2.55c-.9.6-2.05.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.63A10 10 0 0 0 12 22Z" />
            <path fill="#FBBC05" d="M6.39 13.93A6.02 6.02 0 0 1 6.07 12c0-.67.12-1.32.32-1.93V7.44H3.04A10 10 0 0 0 2 12c0 1.61.38 3.13 1.04 4.56l3.35-2.63Z" />
            <path fill="#EA4335" d="M12 5.94c1.47 0 2.78.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.96 5.44l3.35 2.63C7.18 7.7 9.39 5.94 12 5.94Z" />
        </svg>
    )
}

function MicrosoftProviderIcon() {
    return (
        <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
            <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
            <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
            <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
        </svg>
    )
}

function providerIdentity(account: EmailAccount): {
    label: string
    icon: React.ReactNode
    containerClass: string
} {
    const smtpHost = account.smtpHost?.toLowerCase() ?? ''
    const isGoogle = smtpHost.includes('gmail.com') || account.mailboxProvider === 'icemail'

    if (isGoogle) {
        return {
            label: 'Google',
            icon: <GoogleProviderIcon />,
            containerClass: 'border-slate-200 bg-white dark:border-white/15 dark:bg-white',
        }
    }

    if (account.provider === 'outlook') {
        return {
            label: 'Microsoft',
            icon: <MicrosoftProviderIcon />,
            containerClass: 'border-slate-200 bg-white dark:border-white/15 dark:bg-white',
        }
    }

    return {
        label: account.provider === 'native' ? 'Xmail' : 'SMTP',
        icon: <Mail className="h-5 w-5 text-primary" />,
        containerClass: 'border-primary/15 bg-primary/10',
    }
}

function InboxCard({ account, onVerify, onDelete }: {
    account: EmailAccount
    onVerify: (id: string) => void
    onDelete: (id: string) => void
}) {
    const [showMenu, setShowMenu] = React.useState(false)
    const status = statusConfig[account.status] || statusConfig.pending
    const identity = providerIdentity(account)
    const dailyUsage = account.dailyLimit > 0
        ? (account.sentToday / account.dailyLimit) * 100
        : 0
    const warmupProgress = Math.min(Math.max(account.warmupProgress, 0), 100)

    return (
        <div className="group w-full rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/30 hover:bg-accent/20">
            <div className="grid gap-5 lg:grid-cols-[minmax(260px,1.55fr)_minmax(190px,1fr)_minmax(190px,1fr)_auto] lg:items-center">
                {/* Account identity */}
                <div className="flex min-w-0 items-center gap-3.5">
                    <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-sm ${identity.containerClass}`}
                        title={`${identity.label} account`}
                        aria-label={`${identity.label} account`}
                    >
                        {identity.icon}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground" title={account.email}>
                            {account.email}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${status.color}`}>
                                {status.icon}
                                {status.label}
                            </span>
                            <span className="text-xs font-medium text-muted-foreground">{identity.label}</span>
                            {account.warmupSource === 'internal' && (
                                <span
                                    className="inline-flex items-center rounded-full bg-orange-500/10 px-2 py-1 text-xs font-medium text-orange-600 dark:text-orange-400"
                                    title={account.warmupOnly
                                        ? 'This inbox only exchanges warm-up mail; it can never send campaigns.'
                                        : 'This inbox exchanges warm-up mail with the internal mesh.'}
                                >
                                    {account.warmupOnly ? 'Warm-up only' : 'Warm-up mesh'}
                                </span>
                            )}
                            {account.displayName && (
                                <span className="truncate text-xs text-muted-foreground">· {account.displayName}</span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Daily usage */}
                <div className="min-w-0">
                    <div className="mb-2 flex items-end justify-between gap-3">
                        <div>
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Daily usage</p>
                            <p className="mt-0.5 text-sm text-foreground">
                                <span className="font-semibold">{account.sentToday}</span>
                                <span className="text-muted-foreground"> of {account.dailyLimit} sent</span>
                            </p>
                        </div>
                        <span className="text-xs font-medium tabular-nums text-muted-foreground">
                            {Math.round(Math.min(dailyUsage, 100))}%
                        </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                            className={`h-full rounded-full transition-[width] duration-500 ${dailyUsage >= 90 ? 'bg-red-500' : dailyUsage >= 70 ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${Math.min(dailyUsage, 100)}%` }}
                        />
                    </div>
                </div>

                {/* Warm-up progress */}
                <div className="min-w-0">
                    {account.warmupEnabled ? (
                        <>
                            <div className="mb-2 flex items-end justify-between gap-3">
                                <div>
                                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Warm-up</p>
                                    <p className="mt-0.5 text-sm text-foreground">
                                        <span className="font-semibold">Day {account.warmupDay}</span>
                                        <span className="text-muted-foreground"> · gradual ramp</span>
                                    </p>
                                </div>
                                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                                    {Math.round(warmupProgress)}%
                                </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                                <div
                                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                                    style={{ width: `${warmupProgress}%` }}
                                />
                            </div>
                        </>
                    ) : (
                        <div className="rounded-lg border border-dashed border-border px-3 py-2.5">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Warm-up</p>
                            <p className="mt-0.5 text-sm text-muted-foreground">Disabled</p>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="relative flex justify-end border-t border-border pt-3 lg:border-0 lg:pt-0">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={`Actions for ${account.email}`}
                        aria-expanded={showMenu}
                    >
                        <MoreVertical className="h-5 w-5" />
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
        </div>
    )
}

export function InboxesPage() {
    const { currentOrganization } = useOrganization()
    const [page, setPage] = React.useState(1)
    const [showImport, setShowImport] = React.useState(false)
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
                    <div className="flex items-center gap-2">
                        {/* Bulk import is the path that matters when mailboxes are bought a batch at
                            a time from a vendor; adding them one by one does not scale past a few. */}
                        <button
                            onClick={() => setShowImport(true)}
                            className="flex items-center gap-2 px-4 py-2 border border-border text-foreground rounded-lg hover:bg-muted transition-colors"
                        >
                            <Upload className="w-5 h-5" />
                            Import Inboxes
                        </button>
                        <Link
                            href="/outreach/inboxes/new"
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-5 h-5" />
                            Add Inbox
                        </Link>
                    </div>
                </div>

                {showImport && currentOrganization && (
                    <ImportInboxesDialog
                        organizationId={currentOrganization.id}
                        onClose={() => setShowImport(false)}
                    />
                )}

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
                    <div className="space-y-3">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className="w-full animate-pulse rounded-xl border border-border bg-card px-5 py-4">
                                <div className="grid gap-5 lg:grid-cols-[minmax(260px,1.55fr)_minmax(190px,1fr)_minmax(190px,1fr)_auto] lg:items-center">
                                    <div className="flex items-center gap-3.5">
                                        <div className="h-11 w-11 rounded-xl bg-muted" />
                                        <div className="min-w-0 flex-1">
                                            <div className="mb-2 h-4 w-2/3 rounded bg-muted" />
                                            <div className="h-3 w-1/2 rounded bg-muted" />
                                        </div>
                                    </div>
                                    <div className="h-8 rounded bg-muted" />
                                    <div className="h-8 rounded bg-muted" />
                                    <div className="h-8 w-8 justify-self-end rounded-lg bg-muted" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : accountsData?.accounts && accountsData.accounts.length > 0 ? (
                    <>
                    <div className="space-y-3">
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
