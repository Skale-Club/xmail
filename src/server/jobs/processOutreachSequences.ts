import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { campaigns, campaignLeads, emailAccounts, leads, sequenceSteps } from '../../db/schema'
import { runWithLock } from '../lib/cron-lock'
import type { DeliveryPolicyCode } from '../lib/outreach-delivery-policy'
import { dispatchOutreachMessage, type DispatchResult } from '../lib/outreach-dispatch'
import { createCampaignDispatchProvider } from '../lib/outreach-dispatch-provider'
import { createLogger, OUTREACH_PROCESSOR_SLOW_MS } from '../lib/logger'
import {
    resolveSequenceAction,
    TERMINAL_CAMPAIGN_LEAD_STATUSES,
} from '../lib/outreach-sequence-state'
import { incrementCampaignStats } from '../lib/outreach-sender'
import { generateOutreachToken } from '../lib/outreach-tokens'
import { sendXphereOutreachEvent } from '../lib/xphere-events'

const log = createLogger('outreach.processor')
const TICK_HISTORY_SIZE = 100
const PENDING_LEADS_LIMIT = 200
const OUTREACH_PROCESSOR_LOCK_NAME = 'outreach-sequences-processor'
const tickHistory: number[] = []

type SequenceStep = typeof sequenceSteps.$inferSelect
type CampaignLeadWithRelations = Awaited<ReturnType<typeof hydrateDueCampaignLeads>>[number]

interface DueCampaignLeadIdRow {
    id: string
}

function rowsOf<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[]
    if (value && typeof value === 'object' && 'rows' in value) {
        const rows = (value as { rows?: unknown }).rows
        return Array.isArray(rows) ? rows as T[] : []
    }
    return []
}

function recordTick(latencyMs: number): void {
    tickHistory.push(latencyMs)
    if (tickHistory.length > TICK_HISTORY_SIZE) tickHistory.shift()
}

export function getRecentTickLatencies(): readonly number[] {
    return tickHistory.slice()
}

function selectAbVariant(step: SequenceStep, leadId: string): 'a' | 'b' {
    if (!step.abTestEnabled) return 'a'
    const hash = createHash('md5').update(leadId + step.id).digest('hex')
    const threshold = step.abTestPercentage ?? 50
    return (parseInt(hash.slice(0, 8), 16) % 100) < threshold ? 'a' : 'b'
}

async function selectDueCampaignLeadIds(now: Date, limit: number): Promise<string[]> {
    const terminalStatuses = sql.join(
        TERMINAL_CAMPAIGN_LEAD_STATUSES.map((status) => sql`${status}`),
        sql`, `,
    )
    const selected = rowsOf<DueCampaignLeadIdRow>(await db.execute(sql`
        WITH ranked_due AS (
            SELECT campaign_lead.id,
                campaign_lead.next_scheduled_at,
                campaign_lead.assigned_email_account_id,
                ROW_NUMBER() OVER (
                    PARTITION BY campaign_lead.assigned_email_account_id
                    ORDER BY campaign_lead.next_scheduled_at ASC, campaign_lead.id ASC
                ) AS account_rank
            FROM campaign_leads AS campaign_lead
            JOIN campaigns AS campaign ON campaign.id = campaign_lead.campaign_id
            JOIN organizations AS organization ON organization.id = campaign.organization_id
            JOIN email_accounts AS email_account ON email_account.id = campaign_lead.assigned_email_account_id
            WHERE campaign_lead.next_scheduled_at <= ${now}
              AND campaign_lead.status NOT IN (${terminalStatuses})
              AND campaign.status = 'active'
              AND organization.outreach_enabled = TRUE
              AND email_account.status = 'verified'
        )
        SELECT id
        FROM ranked_due
        ORDER BY account_rank ASC, next_scheduled_at ASC, assigned_email_account_id ASC, id ASC
        LIMIT ${Math.max(1, limit)}
    `))
    return selected.map((row) => row.id)
}

async function hydrateDueCampaignLeads(selectedIds: string[]) {
    if (selectedIds.length === 0) return []
    const hydrated = await db.query.campaignLeads.findMany({
        where: inArray(campaignLeads.id, selectedIds),
        with: {
            campaign: true,
            lead: true,
            currentStep: true,
            assignedEmailAccount: true,
        },
    })
    const byId = new Map(hydrated.map((campaignLead) => [campaignLead.id, campaignLead]))
    return selectedIds.flatMap((id) => {
        const campaignLead = byId.get(id)
        return campaignLead ? [campaignLead] : []
    })
}

function isAccountTemporalDenial(code: DeliveryPolicyCode): boolean {
    return code === 'account_spacing'
        || code === 'daily_limit_exhausted'
        || code === 'warmup_limit_exhausted'
}

