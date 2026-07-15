/**
 * Agentic Follow-up Processor (P002)
 *
 * Picks campaign_leads that a matched reply scheduled for a follow-up decision
 * (next_follow_up_at <= now), asks the decider what to do ("Xphere decides, Xmail executes"),
 * enforces guardrails, and executes: send a threaded reply / wait / complete.
 *
 * GATED: leads only get here if their campaign has agentic_followup_enabled = true (the reply
 * processor is what sets next_follow_up_at). So this job is inert for every existing campaign.
 */

import { db } from '../../db'
import { campaignLeads, outreachEmails, suppressions } from '../../db/schema'
import { eq, and, lte, isNotNull, desc } from 'drizzle-orm'
import { isWithinSendWindow, sendThreadedReply } from '../lib/outreach-sender'
import { decideFollowUp, enforceGuardrails, type FollowUpContext } from '../lib/outreach-followup'
import { createLogger } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { runWithLock } from '../lib/cron-lock'

const log = createLogger('outreach.followup')

const FOLLOWUP_BATCH_LIMIT = 100
const DEFAULT_WAIT_HOURS = 24
const DEFAULT_REARM_HOURS = 72

function hoursFromNow(hours: number): Date {
    return new Date(Date.now() + hours * 60 * 60 * 1000)
}

