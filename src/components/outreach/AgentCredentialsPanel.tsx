import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus } from 'lucide-react'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { toast } from '../ui/toaster'
import { ApiClientError, apiFetch } from '../../lib/api-client'

interface AgentCredential {
    id: string
    name: string
    keyPrefix: string
    scopes: string[]
    expiresAt: string | null
    revokedAt: string | null
    lastUsedAt: string | null
    createdAt: string
}

interface CredentialsResponse {
    credentials: AgentCredential[]
    availableScopes: string[]
}

interface CreateCredentialResponse {
    credential: AgentCredential
    token: string
    warning: string
}

// Labels only. The list of scopes that can actually be granted always comes from the
// server's `availableScopes`, so a scope added on the backend shows up here (with its raw
// name) without a frontend change.
const SCOPE_DESCRIPTIONS: Record<string, string> = {
    'outreach:read': 'Read campaigns and stats',
    'prospects:search': 'Discover and search prospects',
    'prospects:enrich': 'Enrich prospect data (spends credits, requires human approval)',
    'prospects:assess': 'Assess and score prospects',
    'prospects:write': 'Import, create and update prospects',
    'campaigns:draft': 'Create draft campaigns',
    'campaigns:request_activation': 'Request activation (a human approves)',
    'campaigns:pause': 'Pause campaigns',
    'approvals:read': 'View pending approvals',
    'events:read': 'Read agent events and audit trail',
}

const MAX_VISIBLE_SCOPES = 4

type CredentialStatus = 'active' | 'revoked' | 'expired'

function credentialStatus(credential: AgentCredential): CredentialStatus {
    if (credential.revokedAt) return 'revoked'
    if (credential.expiresAt && new Date(credential.expiresAt).getTime() <= Date.now()) return 'expired'
    return 'active'
}