async function applyCampaignDeferral(
    campaignLeadId: string,
    dispatchResult: Extract<DispatchResult, { status: 'deferred' }>,
    now: Date,
): Promise<void> {
    if (dispatchResult.retryAt && dispatchResult.retryAt.getTime() > now.getTime()) {
        await db.update(campaignLeads)
            .set({ nextScheduledAt: dispatchResult.retryAt, updatedAt: new Date() })
            .where(eq(campaignLeads.id, campaignLeadId))
        return
    }

    if (dispatchResult.code === 'lead_unsubscribed' || dispatchResult.code === 'recipient_suppressed') {
        await db.update(campaignLeads)
            .set({ status: 'unsubscribed', nextScheduledAt: null, updatedAt: new Date() })
            .where(eq(campaignLeads.id, campaignLeadId))
        return
    }

    await db.update(campaignLeads)
        .set({ nextScheduledAt: null, updatedAt: new Date() })
        .where(eq(campaignLeads.id, campaignLeadId))
}

async function advanceCampaignLeadAfterDispatch(
    campaignLead: CampaignLeadWithRelations,
    sequenceAction: Extract<ReturnType<typeof resolveSequenceAction>, { type: 'send_email' }>,
    sentAt: Date,
): Promise<boolean> {
    const advanced = await db.update(campaignLeads)
        .set({
            status: 'contacted',
            firstContactedAt: campaignLead.firstContactedAt ?? sentAt,
            lastContactedAt: sentAt,
            currentStepId: sequenceAction.nextStep?.id ?? sequenceAction.step.id,
            currentStepOrder: sequenceAction.nextStep?.stepOrder ?? sequenceAction.step.stepOrder,
            nextScheduledAt: sequenceAction.nextScheduledAt,
            completedAt: sequenceAction.nextStep ? campaignLead.completedAt : sentAt,
            updatedAt: sentAt,
        })
        .where(and(
            eq(campaignLeads.id, campaignLead.id),
            eq(campaignLeads.currentStepId, sequenceAction.step.id),
            sql`${campaignLeads.status} NOT IN (${sql.join(
                TERMINAL_CAMPAIGN_LEAD_STATUSES.map((status) => sql`${status}`),
                sql`, `,
            )})`,
        ))
        .returning({ id: campaignLeads.id })
    return advanced.length === 1
}

