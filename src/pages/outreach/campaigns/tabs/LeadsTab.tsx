import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X, Mail, AlertCircle } from 'lucide-react'
import { PaginationControls } from '../../../../components/ui/PaginationControls'
import { apiFetch, apiRequest } from '../../../../lib/api-client'
import { toast } from '../../../../components/ui/toaster'

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface CampaignLead {
    id: string
    leadId: string
    status: 'new' | 'contacted' | 'replied' | 'interested' | 'not_interested' | 'bounced' | 'unsubscribed'
    lastEmailSentAt: string | null
    updatedAt: string
    createdAt: string
    lead: {
        id: string
        email: string
        firstName: string | null
        lastName: string | null
        companyName: string | null
    }
}

interface CampaignLeadsResponse {
    campaignLeads: CampaignLead[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
}

interface BulkImportResponse {
    imported: number
    duplicates: number
    leadIds: string[]
}

interface EnrollResponse {
    added: number
    existing: number
}

interface LeadList {
    id: string
    name: string
    leadCount?: number
}

interface LeadListsResponse {
    leadLists: LeadList[]
}

interface Inbox {
    id: string
    email: string
    displayName?: string | null
    status: 'pending' | 'verified' | 'failed' | 'paused'
}

interface InboxesResponse {
    emailAccounts: Inbox[]
}

interface LeadsTabProps {
    campaignId: string
    organizationId: string
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 25

// Distinct palette from CampaignsPage's campaign-status colours — these are
// per-lead-in-campaign statuses, not campaign-level statuses.
const leadStatusColors: Record<CampaignLead['status'], string> = {
    new: 'bg-muted text-muted-foreground',
    contacted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    replied: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    interested: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    not_interested: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    bounced: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    unsubscribed: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

function LeadsTab({ campaignId, organizationId }: LeadsTabProps) {
    const [page, setPage] = React.useState(1)
    const [showAddModal, setShowAddModal] = React.useState(false)
    const [mode, setMode] = React.useState<'paste' | 'list'>('paste')
    const [pastedEmails, setPastedEmails] = React.useState('')
    const [selectedListId, setSelectedListId] = React.useState<string>('')
    const [selectedInboxId, setSelectedInboxId] = React.useState<string>('')
    const [isSubmitting, setIsSubmitting] = React.useState(false)
    const queryClient = useQueryClient()

    // Verified sending inboxes — required to enroll leads, since every campaign lead must
    // carry an assigned inbox for the campaign to be activatable (see campaigns.ts
    // validateCampaignReadyForActivation). Without this the UI enrolled leads with a NULL
    // inbox and the campaign could never be started (audit C2).
    const { data: inboxesData } = useQuery({
        queryKey: ['email-accounts', organizationId],
        queryFn: () =>
            apiFetch<InboxesResponse>(
                `/api/outreach/email-accounts?organizationId=${organizationId}&limit=100`
            ),
        enabled: showAddModal && !!organizationId,
    })
    const verifiedInboxes = React.useMemo(
        () => (inboxesData?.emailAccounts ?? []).filter((a) => a.status === 'verified'),
        [inboxesData]
    )

    // Main paginated table data
    const { data, isLoading } = useQuery({
        queryKey: ['campaign-leads', organizationId, campaignId, page],
        queryFn: () =>
            apiFetch<CampaignLeadsResponse>(
                `/api/outreach/campaigns/${campaignId}/leads?organizationId=${organizationId}&page=${page}&limit=${PAGE_SIZE}`
            ),
        enabled: !!campaignId && !!organizationId,
    })

    // Lead lists — only fetched when modal is open in "list" mode
    const { data: listsData } = useQuery({
        queryKey: ['lead-lists', organizationId],
        queryFn: () =>
            apiFetch<LeadListsResponse>(
                `/api/outreach/leads/lists?organizationId=${organizationId}&limit=100`
            ),
        enabled: showAddModal && mode === 'list' && !!organizationId,
    })

    // ───────────────────────────────────────────────────────────────────────
    // Enrollment goes entirely through server contracts — no client-side lead
    // scanning:
    //   * Paste mode → POST /leads/bulk-import resolves every email to a lead id
    //     (creating new leads, reusing existing) and returns the full leadIds set.
    //   * List mode  → POST /campaigns/:id/leads with { leadListId } enrolls the
    //     whole list server-side (the leads are resolved on the server).
    // The old GET ?limit=1000 scans and per-email create/duplicate probing are gone
    // (and would now be rejected: the lead list contract caps limit at 100).
    // ───────────────────────────────────────────────────────────────────────

    const handleSubmit = async () => {
        if (!selectedInboxId) {
            toast({
                title: 'Select a sending inbox',
                description: 'Every lead needs an assigned inbox so the campaign can be activated.',
                variant: 'destructive',
            })
            return
        }
        setIsSubmitting(true)
        try {
            let enrollBody: Record<string, unknown>

            if (mode === 'paste') {
                const emails = Array.from(
                    new Set(
                        pastedEmails
                            .split(/[\n,;]+/)
                            .map((s) => s.trim().toLowerCase())
                            .filter((s) => EMAIL_REGEX.test(s))
                    )
                )
                if (emails.length === 0) {
                    toast({
                        title: 'No valid emails found',
                        description: 'Paste one email per line (or comma-separated).',
                        variant: 'destructive',
                    })
                    return
                }
                const importRes = await apiRequest(
                    `/api/outreach/leads/bulk-import?organizationId=${organizationId}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ leads: emails.map((email) => ({ email })) }),
                    }
                )
                const imported = (await importRes.json()) as BulkImportResponse
                const leadIds = imported.leadIds ?? []
                if (leadIds.length === 0) {
                    toast({ title: 'No leads resolved', description: 'Nothing to add.', variant: 'destructive' })
                    return
                }
                enrollBody = { leadIds, emailAccountId: selectedInboxId }
            } else {
                if (!selectedListId) {
                    toast({ title: 'Select a lead list', variant: 'destructive' })
                    return
                }
                enrollBody = { leadListId: selectedListId, emailAccountId: selectedInboxId }
            }

            const res = await apiRequest(
                `/api/outreach/campaigns/${campaignId}/leads`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(enrollBody),
                }
            )
            const result = (await res.json()) as EnrollResponse

            toast({
                title: `Added ${result.added} lead${result.added === 1 ? '' : 's'}`,
                description: result.existing > 0 ? `${result.existing} already in campaign (skipped)` : undefined,
                variant: 'success',
            })

            queryClient.invalidateQueries({ queryKey: ['campaign-leads', organizationId, campaignId] })
            queryClient.invalidateQueries({ queryKey: ['campaign', organizationId, campaignId] })

            setShowAddModal(false)
            setPastedEmails('')
            setSelectedListId('')
            setSelectedInboxId('')
            setMode('paste')
            setPage(1)
        } catch (err) {
            toast({
                title: 'Failed to add leads',
                description: err instanceof Error ? err.message : 'Unexpected error',
                variant: 'destructive',
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    const closeModal = () => {
        if (isSubmitting) return
        setShowAddModal(false)
        setPastedEmails('')
        setSelectedListId('')
        setSelectedInboxId('')
        setMode('paste')
    }

    // ───────────────────────────────────────────────────────────────────────
    // Render
    // ───────────────────────────────────────────────────────────────────────

    const total = data?.pagination?.total ?? 0
    const rows = data?.campaignLeads ?? []

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">
                    Leads ({total})
                </h2>
                <button
                    onClick={() => setShowAddModal(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
                >
                    <Plus className="w-4 h-4" /> Add Leads
                </button>
            </div>

            {/* Loading */}
            {isLoading && (
                <div className="space-y-2">
                    {[...Array(5)].map((_, i) => (
                        <div key={i} className="h-12 bg-muted animate-pulse rounded" />
                    ))}
                </div>
            )}

            {/* Empty state */}
            {!isLoading && rows.length === 0 && (
                <div className="bg-card border border-border rounded-lg p-12 text-center">
                    <Mail className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
                    <p className="text-muted-foreground mb-4">No leads in this campaign yet</p>
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
                    >
                        <Plus className="w-4 h-4" /> Add your first leads
                    </button>
                </div>
            )}

            {/* Table */}
            {!isLoading && rows.length > 0 && (
                <div className="bg-card border border-border rounded-lg overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-muted/50">
                                <tr>
                                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Email</th>
                                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
                                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Company</th>
                                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Activity</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((cl) => {
                                    const fullName = [cl.lead.firstName, cl.lead.lastName]
                                        .filter(Boolean)
                                        .join(' ')
                                    return (
                                        <tr key={cl.id} className="border-t border-border hover:bg-muted/30">
                                            <td className="px-4 py-3 text-sm text-foreground">{cl.lead.email}</td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{fullName || '—'}</td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">{cl.lead.companyName ?? '—'}</td>
                                            <td className="px-4 py-3">
                                                <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${leadStatusColors[cl.status]}`}>
                                                    {cl.status.replace('_', ' ')}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground">
                                                {cl.lastEmailSentAt
                                                    ? new Date(cl.lastEmailSentAt).toLocaleDateString()
                                                    : '—'}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Pagination */}
            {data?.pagination && data.pagination.totalPages > 1 && (
                <PaginationControls
                    page={data.pagination.page}
                    totalPages={data.pagination.totalPages}
                    total={data.pagination.total}
                    itemName="leads"
                    onPageChange={setPage}
                />
            )}

            {/* Add Leads Modal */}
            {showAddModal && (
                <div
                    className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
                    onClick={closeModal}
                >
                    <div
                        className="bg-card rounded-lg max-w-lg w-full p-6 border border-border shadow-lg"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold text-foreground">Add Leads</h3>
                            <button
                                onClick={closeModal}
                                disabled={isSubmitting}
                                className="p-1 rounded hover:bg-accent disabled:opacity-50"
                                aria-label="Close"
                            >
                                <X className="w-5 h-5 text-muted-foreground" />
                            </button>
                        </div>

                        {/* Sending inbox — required so enrolled leads can be activated */}
                        <div className="space-y-2 mb-4">
                            <label className="block text-sm font-medium text-foreground">
                                Sending inbox
                            </label>
                            <select
                                value={selectedInboxId}
                                onChange={(e) => setSelectedInboxId(e.target.value)}
                                disabled={isSubmitting}
                                className="w-full border border-input rounded-lg p-2 bg-background text-foreground text-sm focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
                            >
                                <option value="">Select an inbox…</option>
                                {verifiedInboxes.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                                    </option>
                                ))}
                            </select>
                            {inboxesData && verifiedInboxes.length === 0 && (
                                <p className="text-xs text-muted-foreground flex items-start gap-1">
                                    <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    No verified inboxes yet. Add and verify one on the Inboxes page first.
                                </p>
                            )}
                        </div>

                        {/* Mode toggle */}
                        <div className="flex gap-2 mb-4">
                            <button
                                onClick={() => setMode('paste')}
                                disabled={isSubmitting}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    mode === 'paste'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-muted/70'
                                }`}
                            >
                                Paste Emails
                            </button>
                            <button
                                onClick={() => setMode('list')}
                                disabled={isSubmitting}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                    mode === 'list'
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-muted/70'
                                }`}
                            >
                                From Lead List
                            </button>
                        </div>

                        {/* Paste mode */}
                        {mode === 'paste' && (
                            <div className="space-y-2">
                                <label className="block text-sm font-medium text-foreground">
                                    Email addresses
                                </label>
                                <textarea
                                    value={pastedEmails}
                                    onChange={(e) => setPastedEmails(e.target.value)}
                                    rows={6}
                                    placeholder={'alice@example.com\nbob@example.com'}
                                    disabled={isSubmitting}
                                    className="w-full border border-input rounded-lg p-2 bg-background text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
                                />
                                <p className="text-xs text-muted-foreground flex items-start gap-1">
                                    <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                    One per line or comma-separated. New emails will be created as leads; existing ones will be reused.
                                </p>
                            </div>
                        )}

                        {/* List mode */}
                        {mode === 'list' && (
                            <div className="space-y-2">
                                <label className="block text-sm font-medium text-foreground">
                                    Choose a lead list
                                </label>
                                <select
                                    value={selectedListId}
                                    onChange={(e) => setSelectedListId(e.target.value)}
                                    disabled={isSubmitting}
                                    className="w-full border border-input rounded-lg p-2 bg-background text-foreground text-sm focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
                                >
                                    <option value="">Select a list…</option>
                                    {(listsData?.leadLists ?? []).map((l) => (
                                        <option key={l.id} value={l.id}>
                                            {l.name}
                                            {l.leadCount != null ? ` (${l.leadCount} lead${l.leadCount === 1 ? '' : 's'})` : ''}
                                        </option>
                                    ))}
                                </select>
                                {listsData && listsData.leadLists.length === 0 && (
                                    <p className="text-xs text-muted-foreground flex items-start gap-1">
                                        <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                        No lead lists yet. Create one from the Leads page, or use Paste Emails.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Footer */}
                        <div className="flex justify-end gap-2 mt-6">
                            <button
                                onClick={closeModal}
                                disabled={isSubmitting}
                                className="px-4 py-2 rounded-lg border border-border bg-background hover:bg-accent text-sm text-foreground disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSubmit}
                                disabled={isSubmitting}
                                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium disabled:opacity-50"
                            >
                                {isSubmitting ? 'Adding…' : 'Add'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default LeadsTab
