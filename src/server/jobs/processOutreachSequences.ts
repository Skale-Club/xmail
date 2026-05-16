/**
 * Process Outreach Email Sequences
 *
 * This job runs on a cron schedule to process pending outreach emails:
 * - Finds campaign leads with nextScheduledAt <= now
 * - Sends emails through assigned email accounts
 * - Tracks email delivery
 * - Advances leads through sequence steps
 * - Updates campaign stats
 */

import { createHash } from 'crypto'
import { db } from '../../db'
import { campaigns, sequenceSteps, campaignLeads, leads, emailAccounts, outreachEmails, suppressions } from '../../db/schema'
import { eq, and, lte, gt, inArray, notInArray, sql } from 'drizzle-orm'
import {
    sendOutreachEmail,
    recordOutreachEmail,
    isWithinSendWindow,
    canSendFromAccount,
    incrementAccountStats,
    incrementCampaignStats,
} from '../lib/outreach-sender'

type SequenceStep = typeof sequenceSteps.$inferSelect

function getNextStep(steps: SequenceStep[], currentStepOrder: number): SequenceStep | null {
    return steps.find(s => s.stepOrder > currentStepOrder) || null
}

function calculateNextScheduledAt(
    delayHours: number,
    timezone: string,
    sendStartTime: string,
    sendEndTime: string,
    sendOnWeekends: boolean
): Date {
    const next = new Date()
    next.setHours(next.getHours() + delayHours)

    const [startHour] = (sendStartTime || '09:00').split(':').map(Number)
    const [endHour] = (sendEndTime || '17:00').split(':').map(Number)

    const hour = next.getHours()
    if (hour < startHour) {
        next.setHours(startHour, 0, 0, 0)
    } else if (hour >= endHour) {
        next.setDate(next.getDate() + 1)
        next.setHours(startHour, 0, 0, 0)
    }

    if (!sendOnWeekends) {
        const day = next.getDay()
        if (day === 0) {
            next.setDate(next.getDate() + 1)
        } else if (day === 6) {
            next.setDate(next.getDate() + 2)
        }
    }

    return next
}

function selectAbVariant(step: SequenceStep, leadId: string): 'a' | 'b' {
    if (!step.abTestEnabled) return 'a'
    // Deterministic hash — same lead+step always produces same variant on retry (SEND-04)
    const hash = createHash('md5').update(leadId + step.id).digest('hex')
    const hashInt = parseInt(hash.slice(0, 8), 16)
    const threshold = step.abTestPercentage ?? 50
    return (hashInt % 100) < threshold ? 'a' : 'b'
}

