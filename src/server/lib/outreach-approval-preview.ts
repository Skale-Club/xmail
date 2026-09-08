/**
 * Builds the human-readable preview shown on a `campaign_activation` approval card before a
 * reviewer approves it (Fase 37, closing docs/outreach-hermes-system-map.md §8 finding 2:
 * "Card do Human gate aprova ativação sem mostrar campanha, assunto, corpo, nº de leads ou
 * inbox — e o approve ativa direto"). `outreach_action_approvals` has zero rows in its entire
 * history, so this gate has never actually been exercised with real data on screen.
 *
 * This module only READS and renders; it does not gate or change what approving does. The
 * activation gate itself is `validateCampaignReadyForActivation` (routes/outreach/campaigns.ts).
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { campaigns, campaignLeads, leads, emailAccounts } from '../../db/schema'
import { getCanonicalSequence } from './outreach-sequences'
import { generateUnsubscribeLink } from '../routes/outreach/unsubscribe'
import { interpolateTemplate, type LeadForTemplate } from './template-variables'
import {
    assessCampaignActivationCompliance,
    type CampaignComplianceAssessment,
    type CampaignComplianceStep,
} from './outreach-campaign-compliance'

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

export interface CampaignActivationPreview {
    campaign: { id: string; name: string; status: string }
    sendingInboxes: CampaignPreviewSendingInbox[]
    sequence: CampaignPreviewStep[]
    /** The enrolled lead whose values were substituted into `sequence`, or null with no leads enrolled. */
    sampleLead: { id: string; email: string } | null
    leadCounts: { total: number; verified: number; catchAll: number; unknown: number }
    compliance: CampaignComplianceAssessment
}

/**
 * Bucket a lead's raw `customFields.email_status` (the Xphere/MillionVerifier signal preserved
 * verbatim alongside the mapped `leads.emailVerificationStatus` column — see
 * email-verification-mapping.ts) into the three-way split the approval card shows. 'catch_all'
 * and every other value collapse to 'likely' on the mapped column, so this reads the RAW status
 * instead — it is the only place that still distinguishes catch-all from plain unknown.
 */
export function bucketRawEmailStatus(customFields: unknown): 'verified' | 'catchAll' | 'unknown' {
    if (customFields && typeof customFields === 'object' && !Array.isArray(customFields)) {
        const raw = (customFields as Record<string, unknown>).email_status
        if (raw === 'ok') return 'verified'
        if (raw === 'catch_all') return 'catchAll'
    }
    return 'unknown'
}

export function summarizeLeadVerification(customFieldsList: unknown[]): {
    total: number
    verified: number
    catchAll: number
    unknown: number
} {
    const counts = { total: customFieldsList.length, verified: 0, catchAll: 0, unknown: 0 }
    for (const customFields of customFieldsList) {
        counts[bucketRawEmailStatus(customFields)] += 1
    }
    return counts
}

interface RenderableStep extends CampaignComplianceStep {
    delayHours: number
}

/** Steps shown un-rendered (raw template text) when no lead is enrolled yet to substitute. */
function rawStepPreview(step: RenderableStep): CampaignPreviewStep {
    return {
        stepOrder: step.stepOrder,
        delayHours: step.delayHours,
        abTestEnabled: step.abTestEnabled,
        variantA: { subject: step.subject ?? '', bodyPlain: step.plainBody, bodyHtml: step.htmlBody },
        variantB: step.abTestEnabled
            ? { subject: step.subjectB ?? '', bodyPlain: step.plainBodyB, bodyHtml: step.htmlBodyB }
            : null,
    }
}

/** Steps rendered with a real enrolled lead's values, exactly as the send path would produce them. */
export function renderCampaignPreviewSequence(
    steps: RenderableStep[],
    lead: LeadForTemplate,
    context: { unsubscribeUrl: string; contentLanguage: string },
): CampaignPreviewStep[] {
    return steps
        .filter((step) => step.type === 'email')
        .map((step) => ({
            stepOrder: step.stepOrder,
            delayHours: step.delayHours,
            abTestEnabled: step.abTestEnabled,
            variantA: {
                subject: interpolateTemplate(step.subject || '', lead, context),
                bodyPlain: step.plainBody ? interpolateTemplate(step.plainBody, lead, context) : null,
                bodyHtml: step.htmlBody ? interpolateTemplate(step.htmlBody, lead, context, { escapeHtml: true }) : null,
            },
            variantB: step.abTestEnabled
                ? {
                    subject: interpolateTemplate(step.subjectB || '', lead, context),
                    bodyPlain: step.plainBodyB ? interpolateTemplate(step.plainBodyB, lead, context) : null,
                    bodyHtml: step.htmlBodyB ? interpolateTemplate(step.htmlBodyB, lead, context, { escapeHtml: true }) : null,
                }
                : null,
        }))
}