export async function processFollowUps(): Promise<{ processed: number; sent: number; completed: number; errors: number }> {
    const now = new Date()
    const result = { processed: 0, sent: 0, completed: 0, errors: 0 }

    const dueLeads = await db.query.campaignLeads.findMany({
        where: and(
            isNotNull(campaignLeads.nextFollowUpAt),
            lte(campaignLeads.nextFollowUpAt, now),
        ),
        limit: FOLLOWUP_BATCH_LIMIT,
        with: {
            campaign: true,
            lead: true,
            assignedEmailAccount: true,
        },
    })

    for (const cl of dueLeads) {
        result.processed++
        try {
            const campaign = cl.campaign
            const lead = cl.lead
            if (!campaign || !lead) {
                await clearSchedule(cl.id)
                continue
            }

            // Campaign may have been toggled off after scheduling — respect it.
            if (!campaign.agenticFollowupEnabled || campaign.status !== 'active') {
                await clearSchedule(cl.id)
                continue
            }

            const ctx: FollowUpContext = {
                organizationId: campaign.organizationId,
                campaignId: campaign.id,
                campaignLeadId: cl.id,
                leadEmail: lead.email,
                leadFirstName: lead.firstName,
                leadCompany: lead.companyName,
                sellerName: campaign.fromName ?? null,
                lastReplyText: cl.lastReplyText ?? null,
                followUpCount: cl.followUpCount,
                maxFollowUps: campaign.maxFollowUps,
            }

            const raw = await decideFollowUp(ctx)

            // Guardrails need live suppression + window + unsubscribe state.
            const suppressed = await isSuppressed(campaign.organizationId, lead.email)
            const decision = enforceGuardrails(raw, {
                unsubscribed: lead.unsubscribedAt != null,
                suppressed,
                withinWindow: isWithinSendWindow(campaign, now),
                followUpCount: cl.followUpCount,
                maxFollowUps: campaign.maxFollowUps,
            })

            if (decision.action === 'complete') {
                await clearSchedule(cl.id)
                result.completed++
                sendXphereOutreachEvent('followup.completed', {
                    email: lead.email,
                    campaign_id: campaign.id,
                    lead_id: lead.id,
                    customFields: lead.customFields,
                    outcome: decision.outcome ?? null,
                })
                log.info({ action: 'outreach.followup.completed', campaignLeadId: cl.id, outcome: decision.outcome }, 'follow-up completed')
                continue
            }

            if (decision.action === 'wait') {
                await db.update(campaignLeads)
                    .set({ nextFollowUpAt: hoursFromNow(decision.followUpHours ?? DEFAULT_WAIT_HOURS) })
                    .where(eq(campaignLeads.id, cl.id))
                log.info({ action: 'outreach.followup.wait', campaignLeadId: cl.id, followUpHours: decision.followUpHours ?? DEFAULT_WAIT_HOURS }, 'follow-up deferred')
                continue
            }

            // action === 'send'
            const account = cl.assignedEmailAccount
            if (!account || account.status !== 'verified') {
                // Cannot send without a verified inbox — stop rather than loop.
                await clearSchedule(cl.id)
                result.errors++
                log.warn({ action: 'outreach.followup.no_account', campaignLeadId: cl.id }, 'no verified inbox for follow-up')
                continue
            }

            // Thread under our most-recent sent email to this lead.
            const lastSent = await db
                .select({ messageId: outreachEmails.messageId })
                .from(outreachEmails)
                .where(and(eq(outreachEmails.campaignLeadId, cl.id), isNotNull(outreachEmails.sentAt)))
                .orderBy(desc(outreachEmails.sentAt))
                .limit(1)

            const subject = decision.subject && decision.subject.trim().length > 0
                ? decision.subject
                : `Re: ${campaign.name}`

            const sendResult = await sendThreadedReply({
                account,
                to: lead.email,
                subject,
                text: decision.message!,
                fromName: campaign.fromName,
                replyTo: campaign.replyToEmail,
                inReplyTo: lastSent[0]?.messageId ?? null,
            })

            if (!sendResult.success) {
                // Re-arm a short retry; guardrails' max_follow_ups still bounds total attempts.
                await db.update(campaignLeads)
                    .set({ nextFollowUpAt: hoursFromNow(DEFAULT_WAIT_HOURS) })
                    .where(eq(campaignLeads.id, cl.id))
                result.errors++
                log.error({ action: 'outreach.followup.send_failed', campaignLeadId: cl.id, error: { message: sendResult.error } }, 'follow-up send failed')
                continue
            }

            await db.update(campaignLeads)
                .set({
                    followUpCount: cl.followUpCount + 1,
                    lastContactedAt: now,
                    // Re-arm for the next turn; the reply processor will bring the clock forward
                    // if the lead answers again sooner.
                    nextFollowUpAt: hoursFromNow(decision.followUpHours ?? DEFAULT_REARM_HOURS),
                })
                .where(eq(campaignLeads.id, cl.id))

            result.sent++
            sendXphereOutreachEvent('followup.sent', {
                email: lead.email,
                campaign_id: campaign.id,
                lead_id: lead.id,
                customFields: lead.customFields,
            })
            log.info({ action: 'outreach.followup.sent', campaignLeadId: cl.id, followUpCount: cl.followUpCount + 1 }, 'follow-up sent')
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            result.errors++
            log.error({ action: 'outreach.followup.exception', campaignLeadId: cl.id, error: { message: err.message, stack: err.stack } }, 'follow-up processing threw')
        }
    }

    return result
}

async function clearSchedule(campaignLeadId: string): Promise<void> {
    await db.update(campaignLeads)
        .set({ nextFollowUpAt: null })
        .where(eq(campaignLeads.id, campaignLeadId))
}

async function isSuppressed(organizationId: string, email: string): Promise<boolean> {
    const hit = await db.query.suppressions.findFirst({
        where: and(
            eq(suppressions.organizationId, organizationId),
            eq(suppressions.emailAddress, email.toLowerCase()),
        ),
        columns: { id: true },
    })
    return hit != null
}

const FOLLOWUP_PROCESSOR_LOCK_NAME = 'outreach-followups-processor'

export async function runFollowUpsProcessorWithLock(): Promise<void> {
    await runWithLock(FOLLOWUP_PROCESSOR_LOCK_NAME, async () => {
        const result = await processFollowUps()
        if (result.processed > 0) {
            log.info({ action: 'outreach.followup.tick.complete', ...result }, 'follow-up tick complete')
        }
    })
}