export async function processOutreachSequences(): Promise<{ processed: number; sent: number; errors: number }> {
    const now = new Date()
    const result = { processed: 0, sent: 0, errors: 0 }
    const PENDING_LEADS_LIMIT = 200

    const pendingLeads = await db.query.campaignLeads.findMany({
        where: and(
            lte(campaignLeads.nextScheduledAt, now),
            notInArray(campaignLeads.status, ['replied', 'bounced', 'unsubscribed'])
        ),
        limit: PENDING_LEADS_LIMIT,
        with: {
            campaign: true,
            lead: true,
            currentStep: true,
            assignedEmailAccount: true
        }
    })

    if (pendingLeads.length === 0) {
        return result
    }

    const campaignIds = [...new Set(pendingLeads.map(cl => cl.campaignId))]
    const campaignsMap = new Map(
        (await db.query.campaigns.findMany({
            where: inArray(campaigns.id, campaignIds)
        })).map(c => [c.id, c])
    )

    const sequenceIds = [...new Set(
        pendingLeads
            .filter(cl => cl.currentStep?.sequenceId)
            .map(cl => cl.currentStep!.sequenceId)
    )]

    const allSteps = await db.query.sequenceSteps.findMany({
        where: inArray(sequenceSteps.sequenceId, sequenceIds),
        orderBy: (steps, { asc }) => [asc(steps.stepOrder)]
    })
    const stepsBySequence = new Map<string, typeof allSteps>()
    for (const step of allSteps) {
        if (!stepsBySequence.has(step.sequenceId)) {
            stepsBySequence.set(step.sequenceId, [])
        }
        stepsBySequence.get(step.sequenceId)!.push(step)
    }

    // Batch-load all suppressed emails for involved organizations
    const orgIds = [...new Set(pendingLeads.map(cl => cl.campaign.organizationId))]
    const allSuppressions = await db.query.suppressions.findMany({
        where: inArray(suppressions.organizationId, orgIds),
        columns: { organizationId: true, emailAddress: true },
    })
    const suppressedSet = new Set(allSuppressions.map(s => `${s.organizationId}:${s.emailAddress}`))

    // Batch-load existing outreach emails for idempotency checks
    const allExistingEmails = await db.query.outreachEmails.findMany({
        where: inArray(
            outreachEmails.campaignLeadId,
            pendingLeads.map(cl => cl.id)
        ),
        columns: { campaignLeadId: true, sequenceStepId: true },
    })
    const existingEmailsSet = new Set(
        allExistingEmails.map(e => `${e.campaignLeadId}:${e.sequenceStepId}`)
    )

    for (const campaignLead of pendingLeads) {
        result.processed++

        try {
            const campaign = campaignsMap.get(campaignLead.campaignId)
            if (!campaign) {
                console.error(`Campaign ${campaignLead.campaignId} not found`)
                result.errors++
                continue
            }

            if (campaign.status !== 'active') {
                continue
            }

            const lead = campaignLead.lead
            if (!lead) {
                console.error(`Lead not found for campaign lead ${campaignLead.id}`)
                result.errors++
                continue
            }

            if (lead.unsubscribedAt) {
                await db.update(campaignLeads)
                    .set({ status: 'unsubscribed', nextScheduledAt: null })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }

            const isSuppressed = suppressedSet.has(`${campaign.organizationId}:${lead.email}`)
            if (isSuppressed) {
                await db.update(campaignLeads)
                    .set({ status: 'bounced', nextScheduledAt: null })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }

            if (!isWithinSendWindow(campaign, now)) {
                continue
            }

            const emailAccount = campaignLead.assignedEmailAccount
            if (!emailAccount) {
                console.error(`No email account assigned for campaign lead ${campaignLead.id}`)
                result.errors++
                continue
            }

            if (emailAccount.status !== 'verified') {
                console.error(`Email account ${emailAccount.id} is not verified`)
                result.errors++
                continue
            }

            if (!canSendFromAccount(emailAccount)) {
                console.log(`Email account ${emailAccount.id} has reached daily limit`)
                continue
            }

            const currentStep = campaignLead.currentStep
            if (!currentStep) {
                console.error(`No current step for campaign lead ${campaignLead.id}`)
                result.errors++
                continue
            }

            // SEND-05: Idempotency guard — skip if this step was already sent to this lead
            if (existingEmailsSet.has(`${campaignLead.id}:${currentStep.id}`)) {
                console.log(`[processOutreachSequences] Skipping duplicate send for campaignLead ${campaignLead.id} step ${currentStep.id} (already in batch)`)
                continue
            }

            const abVariant = selectAbVariant(currentStep, lead.id)

            const trackingBaseUrl = process.env.FRONTEND_URL || 'http://localhost:9000'
            const sendResult = await sendOutreachEmail({
                account: emailAccount,
                lead,
                campaign,
                step: currentStep,
                campaignLeadId: campaignLead.id,
                trackOpens: campaign.trackOpens,
                trackClicks: campaign.trackClicks,
                trackingBaseUrl,
                abVariant,
            })

            if (!sendResult.success) {
                console.error(`[processOutreachSequences] Send failed for campaignLead ${campaignLead.id}: ${sendResult.error}`)
                result.errors++
                continue
            }

            await recordOutreachEmail({
                organizationId: campaign.organizationId,
                campaignId: campaign.id,
                campaignLeadId: campaignLead.id,
                sequenceStepId: currentStep.id,
                emailAccountId: emailAccount.id,
                subject: currentStep.subject || '',
                plainBody: currentStep.plainBody ?? null,
                htmlBody: sendResult.finalHtml ?? null,
                abVariant,
                messageId: sendResult.messageId,
            })

            const isFirstContact = !campaignLead.firstContactedAt
            await db.update(campaignLeads)
                .set({
                    status: 'contacted',
                    firstContactedAt: campaignLead.firstContactedAt || new Date(),
                    lastContactedAt: new Date(),
                    currentStepId: currentStep.id,
                    currentStepOrder: currentStep.stepOrder
                })
                .where(eq(campaignLeads.id, campaignLead.id))

            if (lead.status === 'new') {
                await db.update(leads)
                    .set({ status: 'contacted', lastContactedAt: new Date() })
                    .where(eq(leads.id, lead.id))
            }

            await incrementAccountStats(emailAccount.id, 'totalSent')
            // NOTE: incrementAccountStats('totalSent') increments BOTH totalSent AND currentDailySent in a single UPDATE

            if (isFirstContact) {
                await incrementCampaignStats(campaign.id, 'leadsContacted')
            }

            const steps = stepsBySequence.get(currentStep.sequenceId) || []
            const nextStep = getNextStep(steps, currentStep.stepOrder)

            if (nextStep) {
                const nextScheduledAt = calculateNextScheduledAt(
                    nextStep.delayHours,
                    campaign.timezone,
                    campaign.sendStartTime,
                    campaign.sendEndTime,
                    campaign.sendOnWeekends
                )

                await db.update(campaignLeads)
                    .set({
                        currentStepId: nextStep.id,
                        currentStepOrder: nextStep.stepOrder,
                        nextScheduledAt
                    })
                    .where(eq(campaignLeads.id, campaignLead.id))
            } else {
                await db.update(campaignLeads)
                    .set({
                        completedAt: new Date(),
                        nextScheduledAt: null
                    })
                    .where(eq(campaignLeads.id, campaignLead.id))
            }

            result.sent++
        } catch (error) {
            console.error(`Error processing campaign lead ${campaignLead.id}:`, error)
            result.errors++
        }
    }

    return result
}

export async function resetDailyLimits(): Promise<void> {
    const result = await db.update(emailAccounts)
        .set({ currentDailySent: 0 })
        .where(gt(emailAccounts.currentDailySent, 0))
        .returning({ id: emailAccounts.id })
    console.log(`[resetDailyLimits] Reset daily send counter for ${result.length} accounts`)
}

export async function markCompletedCampaigns(): Promise<void> {
    // Find all active campaigns that have zero incomplete leads
    // Using a NOT EXISTS subquery — single query instead of N queries
    const completedCampaigns = await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(
            and(
                eq(campaigns.status, 'active'),
                sql`NOT EXISTS (
                    SELECT 1 FROM campaign_leads
                    WHERE campaign_leads.campaign_id = ${campaigns.id}
                    AND campaign_leads.status NOT IN ('replied', 'bounced', 'unsubscribed')
                )`
            )
        )

    if (completedCampaigns.length === 0) return

    await db.update(campaigns)
        .set({
            status: 'completed',
            completedAt: new Date()
        })
        .where(inArray(campaigns.id, completedCampaigns.map(c => c.id)))

    console.log(`[markCompletedCampaigns] Marked ${completedCampaigns.length} campaigns as completed`)
}