/**
 * Assembles everything a human reviewer needs to see before approving a `campaign_activation`
 * request: the campaign identity, the sending inbox(es) and their daily-limit usage, the
 * sequence rendered with one real enrolled lead's values, the lead verification-status split,
 * and the compliance assessment (postal address, {{unsubscribeUrl}}). Returns null only when
 * the campaign itself cannot be found in this organization (e.g. deleted after the approval
 * was requested) — the caller decides how to surface that.
 */
export async function buildCampaignActivationPreview(
    campaignId: string,
    organizationId: string,
): Promise<CampaignActivationPreview | null> {
    const campaign = await db.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
        columns: { id: true, name: true, status: true, contentLanguage: true },
    })
    if (!campaign) return null

    const canonicalSequence = await getCanonicalSequence(campaignId, organizationId)
    const steps: RenderableStep[] = (canonicalSequence?.steps ?? []).map((step) => ({
        stepOrder: step.stepOrder,
        type: step.type,
        delayHours: step.delayHours,
        subject: step.subject,
        plainBody: step.plainBody,
        htmlBody: step.htmlBody,
        subjectB: step.subjectB,
        plainBodyB: step.plainBodyB,
        htmlBodyB: step.htmlBodyB,
        abTestEnabled: step.abTestEnabled,
    }))

    const compliance = assessCampaignActivationCompliance(steps)

    const enrolledLeads = await db
        .select({
            campaignLeadId: campaignLeads.id,
            assignedEmailAccountId: campaignLeads.assignedEmailAccountId,
            createdAt: campaignLeads.createdAt,
            leadId: leads.id,
            email: leads.email,
            firstName: leads.firstName,
            lastName: leads.lastName,
            companyName: leads.companyName,
            companySize: leads.companySize,
            industry: leads.industry,
            title: leads.title,
            website: leads.website,
            linkedinUrl: leads.linkedinUrl,
            phone: leads.phone,
            location: leads.location,
            customFields: leads.customFields,
        })
        .from(campaignLeads)
        .innerJoin(leads, eq(campaignLeads.leadId, leads.id))
        .where(eq(campaignLeads.campaignId, campaignId))
        .orderBy(asc(campaignLeads.createdAt))

    const leadCounts = summarizeLeadVerification(enrolledLeads.map((row) => row.customFields))

    const sampleRow = enrolledLeads[0]
    let sequence: CampaignPreviewStep[]
    let sampleLead: { id: string; email: string } | null = null

    if (sampleRow) {
        sampleLead = { id: sampleRow.leadId, email: sampleRow.email }
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:9000'
        const unsubscribeUrl = generateUnsubscribeLink(sampleRow.campaignLeadId, campaignId, baseUrl)
        const leadForTemplate: LeadForTemplate = {
            email: sampleRow.email,
            firstName: sampleRow.firstName,
            lastName: sampleRow.lastName,
            companyName: sampleRow.companyName,
            companySize: sampleRow.companySize,
            industry: sampleRow.industry,
            title: sampleRow.title,
            website: sampleRow.website,
            linkedinUrl: sampleRow.linkedinUrl,
            phone: sampleRow.phone,
            location: sampleRow.location,
            customFields: (sampleRow.customFields as Record<string, unknown> | null) ?? null,
        }
        sequence = renderCampaignPreviewSequence(steps, leadForTemplate, {
            unsubscribeUrl,
            contentLanguage: campaign.contentLanguage,
        })
    } else {
        // No enrolled lead yet: show the raw template text rather than guessing at a fake
        // substitution — a fabricated preview would be worse than an honest "no lead yet".
        sequence = steps.filter((step) => step.type === 'email').map(rawStepPreview)
    }

    const accountIds = [...new Set(
        enrolledLeads.map((row) => row.assignedEmailAccountId).filter((id): id is string => Boolean(id)),
    )]
    const sendingInboxes = accountIds.length > 0
        ? await db.query.emailAccounts.findMany({
            where: and(eq(emailAccounts.organizationId, organizationId), inArray(emailAccounts.id, accountIds)),
            columns: { email: true, dailySendLimit: true, currentDailySent: true },
        })
        : []

    return {
        campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
        sendingInboxes,
        sequence,
        sampleLead,
        leadCounts,
        compliance,
    }
}
