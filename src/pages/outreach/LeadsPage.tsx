import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
    Plus,
    Search,
    Filter,
    Upload,
    MoreVertical,
    Mail,
    Building,
    Trash2,
    Users,
    UserPlus,
    FileText
} from 'lucide-react'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { PageHeader } from '../../components/ui/page-header'
import { LeadVerificationBadge, type LeadEmailVerificationStatus } from '../../components/outreach/LeadVerificationBadge'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/Dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import { Button } from '../../components/ui/button'
import { ImportLeadsDialog } from './leads/ImportLeadsDialog'
import { AddLeadDialog } from './leads/AddLeadDialog'
import { LeadDetailDialog } from './leads/LeadDetailDialog'
import { apiFetch, apiRequest } from '../../lib/api-client'
import { useOrganization } from '../../hooks/useOrganization'
import { toast } from '../../components/ui/toaster'

// Radix Select items cannot carry an empty-string value, so "no list selected" (which the
// API represents as null/'') is sent as this sentinel and translated back at the boundary.
const NO_LIST_VALUE = '__none__'

interface Lead {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    companyName: string | null
    title: string | null
    phone: string | null
    linkedinUrl: string | null
    status: string
    leadListId: string | null
    leadListName: string | null
    totalEmailsSent: number
    totalOpens: number
    totalClicks: number
    totalReplies: number
    createdAt: string
    emailVerificationStatus: LeadEmailVerificationStatus
    emailVerificationProvider: string | null
    emailVerifiedAt: string | null
}

interface LeadList {
    id: string
    name: string
    leadCount: number
}

interface LeadsResponse {
    leads: Lead[]
    pagination: { page: number; limit: number; total: number; totalPages: number }
}

async function fetchLeads(organizationId: string, params: { status?: string; listId?: string; search?: string; page?: number; limit?: number }): Promise<LeadsResponse> {
    const query = new URLSearchParams({ organizationId })
    if (params.status && params.status !== 'all') query.set('status', params.status)
    if (params.listId && params.listId !== 'all') query.set('leadListId', params.listId)
    if (params.search) query.set('search', params.search)
    if (params.page) query.set('page', String(params.page))
    if (params.limit) query.set('limit', String(params.limit))

    const data = await apiFetch<{ leads?: Lead[]; pagination?: { page: number; limit: number; total: number; totalPages: number } }>(`/api/outreach/leads?${query.toString()}`)
    return {
        leads: data.leads || [],
        pagination: data.pagination || { page: 1, limit: 25, total: 0, totalPages: 0 },
    }
}

async function fetchLeadLists(organizationId: string): Promise<LeadList[]> {
    const data = await apiFetch<{ leadLists?: LeadList[] }>(`/api/outreach/leads/lists?organizationId=${organizationId}`)
    return data.leadLists || []
}

async function deleteLead(organizationId: string, id: string): Promise<void> {
    await apiRequest(`/api/outreach/leads/${id}?organizationId=${organizationId}`, {
        method: 'DELETE',
    })
}

async function bulkDeleteLeads(organizationId: string, leadIds: string[]): Promise<void> {
    await apiRequest(`/api/outreach/leads/bulk-delete?organizationId=${organizationId}`, {
        method: 'POST',
        body: JSON.stringify({ leadIds }),
    })
}

interface CampaignOption {
    id: string
    name: string
    status: string
}

async function fetchEnrollableCampaigns(organizationId: string): Promise<CampaignOption[]> {
    const data = await apiFetch<{ campaigns?: CampaignOption[] }>(`/api/outreach/campaigns?organizationId=${organizationId}&limit=100`)
    return (data.campaigns ?? []).filter((c) => c.status === 'draft' || c.status === 'active')
}

interface EnrollResult {
    added: number
    existing: number
    skipped_invalid: number
}

async function enrollLeadsInCampaign(organizationId: string, campaignId: string, leadIds: string[]): Promise<EnrollResult> {
    return apiFetch<EnrollResult>(`/api/outreach/campaigns/${campaignId}/leads?organizationId=${organizationId}`, {
        method: 'POST',
        body: JSON.stringify({ leadIds }),
    })
}

async function assignLeadsToList(organizationId: string, leadIds: string[], leadListId: string | null): Promise<void> {
    // No bulk "set list" endpoint exists yet — apply sequentially so one failure doesn't hide
    // which lead it failed on, and so partial progress before a failure still lands.
    for (const leadId of leadIds) {
        await apiFetch(`/api/outreach/leads/${leadId}?organizationId=${organizationId}`, {
            method: 'PUT',
            body: JSON.stringify({ leadListId }),
        })
    }
}

