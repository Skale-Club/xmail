import React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../../components/ui/Dialog'
import { LeadVerificationBadge, type LeadEmailVerificationStatus } from '../../../components/outreach/LeadVerificationBadge'
import { apiFetch } from '../../../lib/api-client'
import { Loader2, Mail, Building, Phone, Linkedin } from 'lucide-react'

interface LeadDetail {
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
    emailVerificationStatus: LeadEmailVerificationStatus
    emailVerificationProvider: string | null
    emailVerifiedAt: string | null
    leadList?: { id: string; name: string } | null
    // Optional — populated once the backend includes campaign enrollment on this endpoint.
    // Rendered only when present so an older API response degrades gracefully.
    campaignLeads?: Array<{
        id: string
        status?: string
        campaign?: { id: string; name: string } | null
    }>
}

async function fetchLead(organizationId: string, id: string): Promise<LeadDetail> {
    const data = await apiFetch<{ lead: LeadDetail }>(`/api/outreach/leads/${id}?organizationId=${organizationId}`)
    return data.lead
}

interface LeadDetailDialogProps {
    leadId: string | null
    organizationId: string
    onOpenChange: (open: boolean) => void
}

function Field({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
    if (!value) return null
    return (
        <div className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 text-muted-foreground">{icon}</span>
            <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                <p className="text-foreground">{value}</p>
            </div>
        </div>
    )
}

export function LeadDetailDialog({ leadId, organizationId, onOpenChange }: LeadDetailDialogProps) {
    const { data: lead, isLoading, isError } = useQuery({
        queryKey: ['lead-detail', leadId, organizationId],
        queryFn: () => fetchLead(organizationId, leadId as string),
        enabled: !!leadId,
    })

    const fullName = lead ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email : ''

    return (
        <Dialog open={!!leadId} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{isLoading ? 'Lead' : fullName}</DialogTitle>
                    <DialogDescription>Lead details and campaign enrollment.</DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <div className="flex items-center justify-center py-10">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : isError || !lead ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">Could not load this lead.</p>
                ) : (
                    <div className="space-y-4 py-2">
                        <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4 text-muted-foreground" />
                            <span className="text-foreground">{lead.email}</span>
                            <LeadVerificationBadge
                                status={lead.emailVerificationStatus}
                                verifiedAt={lead.emailVerifiedAt}
                                provider={lead.emailVerificationProvider}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <Field icon={<Building className="h-4 w-4" />} label="Company" value={lead.companyName} />
                            <Field icon={<Building className="h-4 w-4" />} label="Title" value={lead.title} />
                            <Field icon={<Phone className="h-4 w-4" />} label="Phone" value={lead.phone} />
                            <Field
                                icon={<Linkedin className="h-4 w-4" />}
                                label="LinkedIn"
                                value={lead.linkedinUrl ? (
                                    <a href={lead.linkedinUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                                        View profile
                                    </a>
                                ) : null}
                            />
                        </div>

                        <div className="rounded-lg border border-border p-3">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
                            <p className="text-sm text-foreground capitalize">{lead.status.replace('_', ' ')}</p>
                        </div>

                        <div className="rounded-lg border border-border p-3">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Lead list</p>
                            <p className="text-sm text-foreground">{lead.leadList?.name ?? 'None'}</p>
                        </div>

                        {lead.campaignLeads && lead.campaignLeads.length > 0 && (
                            <div className="rounded-lg border border-border p-3">
                                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Campaigns</p>
                                <ul className="space-y-1">
                                    {lead.campaignLeads.map((cl) => (
                                        <li key={cl.id} className="flex items-center justify-between text-sm">
                                            <span className="text-foreground">{cl.campaign?.name ?? 'Unknown campaign'}</span>
                                            {cl.status && (
                                                <span className="text-xs capitalize text-muted-foreground">{cl.status.replace('_', ' ')}</span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}