const statusBadge: Record<CredentialStatus, { label: string; className: string }> = {
    active: { label: 'Active', className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300' },
    revoked: { label: 'Revoked', className: 'border-border bg-muted/40 text-muted-foreground' },
    expired: { label: 'Expired', className: 'border-amber-400/30 bg-amber-400/10 text-amber-700 dark:text-amber-300' },
}

function formatDate(value: string | null, empty: string) {
    return value ? new Date(value).toLocaleString() : empty
}

function todayInputValue() {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function describeError(error: unknown, fallback: string) {
    if (error instanceof ApiClientError && error.status === 403) return 'Organization admin access required.'
    return error instanceof Error ? error.message : fallback
}

function TokenRevealBox({ token }: { token: string }) {
    function copy() {
        navigator.clipboard.writeText(token).then(
            () => toast({ title: 'Token copied to clipboard', variant: 'success' }),
            () => toast({ title: 'Failed to copy token', variant: 'destructive' })
        )
    }

    return (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">{token}</code>
                <Button variant="outline" size="sm" onClick={copy}>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                Store this now. Xmail keeps only its hash and will not show this token again.
            </p>
        </div>
    )
}

const emptyForm = { name: '', scopes: [] as string[], expiresOn: '' }

export function AgentCredentialsPanel({ organizationId }: { organizationId: string }) {
    const queryClient = useQueryClient()
    const queryKey = ['agent-credentials', organizationId]
    const [createOpen, setCreateOpen] = React.useState(false)
    const [form, setForm] = React.useState(emptyForm)
    const [formError, setFormError] = React.useState<string | null>(null)
    // The one-time token lives only in this component's state while the reveal screen is
    // open, and is dropped when the dialog closes. Never lift it into global state or storage.
    const [revealedToken, setRevealedToken] = React.useState<string | null>(null)
    const [revokeTarget, setRevokeTarget] = React.useState<AgentCredential | null>(null)

    const credentialsQuery = useQuery({
        queryKey,
        queryFn: () => apiFetch<CredentialsResponse>(`/api/outreach/agent-credentials?organizationId=${organizationId}`),
        retry: false,
    })

    const createMutation = useMutation({
        mutationFn: (input: { name: string; scopes: string[]; expiresAt?: string }) =>
            apiFetch<CreateCredentialResponse>(`/api/outreach/agent-credentials?organizationId=${organizationId}`, {
                method: 'POST',
                body: JSON.stringify(input),
            }),
        // The response carries the plaintext token; don't let the mutation cache keep it
        // around after the dialog is gone.
        gcTime: 0,
        onSuccess: (data) => {
            setFormError(null)
            setRevealedToken(data.token)
            void queryClient.invalidateQueries({ queryKey })
        },
        onError: (error) => setFormError(describeError(error, 'Could not create the credential.')),
    })

    const revokeMutation = useMutation({
        mutationFn: (credential: AgentCredential) =>
            apiFetch<{ success: boolean; revokedAt: string }>(
                `/api/outreach/agent-credentials/${credential.id}/revoke?organizationId=${organizationId}`,
                { method: 'POST' },
            ),
        onSuccess: (_data, credential) => {
            toast({ title: `Credential "${credential.name}" revoked`, variant: 'success' })
            setRevokeTarget(null)
            void queryClient.invalidateQueries({ queryKey })
        },
        onError: (error) => toast({
            title: 'Failed to revoke credential',
            description: describeError(error, 'Please try again.'),
            variant: 'destructive',
        }),
    })

    const credentials = credentialsQuery.data?.credentials ?? []
    const availableScopes = credentialsQuery.data?.availableScopes ?? []
    const allSelected = availableScopes.length > 0 && availableScopes.every((scope) => form.scopes.includes(scope))

    function openCreate() {
        setForm(emptyForm)
        setFormError(null)
        setRevealedToken(null)
        createMutation.reset()
        setCreateOpen(true)
    }

    function closeCreate() {
        setCreateOpen(false)
        setRevealedToken(null)
        setForm(emptyForm)
        createMutation.reset()
    }

    function toggleScope(scope: string) {
        setForm((current) => ({
            ...current,
            scopes: current.scopes.includes(scope)
                ? current.scopes.filter((item) => item !== scope)
                : [...current.scopes, scope],
        }))
    }

    function submitCreate() {
        const name = form.name.trim()
        if (!name) return setFormError('Enter a name.')
        if (name.length > 100) return setFormError('Name must be at most 100 characters.')
        if (form.scopes.length === 0) return setFormError('Select at least one scope.')
        // A date-only input means "valid through that day": expire at the end of it, local time.
        const expiresAt = form.expiresOn ? new Date(`${form.expiresOn}T23:59:59.999`).toISOString() : undefined
        setFormError(null)
        createMutation.mutate({ name, scopes: form.scopes, ...(expiresAt ? { expiresAt } : {}) })
    }

    return (
        <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-sm backdrop-blur">
            <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="font-semibold text-foreground">Agent credentials</h2>
                    <p className="text-xs text-muted-foreground">
                        API keys for agents on the <span className="font-mono">/api/agent/outreach</span> gateway. Credit spend and campaign activation still require human approval.
                    </p>
                </div>
                <Button size="sm" onClick={openCreate} disabled={credentialsQuery.isLoading || !!credentialsQuery.error}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    New credential
                </Button>
            </div>

            {credentialsQuery.isLoading ? (
                <div className="p-6 text-sm text-muted-foreground">Loading credentials…</div>
            ) : credentialsQuery.error ? (
                <div role="alert" className="p-6 text-sm text-red-700 dark:text-red-300">
                    {describeError(credentialsQuery.error, 'Could not load credentials.')}
                </div>
            ) : credentials.length === 0 ? (
                <div className="p-10 text-center">
                    <KeyRound className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-3 text-sm text-muted-foreground">
                        No agent credentials yet. Create one to give an agent API access.
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[960px] text-left text-sm">
                        <thead className="bg-muted/35 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                            <tr>
                                <th className="px-5 py-3 font-medium">Name</th>
                                <th className="px-4 py-3 font-medium">Status</th>
                                <th className="px-4 py-3 font-medium">Key</th>
                                <th className="px-4 py-3 font-medium">Scopes</th>
                                <th className="px-4 py-3 font-medium">Created</th>
                                <th className="px-4 py-3 font-medium">Expires</th>
                                <th className="px-4 py-3 font-medium">Last used</th>
                                <th className="px-5 py-3 text-right font-medium">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                            {credentials.map((credential) => {
                                const status = credentialStatus(credential)
                                const visibleScopes = credential.scopes.slice(0, MAX_VISIBLE_SCOPES)
                                const hiddenScopes = credential.scopes.slice(MAX_VISIBLE_SCOPES)
                                return (
                                    <tr key={credential.id} className="hover:bg-muted/25">
                                        <td className="px-5 py-4 font-medium text-foreground">{credential.name}</td>
                                        <td className="px-4 py-4">
                                            <Badge variant="outline" className={statusBadge[status].className}>{statusBadge[status].label}</Badge>
                                        </td>
                                        <td className="px-4 py-4 font-mono text-xs text-muted-foreground">xma_{credential.keyPrefix}…</td>
                                        <td className="px-4 py-4">
                                            <div className="flex max-w-xs flex-wrap gap-1">
                                                {visibleScopes.map((scope) => (
                                                    <span key={scope} title={SCOPE_DESCRIPTIONS[scope]} className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground">{scope}</span>
                                                ))}
                                                {hiddenScopes.length > 0 && (
                                                    <span title={hiddenScopes.join(', ')} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">+{hiddenScopes.length}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-4 text-xs text-muted-foreground">{formatDate(credential.createdAt, '—')}</td>
                                        <td className="whitespace-nowrap px-4 py-4 text-xs text-muted-foreground">{formatDate(credential.expiresAt, '—')}</td>
                                        <td className="whitespace-nowrap px-4 py-4 text-xs text-muted-foreground">{formatDate(credential.lastUsedAt, 'Never')}</td>
                                        <td className="px-5 py-4 text-right">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => setRevokeTarget(credential)}
                                                disabled={status !== 'active' || revokeMutation.isPending}
                                            >
                                                Revoke
                                            </Button>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog open={createOpen} onOpenChange={(open) => { if (!open) closeCreate() }}>
                <DialogContent className="max-w-xl">
                    {revealedToken ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>Token created — shown only once</DialogTitle>
                                <DialogDescription>Send it in the <span className="font-mono">x-agent-key</span> header when calling the agent gateway.</DialogDescription>
                            </DialogHeader>
                            <TokenRevealBox token={revealedToken} />
                            <DialogFooter>
                                <Button onClick={closeCreate}>Done</Button>
                            </DialogFooter>
                        </>
                    ) : (
                        <>
                            <DialogHeader>
                                <DialogTitle>New agent credential</DialogTitle>
                                <DialogDescription>The token is shown only once, right after creation.</DialogDescription>
                            </DialogHeader>
                            <div className="space-y-4">
                                <div>
                                    <Label htmlFor="agentCredentialName">Name</Label>
                                    <Input
                                        id="agentCredentialName"
                                        placeholder="e.g. Kai, n8n-prospecting"
                                        maxLength={100}
                                        value={form.name}
                                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                    />
                                </div>
                                <div>
                                    <div className="flex items-center justify-between">
                                        <Label>Scopes</Label>
                                        <button
                                            type="button"
                                            className="text-xs font-medium text-primary hover:underline"
                                            onClick={() => setForm((current) => ({ ...current, scopes: allSelected ? [] : [...availableScopes] }))}
                                        >
                                            {allSelected ? 'Clear all' : 'Select all'}
                                        </button>
                                    </div>
                                    <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                                        {availableScopes.map((scope) => (
                                            <label key={scope} className="flex cursor-pointer items-start gap-2 text-sm">
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={form.scopes.includes(scope)}
                                                    onCheckedChange={() => toggleScope(scope)}
                                                />
                                                <span>
                                                    <span className="font-mono text-xs text-foreground">{scope}</span>
                                                    {SCOPE_DESCRIPTIONS[scope] && (
                                                        <span className="block text-xs text-muted-foreground">{SCOPE_DESCRIPTIONS[scope]}</span>
                                                    )}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <Label htmlFor="agentCredentialExpires">Expires on (optional)</Label>
                                    <Input
                                        id="agentCredentialExpires"
                                        type="date"
                                        min={todayInputValue()}
                                        value={form.expiresOn}
                                        onChange={(event) => setForm((current) => ({ ...current, expiresOn: event.target.value }))}
                                    />
                                    <p className="mt-1 text-xs text-muted-foreground">Leave empty for no expiry. The key stays valid through the end of the chosen day.</p>
                                </div>
                                {formError && (
                                    <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{formError}</div>
                                )}
                            </div>
                            <DialogFooter>
                                <Button variant="outline" onClick={closeCreate} disabled={createMutation.isPending}>Cancel</Button>
                                <Button onClick={submitCreate} disabled={createMutation.isPending || !form.name.trim() || form.scopes.length === 0}>
                                    {createMutation.isPending ? 'Creating…' : 'Create credential'}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>

            <ConfirmDialog
                open={!!revokeTarget}
                onOpenChange={(open) => { if (!open && !revokeMutation.isPending) setRevokeTarget(null) }}
                title={`Revoke credential "${revokeTarget?.name ?? ''}"?`}
                description="Integrations using this key stop working immediately. This cannot be undone."
                confirmLabel="Revoke"
                variant="danger"
                loading={revokeMutation.isPending}
                onConfirm={() => { if (revokeTarget) revokeMutation.mutate(revokeTarget) }}
            />
        </section>
    )
}
