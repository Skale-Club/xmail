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
import { campaignLeads } from '../../db/schema'
import { eq, and, lte, isNotNull } from 'drizzle-orm'
import { decideFollowUp, enforceGuardrails, type FollowUpContext } from '../lib/outreach-followup'
import { createLogger } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { runWithLock } from '../lib/cron-lock'
import { dispatchOutreachMessage } from '../lib/outreach-dispatch'
import { createThreadedDispatchProvider } from '../lib/outreach-dispatch-provider'

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

            // The dispatcher owns live suppression, schedule, organization, and
            // account policy. The decision guard retains only conversation limits.
            const decision = enforceGuardrails(raw, {
                unsubscribed: lead.unsubscribedAt != null,
                suppressed: false,
                withinWindow: true,
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

            if (!cl.lastReplyMessageId) {
                await clearSchedule(cl.id)
                result.errors++
                log.warn({ action: 'outreach.followup.no_inbound_reply', campaignLeadId: cl.id }, 'follow-up has no inbound reply id')
                continue
            }

            const subject = decision.subject && decision.subject.trim().length > 0
                ? decision.subject
                : `Re: ${campaign.name}`

            const dispatchResult = await dispatchOutreachMessage({
                origin: 'agentic',
                organizationId: campaign.organizationId,
                emailAccountId: account.id,
                campaignId: campaign.id,
                campaignLeadId: cl.id,
                leadId: lead.id,
                idempotencyKey: `agentic:${cl.id}:${cl.lastReplyMessageId}:${cl.followUpCount + 1}`,
                to: lead.email,
                subject,
                text: decision.message!,
                inReplyTo: cl.lastReplyMessageId,
                references: cl.lastReplyMessageId,
            }, {
                provider: createThreadedDispatchProvider({
                    account,
                    fromName: campaign.fromName,
                    replyTo: campaign.replyToEmail,
                }),
            })

            if (dispatchResult.status === 'deferred') {
                await db.update(campaignLeads)
                    .set({ nextFollowUpAt: dispatchResult.retryAt ?? null, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, cl.id))
                log.info({ action: 'outreach.followup.policy_deferred', campaignLeadId: cl.id, code: dispatchResult.code, retryAt: dispatchResult.retryAt }, 'follow-up deferred by policy')
                continue
            }

            if (dispatchResult.status === 'retry_scheduled') {
                await db.update(campaignLeads)
                    .set({ nextFollowUpAt: dispatchResult.nextAttemptAt, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, cl.id))
                continue
            }

            if (dispatchResult.status === 'in_progress' || dispatchResult.status === 'lost_lease') {
                await db.update(campaignLeads)
                    .set({ nextFollowUpAt: hoursFromNow(1 / 12), updatedAt: new Date() })
                    .where(eq(campaignLeads.id, cl.id))
                continue
            }

            if (dispatchResult.status === 'held' || dispatchResult.status === 'exhausted' || dispatchResult.status === 'failed') {
                await clearSchedule(cl.id)
                result.errors++
                log.error({ action: 'outreach.followup.dispatch_stopped', campaignLeadId: cl.id, status: dispatchResult.status }, 'follow-up dispatch stopped')
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

            if (dispatchResult.status === 'sent') {
                result.sent++
                sendXphereOutreachEvent('followup.sent', {
                    email: lead.email,
                    campaign_id: campaign.id,
                    lead_id: lead.id,
                    customFields: lead.customFields,
                })
                log.info({ action: 'outreach.followup.sent', campaignLeadId: cl.id, followUpCount: cl.followUpCount + 1 }, 'follow-up sent')
            } else {
                log.info({ action: 'outreach.followup.duplicate_recovered', campaignLeadId: cl.id, followUpCount: cl.followUpCount + 1 }, 'recovered already-sent follow-up progress')
            }
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

const FOLLOWUP_PROCESSOR_LOCK_NAME = 'outreach-followups-processor'

export async function runFollowUpsProcessorWithLock(): Promise<void> {
    await runWithLock(FOLLOWUP_PROCESSOR_LOCK_NAME, async () => {
        const result = await processFollowUps()
        if (result.processed > 0) {
            log.info({ action: 'outreach.followup.tick.complete', ...result }, 'follow-up tick complete')
        }
    })
}
