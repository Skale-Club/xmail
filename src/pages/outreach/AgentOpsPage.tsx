import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    Activity,
    ArrowDownToLine,
    Bot,
    Check,
    Clock3,
    Coins,
    RefreshCw,
    Search,
    ShieldCheck,
    Sparkles,
    X,
} from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/button'
import { useOrganization } from '../../hooks/useOrganization'
import { apiFetch } from '../../lib/api-client'

interface ProspectingRun {
    id: string
    provider: string
    status: string
    requestedLimit: number
    discoveredCount: number
    enrichedCount: number
    importedCount: number
    approvedCreditCeiling: number
    consumedCreditEstimate: number
    qualificationThreshold: number
    createdAt: string
}

interface Candidate {
    id: string
    firstName: string | null
    lastName: string | null
    title: string | null
    companyName: string | null
    companyDomain: string | null
    emailStatus: string
    score: number
    scoreTier: string
    status: string
}

interface Assessment {
    id: string
    candidateId: string
    recommendation: string
    confidence: number
    modelName: string
    personalization: Record<string, string>
    createdAt: string
}

interface Approval {
    id: string
    actionKind: 'prospect_enrichment' | 'campaign_activation'
    resourceType: string
    resourceId: string
    status: string
    maximumCreditCost: number
    requestPayload: Record<string, unknown>
    requestedAt: string
    expiresAt: string
}

const tone: Record<string, string> = {
    requested: 'border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300',
    approved: 'border-sky-400/30 bg-sky-400/10 text-sky-700 dark:text-sky-300',
    executing: 'border-violet-400/30 bg-violet-400/10 text-violet-700 dark:text-violet-300',
    executed: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300',
    imported: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300',
    ready: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-700 dark:text-cyan-300',
    failed: 'border-red-400/30 bg-red-400/10 text-red-700 dark:text-red-300',
    rejected: 'border-red-400/30 bg-red-400/10 text-red-700 dark:text-red-300',
}

function StatusBadge({ status }: { status: string }) {
    return <Badge variant="outline" className={tone[status] ?? 'border-border bg-muted/40 text-muted-foreground'}>{status.replace(/_/g, ' ')}</Badge>
}

