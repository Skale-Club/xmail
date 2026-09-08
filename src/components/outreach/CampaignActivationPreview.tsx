import { AlertTriangle, Mail, ShieldAlert, ShieldCheck, Users } from 'lucide-react'
import { cn } from '../../lib/utils'

// Mirrors src/server/lib/outreach-approval-preview.ts's CampaignActivationPreview shape
// (kept as a plain duplicate rather than a shared import — this is a client-side type-only
// contract, and the server module pulls in Drizzle/db which must never reach the bundle).

export interface CampaignPreviewVariant {
    subject: string
    bodyPlain: string | null
    bodyHtml: string | null
}

export interface CampaignPreviewStep {
    stepOrder: number
    delayHours: number
    abTestEnabled: boolean
    variantA: CampaignPreviewVariant
    variantB: CampaignPreviewVariant | null
}

export interface CampaignPreviewSendingInbox {
    email: string
    dailySendLimit: number
    currentDailySent: number
}

export interface CampaignComplianceBlocker {
    code: string
    message: string
}

export interface CampaignActivationPreview {
    campaign: { id: string; name: string; status: string }
    sendingInboxes: CampaignPreviewSendingInbox[]
    sequence: CampaignPreviewStep[]
    sampleLead: { id: string; email: string } | null
    leadCounts: { total: number; verified: number; catchAll: number; unknown: number }
    compliance: {
        hasPhysicalAddress: boolean
        unsubscribePresentInEveryStep: boolean
        blockers: CampaignComplianceBlocker[]
    }
}

function variantBody(variant: CampaignPreviewVariant): string {
    return variant.bodyPlain ?? variant.bodyHtml ?? '(no body)'
}

function VariantBlock({ label, variant }: { label: string; variant: CampaignPreviewVariant }) {
    return (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
            <p className="text-sm font-medium text-foreground">{variant.subject || '(no subject)'}</p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{variantBody(variant)}</p>
        </div>
    )
}

/**
 * Renders what a `campaign_activation` approval is actually asking for — campaign identity,
 * sending inbox + daily-limit usage, lead verification split, compliance state, and the
 * sequence rendered with a real enrolled lead's values. Fase 37 / audit finding 2: the card
 * used to approve activation without showing any of this. `preview` is:
 *   - `undefined` while the enclosing query is still loading,
 *   - `null` when the server could not build one (never silently hide that from the reviewer),
 *   - the full payload otherwise.
 */
export function CampaignActivationPreviewCard({ preview }: { preview: CampaignActivationPreview | null | undefined }) {
    if (preview === undefined) {
        return <div className="mt-3 text-xs text-muted-foreground">Loading campaign preview…</div>
    }

    if (preview === null) {
        return (
            <div role="alert" className="mt-3 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                Could not load the campaign preview. Do not approve without seeing what will be sent.
            </div>
        )
    }

    const { campaign, sendingInboxes, sequence, sampleLead, leadCounts, compliance } = preview
    const hasBlockers = compliance.blockers.length > 0

    return (
        <div className="mt-3 space-y-3 rounded-lg border border-border/60 bg-background/60 p-3">
            <div>
                <p className="text-sm font-semibold text-foreground">{campaign.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{campaign.id} · status: {campaign.status}</p>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
                <span className="flex flex-wrap items-center gap-1">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    {sendingInboxes.length === 0 ? (
                        'No sending inbox assigned yet'
                    ) : (
                        sendingInboxes.map((inbox) => (
                            <span key={inbox.email} className="font-mono text-foreground">
                                {inbox.email} ({inbox.currentDailySent}/{inbox.dailySendLimit} sent today)
                            </span>
                        ))
                    )}
                </span>
                <span className="flex items-center gap-1">
                    <Users className="h-3.5 w-3.5 shrink-0" />
                    <strong className="font-mono text-foreground">{leadCounts.total}</strong> leads
                    {' ('}
                    <span className="text-emerald-600 dark:text-emerald-400">{leadCounts.verified} verified</span>
                    {', '}
                    <span className="text-amber-600 dark:text-amber-400">{leadCounts.catchAll} catch-all</span>
                    {', '}
                    <span>{leadCounts.unknown} unknown</span>
                    {')'}
                </span>
            </div>

            {hasBlockers ? (
                <div role="alert" className="space-y-1 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                    <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4 shrink-0" /> Compliance blocker</div>
                    <ul className="list-disc space-y-0.5 pl-5">
                        {compliance.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}
                    </ul>
                </div>
            ) : (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <ShieldCheck className="h-4 w-4 shrink-0" /> Postal address and unsubscribe link present in every step.
                </div>
            )}

            <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Sequence
                    {sampleLead
                        ? <> — rendered for <span className="font-mono normal-case text-foreground">{sampleLead.email}</span></>
                        : ' (no lead enrolled yet — showing raw template)'}
                </p>
                {sequence.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No email steps in this sequence.</p>
                ) : (
                    sequence.map((step) => (
                        <div key={step.stepOrder} className="space-y-2">
                            <p className="text-xs font-medium text-muted-foreground">Step {step.stepOrder} · delay {step.delayHours}h</p>
                            <div className={cn('grid gap-2', step.variantB ? 'sm:grid-cols-2' : '')}>
                                <VariantBlock label={step.variantB ? 'Variant A' : 'Body'} variant={step.variantA} />
                                {step.variantB && <VariantBlock label="Variant B" variant={step.variantB} />}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