const statusColors: Record<string, string> = {
    new: 'bg-primary/10 text-primary',
    contacted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
    replied: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    interested: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400',
    not_interested: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
    bounced: 'bg-muted text-muted-foreground',
    unsubscribed: 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400',
}

function LeadRow({
    lead,
    selected,
    onToggleSelect,
    onDelete,
    onViewDetails,
}: {
    lead: Lead
    selected: boolean
    onToggleSelect: (id: string) => void
    onDelete: (id: string) => void
    onViewDetails: (id: string) => void
}) {
    const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email

    return (
        <tr className="border-b border-border hover:bg-muted/50">
            <td className="py-3 px-4">
                <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelect(lead.id)}
                    aria-label={`Select ${fullName}`}
                    className="rounded border-input"
                />
            </td>
            <td className="py-3 px-4">
                <button
                    type="button"
                    onClick={() => onViewDetails(lead.id)}
                    className="flex items-center gap-3 text-left"
                >
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-medium">
                        {fullName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <p className="font-medium text-foreground hover:underline">{fullName}</p>
                        <div className="flex items-center gap-2">
                            <p className="text-sm text-muted-foreground">{lead.email}</p>
                            <LeadVerificationBadge
                                status={lead.emailVerificationStatus}
                                verifiedAt={lead.emailVerifiedAt}
                                provider={lead.emailVerificationProvider}
                            />
                        </div>
                    </div>
                </button>
            </td>
            <td className="py-3 px-4">
                {lead.companyName && (
                    <div className="flex items-center gap-1 text-muted-foreground">
                        <Building className="w-4 h-4" />
                        <span className="text-sm">{lead.companyName}</span>
                    </div>
                )}
                {lead.title && <p className="text-xs text-muted-foreground">{lead.title}</p>}
            </td>
            <td className="py-3 px-4">
                <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusColors[lead.status] || statusColors.new}`}>
                    {lead.status.replace('_', ' ')}
                </span>
            </td>
            <td className="py-3 px-4 text-sm text-muted-foreground">
                {lead.totalEmailsSent}
            </td>
            <td className="py-3 px-4 text-sm text-muted-foreground">
                {lead.totalOpens}
            </td>
            <td className="py-3 px-4 text-sm text-muted-foreground">
                {lead.totalReplies}
            </td>
            <td className="py-3 px-4">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className="p-1 rounded hover:bg-accent" aria-label={`Actions for ${fullName}`}>
                            <MoreVertical className="w-5 h-5 text-muted-foreground" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => onViewDetails(lead.id)}>
                            <FileText className="w-4 h-4" /> View Details
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => onDelete(lead.id)}
                            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                            <Trash2 className="w-4 h-4" /> Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </td>
        </tr>
    )
}

function AddToCampaignDialog({
    open,
    onOpenChange,
    organizationId,
    leadIds,
    onDone,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    organizationId: string
    leadIds: string[]
    onDone: () => void
}) {
    const [campaignId, setCampaignId] = React.useState('')

    const { data: campaigns = [], isLoading } = useQuery({
        queryKey: ['campaigns', 'enrollable', organizationId],
        queryFn: () => fetchEnrollableCampaigns(organizationId),
        enabled: open,
    })

    React.useEffect(() => {
        if (open) setCampaignId('')
    }, [open])

    const mutation = useMutation({
        mutationFn: () => enrollLeadsInCampaign(organizationId, campaignId, leadIds),
        onSuccess: (result) => {
            toast({
                title: `Added ${result.added} lead${result.added === 1 ? '' : 's'} to campaign`,
                description: result.existing > 0 || result.skipped_invalid > 0
                    ? `${result.existing} already enrolled, ${result.skipped_invalid} skipped (invalid email).`
                    : undefined,
                variant: 'success',
            })
            onDone()
        },
        onError: (err) => {
            toast({ title: 'Failed to add leads to campaign', description: (err as Error).message, variant: 'destructive' })
        },
    })

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Add to campaign</DialogTitle>
                    <DialogDescription>Enroll {leadIds.length} selected lead{leadIds.length === 1 ? '' : 's'} into a draft or active campaign.</DialogDescription>
                </DialogHeader>
                <div className="py-2">
                    <Select value={campaignId} onValueChange={setCampaignId} disabled={isLoading}>
                        <SelectTrigger>
                            <SelectValue placeholder={isLoading ? 'Loading…' : 'Select a campaign'} />
                        </SelectTrigger>
                        <SelectContent>
                            {campaigns.map((c) => (
                                <SelectItem key={c.id} value={c.id}>{c.name} ({c.status})</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {!isLoading && campaigns.length === 0 && (
                        <p className="mt-2 text-xs text-muted-foreground">No draft or active campaigns to enroll into.</p>
                    )}
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" disabled={!campaignId || mutation.isPending} onClick={() => mutation.mutate()}>
                        {mutation.isPending ? 'Adding…' : 'Add leads'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function AddToListDialog({
    open,
    onOpenChange,
    organizationId,
    leadIds,
    leadLists,
    onDone,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    organizationId: string
    leadIds: string[]
    leadLists: LeadList[]
    onDone: () => void
}) {
    const [leadListId, setLeadListId] = React.useState('')

    React.useEffect(() => {
        if (open) setLeadListId('')
    }, [open])

    const mutation = useMutation({
        mutationFn: () => assignLeadsToList(organizationId, leadIds, leadListId || null),
        onSuccess: () => {
            toast({ title: `Moved ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'} to list`, variant: 'success' })
            onDone()
        },
        onError: (err) => {
            toast({ title: 'Failed to add leads to list', description: (err as Error).message, variant: 'destructive' })
        },
    })

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Add to list</DialogTitle>
                    <DialogDescription>Move {leadIds.length} selected lead{leadIds.length === 1 ? '' : 's'} into a lead list.</DialogDescription>
                </DialogHeader>
                <div className="py-2">
                    <Select
                        value={leadListId || NO_LIST_VALUE}
                        onValueChange={(value) => setLeadListId(value === NO_LIST_VALUE ? '' : value)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={NO_LIST_VALUE}>No list (remove from list)</SelectItem>
                            {leadLists.map((list) => (
                                <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                        {mutation.isPending ? 'Saving…' : 'Save'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

export function LeadsPage() {
    const { currentOrganization } = useOrganization()
    const [search, setSearch] = React.useState('')
    const [statusFilter, setStatusFilter] = React.useState('all')
    const [listFilter, setListFilter] = React.useState('all')
    const [selectedLeads, setSelectedLeads] = React.useState<string[]>([])
    const [page, setPage] = React.useState(1)
    const [showImport, setShowImport] = React.useState(false)
    const [showAddLead, setShowAddLead] = React.useState(false)
    const [showAddToCampaign, setShowAddToCampaign] = React.useState(false)
    const [showAddToList, setShowAddToList] = React.useState(false)
    const [confirmBulkDelete, setConfirmBulkDelete] = React.useState(false)
    const [leadToDelete, setLeadToDelete] = React.useState<string | null>(null)
    const [viewLeadId, setViewLeadId] = React.useState<string | null>(null)
    const queryClient = useQueryClient()

    const { data: leadsData, isLoading: leadsLoading } = useQuery({
        queryKey: ['leads', currentOrganization?.id, statusFilter, listFilter, search, page],
        queryFn: () => fetchLeads(currentOrganization!.id, { status: statusFilter, listId: listFilter, search, page, limit: 25 }),
        enabled: !!currentOrganization,
    })

    const { data: leadLists } = useQuery({
        queryKey: ['lead-lists', currentOrganization?.id],
        queryFn: () => fetchLeadLists(currentOrganization!.id),
        enabled: !!currentOrganization,
    })

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteLead(currentOrganization!.id, id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['leads'] })
            toast({ title: 'Lead deleted', variant: 'success' })
            setLeadToDelete(null)
        },
        onError: (err) => {
            toast({ title: 'Failed to delete lead', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const bulkDeleteMutation = useMutation({
        mutationFn: (leadIds: string[]) => bulkDeleteLeads(currentOrganization!.id, leadIds),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['leads'] })
            queryClient.invalidateQueries({ queryKey: ['lead-lists'] })
            toast({ title: `Deleted ${selectedLeads.length} lead${selectedLeads.length === 1 ? '' : 's'}`, variant: 'success' })
            setSelectedLeads([])
            setConfirmBulkDelete(false)
        },
        onError: (err) => {
            toast({ title: 'Failed to delete leads', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const handleDelete = (id: string) => {
        setLeadToDelete(id)
    }

    const toggleSelectLead = (id: string) => {
        setSelectedLeads((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
    }

    const handleSelectAll = () => {
        if (leadsData?.leads) {
            if (selectedLeads.length === leadsData.leads.length) {
                setSelectedLeads([])
            } else {
                setSelectedLeads(leadsData.leads.map(l => l.id))
            }
        }
    }

    const closeBulkDialogs = () => {
        queryClient.invalidateQueries({ queryKey: ['leads'] })
        queryClient.invalidateQueries({ queryKey: ['lead-lists'] })
        setSelectedLeads([])
        setShowAddToCampaign(false)
        setShowAddToList(false)
    }

    return (
        <>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view leads</p>
                </div>
            ) : (
            <div className="space-y-6">
                <PageHeader
                    title="Leads"
                    description="Manage your prospects and lead lists"
                    actions={
                        <>
                            <button
                                onClick={() => setShowImport(true)}
                                className="flex items-center gap-2 px-4 py-2 border border-input text-muted-foreground rounded-lg hover:bg-accent transition-colors"
                            >
                                <Upload className="w-5 h-5" />
                                Import
                            </button>
                            <button
                                onClick={() => setShowAddLead(true)}
                                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                            >
                                <Plus className="w-5 h-5" />
                                Add Lead
                            </button>
                        </>
                    }
                />

                {showImport && (
                    <ImportLeadsDialog
                        organizationId={currentOrganization.id}
                        leadLists={leadLists ?? []}
                        onClose={() => setShowImport(false)}
                    />
                )}
                <AddLeadDialog
                    open={showAddLead}
                    onOpenChange={setShowAddLead}
                    organizationId={currentOrganization.id}
                    leadLists={leadLists ?? []}
                />
                <LeadDetailDialog
                    leadId={viewLeadId}
                    organizationId={currentOrganization.id}
                    onOpenChange={(open) => { if (!open) setViewLeadId(null) }}
                />
                <AddToCampaignDialog
                    open={showAddToCampaign}
                    onOpenChange={setShowAddToCampaign}
                    organizationId={currentOrganization.id}
                    leadIds={selectedLeads}
                    onDone={closeBulkDialogs}
                />
                <AddToListDialog
                    open={showAddToList}
                    onOpenChange={setShowAddToList}
                    organizationId={currentOrganization.id}
                    leadIds={selectedLeads}
                    leadLists={leadLists ?? []}
                    onDone={closeBulkDialogs}
                />
                <ConfirmDialog
                    open={confirmBulkDelete}
                    onOpenChange={setConfirmBulkDelete}
                    title={`Delete ${selectedLeads.length} lead${selectedLeads.length === 1 ? '' : 's'}?`}
                    description="This action cannot be undone."
                    confirmLabel="Delete"
                    variant="danger"
                    loading={bulkDeleteMutation.isPending}
                    onConfirm={() => bulkDeleteMutation.mutate(selectedLeads)}
                />
                <ConfirmDialog
                    open={leadToDelete !== null}
                    onOpenChange={(open) => { if (!open) setLeadToDelete(null) }}
                    title="Delete lead"
                    description="This lead and its outreach history will be permanently deleted. This action cannot be undone."
                    confirmLabel="Delete"
                    variant="danger"
                    loading={deleteMutation.isPending}
                    onConfirm={() => leadToDelete && deleteMutation.mutate(leadToDelete)}
                />

                {/* Stats */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-primary/10 rounded-lg">
                                <Users className="w-5 h-5 text-primary" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Total Leads</p>
                                <p className="text-xl font-semibold text-foreground">
                                    {leadsData?.pagination?.total || 0}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-green-50 dark:bg-green-900/20 rounded-lg">
                                <Mail className="w-5 h-5 text-green-600 dark:text-green-400" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Contacted</p>
                                <p className="text-xl font-semibold text-foreground">
                                    {leadsData?.leads?.filter(l => l.status === 'contacted').length || 0}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
                                <UserPlus className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Interested</p>
                                <p className="text-xl font-semibold text-foreground">
                                    {leadsData?.leads?.filter(l => l.status === 'interested').length || 0}
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="bg-card rounded-lg p-4 border border-border">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                                <FileText className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                            </div>
                            <div>
                                <p className="text-sm text-muted-foreground">Lead Lists</p>
                                <p className="text-xl font-semibold text-foreground">
                                    {leadLists?.length || 0}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row gap-4">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Search leads by name or email..."
                            value={search}
                            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                            className="w-full pl-10 pr-4 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Filter className="w-5 h-5 text-muted-foreground" />
                        <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPage(1) }}>
                            <SelectTrigger className="w-44">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Status</SelectItem>
                                <SelectItem value="new">New</SelectItem>
                                <SelectItem value="contacted">Contacted</SelectItem>
                                <SelectItem value="replied">Replied</SelectItem>
                                <SelectItem value="interested">Interested</SelectItem>
                                <SelectItem value="not_interested">Not Interested</SelectItem>
                                <SelectItem value="bounced">Bounced</SelectItem>
                                <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={listFilter} onValueChange={(value) => { setListFilter(value); setPage(1) }}>
                            <SelectTrigger className="w-44">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Lists</SelectItem>
                                {leadLists?.map(list => (
                                    <SelectItem key={list.id} value={list.id}>{list.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {/* Bulk Actions */}
                {selectedLeads.length > 0 && (
                    <div className="bg-primary/10 rounded-lg p-3 flex items-center justify-between">
                        <span className="text-sm text-primary">
                            {selectedLeads.length} lead(s) selected
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setShowAddToCampaign(true)}
                                className="px-3 py-1 text-sm bg-popover border border-input rounded hover:bg-accent"
                            >
                                Add to Campaign
                            </button>
                            <button
                                onClick={() => setShowAddToList(true)}
                                className="px-3 py-1 text-sm bg-popover border border-input rounded hover:bg-accent"
                            >
                                Add to List
                            </button>
                            <button
                                onClick={() => setConfirmBulkDelete(true)}
                                className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded hover:bg-red-200 dark:hover:bg-red-900/30"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                )}

                {/* Leads Table */}
                <div className="bg-card rounded-lg border border-border overflow-hidden">
                    {leadsLoading ? (
                        <div className="p-4 space-y-3">
                            {[...Array(5)].map((_, i) => (
                                <div key={i} className="animate-pulse flex gap-4">
                                    <div className="h-10 w-10 bg-muted rounded-full"></div>
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 bg-muted rounded w-1/3"></div>
                                        <div className="h-3 bg-muted rounded w-1/4"></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : leadsData?.leads && leadsData.leads.length > 0 ? (
                        <>
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr className="bg-muted/50 border-b border-border">
                                        <th className="py-3 px-4 text-left">
                                            <input
                                                type="checkbox"
                                                checked={selectedLeads.length === leadsData.leads.length}
                                                onChange={handleSelectAll}
                                                aria-label="Select all leads"
                                                className="rounded border-input"
                                            />
                                        </th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground">Lead</th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground">Company</th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground">Status</th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground">Emails</th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground">Opens</th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground">Replies</th>
                                        <th className="py-3 px-4 text-left text-sm font-medium text-muted-foreground"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {leadsData.leads.map((lead) => (
                                        <LeadRow
                                            key={lead.id}
                                            lead={lead}
                                            selected={selectedLeads.includes(lead.id)}
                                            onToggleSelect={toggleSelectLead}
                                            onDelete={handleDelete}
                                            onViewDetails={setViewLeadId}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {leadsData?.pagination && leadsData.pagination.totalPages > 1 && (
                            <PaginationControls
                                page={leadsData.pagination.page}
                                totalPages={leadsData.pagination.totalPages}
                                total={leadsData.pagination.total}
                                itemName="leads"
                                onPageChange={setPage}
                            />
                        )}
                        </>
                    ) : (
                        <div className="p-12 text-center">
                            <Users className="w-16 h-16 text-muted-foreground/50 mx-auto mb-4" />
                            <h3 className="text-lg font-medium text-foreground mb-2">
                                {search || statusFilter !== 'all' || listFilter !== 'all' ? 'No leads found' : 'No leads yet'}
                            </h3>
                            <p className="text-muted-foreground mb-4">
                                {search || statusFilter !== 'all' || listFilter !== 'all'
                                    ? 'Try adjusting your search or filter criteria'
                                    : 'Import or add leads to start your outreach campaigns'
                                }
                            </p>
                            {!search && statusFilter === 'all' && listFilter === 'all' && (
                                <div className="flex items-center justify-center gap-2">
                                    <button
                                        onClick={() => setShowImport(true)}
                                        className="flex items-center gap-2 px-4 py-2 border border-input text-muted-foreground rounded-lg hover:bg-accent transition-colors"
                                    >
                                        <Upload className="w-5 h-5" />
                                        Import Leads
                                    </button>
                                    <button
                                        onClick={() => setShowAddLead(true)}
                                        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                                    >
                                        <Plus className="w-5 h-5" />
                                        Add Lead
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
            )}
        </>
    )
}

export default LeadsPage