function formatAge(value: string) {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000))
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export default function AgentOpsPage() {
    const { currentOrganization } = useOrganization()
    const queryClient = useQueryClient()
    const organizationId = currentOrganization?.id
    const isAdmin = currentOrganization?.role === 'admin'
    const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
    const [actionError, setActionError] = React.useState<string | null>(null)

    const runsQuery = useQuery({
        queryKey: ['agent-ops-runs', organizationId],
        queryFn: () => apiFetch<{ runs: ProspectingRun[] }>(`/api/outreach/prospecting/runs?organizationId=${organizationId}&limit=50`),
        enabled: !!organizationId,
        refetchInterval: 15_000,
    })
    const approvalsQuery = useQuery({
        queryKey: ['agent-ops-approvals', organizationId],
        queryFn: () => apiFetch<{ approvals: Approval[] }>(`/api/outreach/approvals?organizationId=${organizationId}&limit=50`),
        enabled: !!organizationId && isAdmin,
        refetchInterval: 10_000,
        retry: false,
    })
    const candidatesQuery = useQuery({
        queryKey: ['agent-ops-candidates', organizationId, selectedRunId],
        queryFn: () => apiFetch<{ candidates: Candidate[]; assessments: Assessment[] }>(
            `/api/outreach/prospecting/runs/${selectedRunId}/candidates?organizationId=${organizationId}&limit=100`,
        ),
        enabled: !!organizationId && !!selectedRunId,
    })

    const reviewMutation = useMutation({
        mutationFn: async ({ approval, decision }: { approval: Approval; decision: 'approve' | 'reject' }) => {
            const path = `/api/outreach/approvals/${approval.id}/${decision}?organizationId=${organizationId}`
            return apiFetch(path, {
                method: 'POST',
                body: JSON.stringify(decision === 'approve'
                    ? { confirm: true, note: 'Approved from Agent Ops' }
                    : { reason: 'Rejected from Agent Ops' }),
            })
        },
        onSuccess: () => {
            setActionError(null)
            queryClient.invalidateQueries({ queryKey: ['agent-ops-approvals', organizationId] })
            queryClient.invalidateQueries({ queryKey: ['agent-ops-runs', organizationId] })
        },
        onError: (error) => setActionError(error instanceof Error ? error.message : 'Could not review this action.'),
    })

    const runs = runsQuery.data?.runs ?? []
    const approvals = approvalsQuery.data?.approvals ?? []
    const requested = approvals.filter((approval) => approval.status === 'requested')
    const candidates = candidatesQuery.data?.candidates ?? []
    const latestAssessment = new Map<string, Assessment>()
    for (const assessment of candidatesQuery.data?.assessments ?? []) {
        if (!latestAssessment.has(assessment.candidateId)) latestAssessment.set(assessment.candidateId, assessment)
    }
    const totalCandidates = runs.reduce((sum, run) => sum + run.discoveredCount, 0)
    const totalCredits = runs.reduce((sum, run) => sum + run.consumedCreditEstimate, 0)
    const queryError = runsQuery.error ?? approvalsQuery.error
    const reviewApproval = (approval: Approval, decision: 'approve' | 'reject') => {
        const action = approval.actionKind === 'prospect_enrichment'
            ? `spend up to ${approval.maximumCreditCost} enrichment credits`
            : 'activate this campaign'
        const prompt = decision === 'approve'
            ? `Confirm that you want to ${action}?`
            : `Reject the request to ${action}?`
        if (window.confirm(prompt)) reviewMutation.mutate({ approval, decision })
    }

    return (
        <OutreachLayout>
            <main className="relative min-h-full overflow-hidden bg-[radial-gradient(circle_at_15%_10%,hsl(var(--primary)/0.09),transparent_28%),radial-gradient(circle_at_90%_0%,hsl(var(--muted-foreground)/0.08),transparent_24%)] p-4 sm:p-6 lg:p-8">
                <div className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:linear-gradient(hsl(var(--foreground))_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground))_1px,transparent_1px)] [background-size:32px_32px]" />
                <div className="relative mx-auto max-w-[1500px] space-y-6">
                    <header className="flex flex-col gap-5 border-b border-border/70 pb-6 lg:flex-row lg:items-end lg:justify-between">
                        <div className="max-w-3xl">
                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                                <Activity className="h-4 w-4" /> Hermes control room
                            </div>
                            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Agent operations</h1>
                            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                                One observable chain from discovery to human approval. Hermes proposes; Xmail owns identity, cost, policy and sending.
                            </p>
                        </div>
                        <Button
                            variant="outline"
                            onClick={() => {
                                void runsQuery.refetch()
                                if (isAdmin) void approvalsQuery.refetch()
                            }}
                            disabled={runsQuery.isFetching || approvalsQuery.isFetching}
                        >
                            <RefreshCw className={`mr-2 h-4 w-4 ${(runsQuery.isFetching || approvalsQuery.isFetching) ? 'animate-spin' : ''}`} />
                            Refresh signal
                        </Button>
                    </header>

                    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Agent operation summary">
                        {[
                            { label: 'Awaiting a human', value: requested.length, icon: ShieldCheck, accent: 'text-amber-600 dark:text-amber-300' },
                            { label: 'Prospecting runs', value: runs.length, icon: Search, accent: 'text-cyan-600 dark:text-cyan-300' },
                            { label: 'Candidates mapped', value: totalCandidates, icon: Sparkles, accent: 'text-violet-600 dark:text-violet-300' },
                            { label: 'Max credits recorded', value: totalCredits, icon: Coins, accent: 'text-emerald-600 dark:text-emerald-300' },
                        ].map((metric) => (
                            <div key={metric.label} className="group rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm backdrop-blur transition-transform hover:-translate-y-0.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{metric.label}</span>
                                    <metric.icon className={`h-4 w-4 ${metric.accent}`} />
                                </div>
                                <p className="mt-3 font-mono text-3xl font-semibold tabular-nums text-foreground">{metric.value}</p>
                            </div>
                        ))}
                    </section>

                    {actionError && (
                        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">{actionError}</div>
                    )}

                    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
                        <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
                            <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
                                <div>
                                    <h2 className="font-semibold text-foreground">Prospecting pipeline</h2>
                                    <p className="text-xs text-muted-foreground">Select a run to inspect candidates and AI evidence.</p>
                                </div>
                                <Bot className="h-5 w-5 text-primary" />
                            </div>
                            {runsQuery.isLoading ? (
                                <div className="p-8 text-sm text-muted-foreground">Loading run telemetry…</div>
                            ) : runs.length === 0 ? (
                                <div className="p-10 text-center"><Search className="mx-auto h-8 w-8 text-muted-foreground" /><p className="mt-3 font-medium">No prospecting runs yet</p><p className="mt-1 text-sm text-muted-foreground">Hermes searches will appear here with scoring and cost state.</p></div>
                            ) : (
                                <div className="divide-y divide-border/60">
                                    {runs.map((run) => (
                                        <button key={run.id} onClick={() => setSelectedRunId(run.id)} className={`grid w-full grid-cols-[1fr_auto] gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/45 ${selectedRunId === run.id ? 'bg-primary/5 shadow-[inset_3px_0_0_hsl(var(--primary))]' : ''}`}>
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span><StatusBadge status={run.status} /><span className="text-xs uppercase tracking-wider text-muted-foreground">{run.provider}</span></div>
                                                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                                                    <span><strong className="font-mono text-foreground">{run.discoveredCount}</strong> discovered</span>
                                                    <span><strong className="font-mono text-foreground">{run.enrichedCount}</strong> enriched</span>
                                                    <span><strong className="font-mono text-foreground">{run.importedCount}</strong> imported</span>
                                                    <span>threshold <strong className="font-mono text-foreground">{run.qualificationThreshold}</strong></span>
                                                </div>
                                            </div>
                                            <span className="whitespace-nowrap text-xs text-muted-foreground">{formatAge(run.createdAt)}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
                            <div className="border-b border-border/70 px-5 py-4">
                                <div className="flex items-center justify-between"><h2 className="font-semibold text-foreground">Human gate</h2><span className="font-mono text-xs text-muted-foreground">{requested.length} pending</span></div>
                                <p className="mt-1 text-xs text-muted-foreground">Cost and activation decisions expire; agents cannot approve themselves.</p>
                            </div>
                            {!isAdmin ? (
                                <div className="p-6 text-sm text-muted-foreground">Organization admin access is required to review agent actions.</div>
                            ) : approvalsQuery.isLoading ? (
                                <div className="p-6 text-sm text-muted-foreground">Loading approval queue…</div>
                            ) : requested.length === 0 ? (
                                <div className="p-8 text-center"><ShieldCheck className="mx-auto h-8 w-8 text-emerald-500" /><p className="mt-3 font-medium">Queue clear</p><p className="mt-1 text-sm text-muted-foreground">No Hermes action is waiting on you.</p></div>
                            ) : (
                                <div className="divide-y divide-border/60">
                                    {requested.map((approval) => (
                                        <article key={approval.id} className="p-5">
                                            <div className="flex items-start justify-between gap-3"><div><StatusBadge status={approval.status} /><h3 className="mt-2 text-sm font-semibold text-foreground">{approval.actionKind === 'prospect_enrichment' ? 'Spend enrichment credits' : 'Activate campaign'}</h3></div><Clock3 className="h-4 w-4 text-muted-foreground" /></div>
                                            <p className="mt-2 text-xs leading-5 text-muted-foreground">Resource <span className="font-mono text-foreground">{approval.resourceId.slice(0, 8)}</span>{approval.maximumCreditCost > 0 ? ` · worst case ${approval.maximumCreditCost} credits` : ''}</p>
                                            <div className="mt-4 grid grid-cols-2 gap-2">
                                                <Button size="sm" onClick={() => reviewApproval(approval, 'approve')} disabled={reviewMutation.isPending}><Check className="mr-1.5 h-4 w-4" />Approve</Button>
                                                <Button size="sm" variant="outline" onClick={() => reviewApproval(approval, 'reject')} disabled={reviewMutation.isPending}><X className="mr-1.5 h-4 w-4" />Reject</Button>
                                            </div>
                                        </article>
                                    ))}
                                </div>
                            )}
                        </section>
                    </div>

                    {selectedRunId && (
                        <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
                            <div className="flex items-center justify-between border-b border-border/70 px-5 py-4"><div><h2 className="font-semibold text-foreground">Candidate evidence</h2><p className="text-xs text-muted-foreground">Deterministic ICP score first; Hermes assessment stays advisory.</p></div><ArrowDownToLine className="h-5 w-5 text-muted-foreground" /></div>
                            {candidatesQuery.isLoading ? <div className="p-6 text-sm text-muted-foreground">Loading candidates…</div> : (
                                <div className="overflow-x-auto">
                                    <table className="w-full min-w-[800px] text-left text-sm">
                                        <thead className="bg-muted/35 text-[11px] uppercase tracking-[0.14em] text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Candidate</th><th className="px-4 py-3 font-medium">Company</th><th className="px-4 py-3 font-medium">ICP</th><th className="px-4 py-3 font-medium">Contact</th><th className="px-4 py-3 font-medium">Hermes evidence</th></tr></thead>
                                        <tbody className="divide-y divide-border/60">
                                            {candidates.map((candidate) => {
                                                const assessment = latestAssessment.get(candidate.id)
                                                return <tr key={candidate.id} className="hover:bg-muted/25"><td className="px-5 py-4"><p className="font-medium text-foreground">{[candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || 'Unnamed candidate'}</p><p className="mt-0.5 text-xs text-muted-foreground">{candidate.title || 'Role unavailable'}</p></td><td className="px-4 py-4"><p className="text-foreground">{candidate.companyName || '—'}</p><p className="mt-0.5 font-mono text-xs text-muted-foreground">{candidate.companyDomain || ''}</p></td><td className="px-4 py-4"><span className="font-mono text-xl font-semibold tabular-nums text-foreground">{candidate.score}</span><span className="ml-1 text-xs uppercase text-muted-foreground">{candidate.scoreTier}</span></td><td className="px-4 py-4"><StatusBadge status={candidate.emailStatus} /></td><td className="px-4 py-4">{assessment ? <div><div className="flex items-center gap-2"><StatusBadge status={assessment.recommendation} /><span className="font-mono text-xs text-muted-foreground">{assessment.confidence}%</span></div><p className="mt-1 max-w-sm truncate text-xs text-muted-foreground">{assessment.personalization.openingLine || assessment.modelName}</p></div> : <span className="text-xs text-muted-foreground">Not assessed</span>}</td></tr>
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>
                    )}

                    {queryError && (
                        <div className="text-xs text-muted-foreground">Some signals are unavailable: {queryError instanceof Error ? queryError.message : 'refresh to retry'}</div>
                    )}
                </div>
            </main>
        </OutreachLayout>
    )
}