export async function processOutreachSequences(): Promise<{ processed: number; sent: number; errors: number }> {
    const now = new Date()
    const result = { processed: 0, sent: 0, errors: 0 }
    const deferredCounts: Partial<Record<DeliveryPolicyCode, number>> = {}
    const accountDeferredUntil = new Map<string, Date>()
    const campaignDeferredUntil = new Map<string, Date>()

    const selectedIds = await selectDueCampaignLeadIds(now, PENDING_LEADS_LIMIT)
    const pendingLeads = await hydrateDueCampaignLeads(selectedIds)
    log.debug({
        action: 'outreach.processor.work_selected',
        selected: selectedIds.length,
        hydrated: pendingLeads.length,
        hardLimit: PENDING_LEADS_LIMIT,
    }, 'selected fair due-work batch')

    if (pendingLeads.length === 0) return result

    const sequenceIds = [...new Set(
        pendingLeads.flatMap((campaignLead) => campaignLead.currentStep?.sequenceId ?? []),
    )]
    const allSteps = sequenceIds.length > 0
        ? await db.query.sequenceSteps.findMany({
            where: inArray(sequenceSteps.sequenceId, sequenceIds),
            orderBy: (steps, { asc }) => [asc(steps.stepOrder)],
        })
        : []
    const stepsBySequence = new Map<string, SequenceStep[]>()
    for (const step of allSteps) {
        const steps = stepsBySequence.get(step.sequenceId) ?? []
        steps.push(step)
        stepsBySequence.set(step.sequenceId, steps)
    }

    const accountByIdInTick = new Map<string, typeof emailAccounts.$inferSelect>()
    for (const campaignLead of pendingLeads) {
        if (campaignLead.assignedEmailAccount) {
            accountByIdInTick.set(campaignLead.assignedEmailAccount.id, campaignLead.assignedEmailAccount)
        }
    }

    for (const campaignLead of pendingLeads) {
        result.processed++
        try {
            const { campaign, lead } = campaignLead
            const currentStep = campaignLead.currentStep
            const steps = currentStep ? stepsBySequence.get(currentStep.sequenceId) ?? [] : []
            const sequenceAction = resolveSequenceAction(steps, currentStep, now, {
                timezone: campaign.timezone,
                sendStartTime: campaign.sendStartTime,
                sendEndTime: campaign.sendEndTime,
                sendOnWeekends: campaign.sendOnWeekends,
            })

            if (sequenceAction.type === 'advance_without_send') {
                await db.update(campaignLeads)
                    .set({
                        currentStepId: sequenceAction.nextStep.id,
                        currentStepOrder: sequenceAction.nextStep.stepOrder,
                        nextScheduledAt: sequenceAction.nextScheduledAt,
                        updatedAt: new Date(),
                    })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }
            if (sequenceAction.type === 'complete') {
                await db.update(campaignLeads)
                    .set({ completedAt: sequenceAction.completedAt, nextScheduledAt: null, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }
            if (sequenceAction.type === 'quarantine') {
                await db.update(campaignLeads)
                    .set({ nextScheduledAt: null, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, campaignLead.id))
                log.error({
                    action: 'outreach.processor.sequence_configuration_error',
                    reason: sequenceAction.reason,
                    campaignId: campaign.id,
                    campaignLeadId: campaignLead.id,
                    sequenceStepId: sequenceAction.step.id,
                }, 'sequence row quarantined before dispatch')
                result.errors++
                continue
            }

            const emailStep = sequenceAction.step
            const emailAccount = campaignLead.assignedEmailAccountId
                ? accountByIdInTick.get(campaignLead.assignedEmailAccountId)
                : campaignLead.assignedEmailAccount
            if (!emailAccount) {
                result.errors++
                continue
            }

            const blockedUntil = [
                accountDeferredUntil.get(emailAccount.id),
                campaignDeferredUntil.get(campaign.id),
            ]
                .filter((value): value is Date => value != null)
                .sort((left, right) => right.getTime() - left.getTime())[0]
            if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
                await db.update(campaignLeads)
                    .set({ nextScheduledAt: blockedUntil, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }

            const abVariant = selectAbVariant(emailStep, lead.id)
            const trackingToken = generateOutreachToken({ kind: 'track', clid: campaignLead.id, cid: campaign.id })
            const frozenSubject = abVariant === 'b' && emailStep.subjectB ? emailStep.subjectB : sequenceAction.content.subject
            const frozenText = abVariant === 'b' && emailStep.plainBodyB ? emailStep.plainBodyB : sequenceAction.content.plainBody
            const frozenHtml = abVariant === 'b' && emailStep.htmlBodyB ? emailStep.htmlBodyB : sequenceAction.content.htmlBody
            const dispatchResult = await dispatchOutreachMessage({
                origin: 'campaign',
                organizationId: campaign.organizationId,
                emailAccountId: emailAccount.id,
                campaignId: campaign.id,
                campaignLeadId: campaignLead.id,
                sequenceStepId: emailStep.id,
                leadId: lead.id,
                trackingToken,
                idempotencyKey: `campaign:${campaignLead.id}:${emailStep.id}`,
                to: lead.email,
                subject: frozenSubject,
                text: frozenText,
                html: frozenHtml,
                abVariant,
            }, {
                provider: createCampaignDispatchProvider({
                    account: emailAccount,
                    lead,
                    campaign,
                    step: emailStep,
                    campaignLeadId: campaignLead.id,
                    trackingToken,
                    trackOpens: campaign.trackOpens,
                    trackClicks: campaign.trackClicks,
                    trackingBaseUrl: process.env.FRONTEND_URL || 'http://localhost:9000',
                    abVariant,
                }),
            })

            if (dispatchResult.status === 'deferred') {
                deferredCounts[dispatchResult.code] = (deferredCounts[dispatchResult.code] ?? 0) + 1
                await applyCampaignDeferral(campaignLead.id, dispatchResult, now)
                if (dispatchResult.retryAt) {
                    if (dispatchResult.code === 'outside_send_window') {
                        campaignDeferredUntil.set(campaign.id, dispatchResult.retryAt)
                    } else if (isAccountTemporalDenial(dispatchResult.code)) {
                        accountDeferredUntil.set(emailAccount.id, dispatchResult.retryAt)
                    }
                }
                continue
            }
            if (dispatchResult.status === 'retry_scheduled') {
                await db.update(campaignLeads)
                    .set({ nextScheduledAt: dispatchResult.nextAttemptAt, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }
            if (dispatchResult.status === 'in_progress' || dispatchResult.status === 'lost_lease') {
                await db.update(campaignLeads)
                    .set({ nextScheduledAt: new Date(now.getTime() + 5 * 60_000), updatedAt: new Date() })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }
            if (dispatchResult.status === 'held' || dispatchResult.status === 'exhausted' || dispatchResult.status === 'failed') {
                await db.update(campaignLeads)
                    .set({ nextScheduledAt: null, updatedAt: new Date() })
                    .where(eq(campaignLeads.id, campaignLead.id))
                result.errors++
                continue
            }

            const sentAt = new Date()
            const progressAdvanced = await advanceCampaignLeadAfterDispatch(campaignLead, sequenceAction, sentAt)
            if (!progressAdvanced) {
                log.info({
                    action: 'outreach.processor.terminal_race_preserved',
                    campaignLeadId: campaignLead.id,
                    sequenceStepId: emailStep.id,
                }, 'did not overwrite campaign lead progress after a terminal event')
                continue
            }
            if (lead.status === 'new') {
                await db.update(leads)
                    .set({ status: 'contacted', lastContactedAt: sentAt, updatedAt: sentAt })
                    .where(and(eq(leads.id, lead.id), eq(leads.status, 'new')))
            }

            if (dispatchResult.status === 'sent') {
                emailAccount.currentDailySent += 1
                emailAccount.lastSentAt = sentAt
                accountDeferredUntil.set(
                    emailAccount.id,
                    new Date(sentAt.getTime() + emailAccount.minMinutesBetweenEmails * 60_000),
                )
                if (!campaignLead.firstContactedAt) {
                    await incrementCampaignStats(campaign.id, 'leadsContacted')
                }
                sendXphereOutreachEvent('sent', {
                    email: lead.email,
                    campaign_id: campaign.id,
                    lead_id: lead.id,
                    customFields: lead.customFields,
                })
                result.sent++
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.processor.lead_exception',
                campaignLeadId: campaignLead.id,
                error: { message: err.message, stack: err.stack },
            }, 'lead processing threw')
            result.errors++
        }
    }

    if (Object.keys(deferredCounts).length > 0) {
        log.info({ action: 'outreach.processor.deferred', counts: deferredCounts }, 'deferred outreach work')
    }
    return result
}

export async function resetDailyLimits(): Promise<void> {
    const result = await db.update(emailAccounts)
        .set({
            currentDailySent: 0,
            warmupCurrentDay: sql`CASE
                WHEN ${emailAccounts.warmupEnabled} = TRUE
                    AND ${emailAccounts.warmupCurrentDay} < ${emailAccounts.warmupDays}
                THEN ${emailAccounts.warmupCurrentDay} + 1
                ELSE ${emailAccounts.warmupCurrentDay}
            END`,
            updatedAt: new Date(),
        })
        .where(sql`${emailAccounts.currentDailySent} > 0 OR (${emailAccounts.warmupEnabled} = TRUE AND ${emailAccounts.warmupCurrentDay} < ${emailAccounts.warmupDays})`)
        .returning({ id: emailAccounts.id })
    log.info({ action: 'outreach.processor.reset_daily_limits', accountsReset: result.length }, 'reset daily limits')
}

export async function runOutreachProcessorWithLock(): Promise<void> {
    await runWithLock(OUTREACH_PROCESSOR_LOCK_NAME, async () => {
        log.info({ action: 'outreach.processor.tick.start' }, 'tick start')
        const tickStart = performance.now()
        const result = await processOutreachSequences()
        await markCompletedCampaigns()
        const latencyMs = Math.round(performance.now() - tickStart)
        recordTick(latencyMs)
        const payload = { action: 'outreach.processor.tick.complete', latencyMs, ...result }
        if (latencyMs > OUTREACH_PROCESSOR_SLOW_MS) {
            log.warn({ ...payload, action: 'outreach.processor.tick.slow', threshold: OUTREACH_PROCESSOR_SLOW_MS }, 'processor tick exceeded slow threshold')
        } else {
            log.info(payload, 'tick complete')
        }
    })
}

export async function markCompletedCampaigns(): Promise<void> {
    const terminalStatuses = sql.join(
        TERMINAL_CAMPAIGN_LEAD_STATUSES.map((status) => sql`${status}`),
        sql`, `,
    )
    const completedAt = new Date()
    const updated = rowsOf<{ id: string }>(await db.execute(sql`
        UPDATE campaigns AS campaign
        SET status = 'completed',
            completed_at = ${completedAt},
            updated_at = ${completedAt}
        WHERE campaign.status = 'active'
          AND EXISTS (
              SELECT 1 FROM campaign_leads
              WHERE campaign_leads.campaign_id = campaign.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM campaign_leads
              WHERE campaign_leads.campaign_id = campaign.id
                AND campaign_leads.completed_at IS NULL
                AND campaign_leads.status NOT IN (${terminalStatuses})
          )
        RETURNING campaign.id
    `))
    if (updated.length === 0) return
    log.info({
        action: 'outreach.processor.campaigns_completed',
        count: updated.length,
        campaignIds: updated.map((campaign) => campaign.id),
    }, 'marked campaigns completed')
}
