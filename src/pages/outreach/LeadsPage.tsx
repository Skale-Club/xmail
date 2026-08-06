import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'wouter'
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
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { PaginationControls } from '../../components/ui/PaginationControls'
import { LeadVerificationBadge, type LeadEmailVerificationStatus } from '../../components/outreach/LeadVerificationBadge'
import { apiFetch, apiRequest } from '../../lib/api-client'
import { useOrganization } from '../../hooks/useOrganization'
import { toast } from '../../components/ui/toaster'

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

const statusColors: Record<string, string> = {
    new: 'bg-primary/10 text-primary',
    contacted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
    replied: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    interested: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400',
    not_interested: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
    bounced: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
    unsubscribed: 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400',
}

function LeadRow({ lead, onDelete }: { lead: Lead; onDelete: (id: string) => void }) {
    const [showMenu, setShowMenu] = React.useState(false)
    const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email

    return (
        <tr className="border-b border-border hover:bg-muted/50">
            <td className="py-3 px-4">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-medium">
                        {fullName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <p className="font-medium text-foreground">{fullName}</p>
                        <div className="flex items-center gap-2">
                            <p className="text-sm text-muted-foreground">{lead.email}</p>
                            <LeadVerificationBadge
                                status={lead.emailVerificationStatus}
                                verifiedAt={lead.emailVerifiedAt}
                                provider={lead.emailVerificationProvider}
                            />
                        </div>
                    </div>
                </div>
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
                <div className="relative">
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="p-1 rounded hover:bg-accent"
                    >
                        <MoreVertical className="w-5 h-5 text-muted-foreground" />
                    </button>
                    {showMenu && (
                        <>
                            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                            <div className="absolute right-0 top-8 z-20 w-40 bg-popover rounded-lg shadow-lg border border-border py-1">
                                <Link
                                    href={`/outreach/leads/${lead.id}`}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                                    onClick={() => setShowMenu(false)}
                                >
                                    <FileText className="w-4 h-4" /> View Details
                                </Link>
                                <button
                                    onClick={() => { onDelete(lead.id); setShowMenu(false) }}
                                    className="w-full px-4 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-500 hover:text-red-600 dark:hover:text-red-400 flex items-center gap-2 transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" /> Delete
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </td>
        </tr>
    )
}

export function LeadsPage() {
    const { currentOrganization } = useOrganization()
    const [search, setSearch] = React.useState('')
    const [statusFilter, setStatusFilter] = React.useState('all')
    const [listFilter, setListFilter] = React.useState('all')
    const [selectedLeads, setSelectedLeads] = React.useState<string[]>([])
    const [page, setPage] = React.useState(1)
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
        },
        onError: (err) => {
            toast({ title: 'Failed to delete lead', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const handleDelete = (id: string) => {
        if (confirm('Are you sure you want to delete this lead?')) {
            deleteMutation.mutate(id)
        }
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

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view leads</p>
                </div>
            ) : (
            <div className="space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Leads</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage your prospects and lead lists
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link
                            href="/outreach/leads/import"
                            className="flex items-center gap-2 px-4 py-2 border border-input text-muted-foreground rounded-lg hover:bg-accent transition-colors"
                        >
                            <Upload className="w-5 h-5" />
                            Import
                        </Link>
                        <Link
                            href="/outreach/leads/new"
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                        >
                            <Plus className="w-5 h-5" />
                            Add Lead
                        </Link>
                    </div>
                </div>

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
                        <select
                            value={statusFilter}
                            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
                            className="px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary"
                        >
                            <option value="all">All Status</option>
                            <option value="new">New</option>
                            <option value="contacted">Contacted</option>
                            <option value="replied">Replied</option>
                            <option value="interested">Interested</option>
                            <option value="not_interested">Not Interested</option>
                            <option value="bounced">Bounced</option>
                            <option value="unsubscribed">Unsubscribed</option>
                        </select>
                        <select
                            value={listFilter}
                            onChange={(e) => { setListFilter(e.target.value); setPage(1) }}
                            className="px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary"
                        >
                            <option value="all">All Lists</option>
                            {leadLists?.map(list => (
                                <option key={list.id} value={list.id}>{list.name}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Bulk Actions */}
                {selectedLeads.length > 0 && (
                    <div className="bg-primary/10 rounded-lg p-3 flex items-center justify-between">
                        <span className="text-sm text-primary">
                            {selectedLeads.length} lead(s) selected
                        </span>
                        <div className="flex items-center gap-2">
                            <button className="px-3 py-1 text-sm bg-popover border border-input rounded hover:bg-accent">
                                Add to Campaign
                            </button>
                            <button className="px-3 py-1 text-sm bg-popover border border-input rounded hover:bg-accent">
                                Add to List
                            </button>
                            <button className="px-3 py-1 text-sm bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded hover:bg-red-200 dark:hover:bg-red-900/30">
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
                                        <LeadRow key={lead.id} lead={lead} onDelete={handleDelete} />
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
                                    <Link
                                        href="/outreach/leads/import"
                                        className="flex items-center gap-2 px-4 py-2 border border-input text-muted-foreground rounded-lg hover:bg-accent transition-colors"
                                    >
                                        <Upload className="w-5 h-5" />
                                        Import Leads
                                    </Link>
                                    <Link
                                        href="/outreach/leads/new"
                                        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                                        >
                                        <Plus className="w-5 h-5" />
                                        Add Lead
                                    </Link>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
            )}
        </OutreachLayout>
    )
}

export default LeadsPage
