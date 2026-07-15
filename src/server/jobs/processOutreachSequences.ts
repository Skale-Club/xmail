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
import { performance } from 'node:perf_hooks'
import { db } from '../../db'
import { campaigns, sequenceSteps, campaignLeads, leads, emailAccounts, outreachEmails, suppressions } from '../../db/schema'
import { eq, and, lte, inArray, notInArray, sql } from 'drizzle-orm'
import {
    sendOutreachEmail,
    isWithinSendWindow,
    canSendFromAccount,
    getEffectiveDailySendLimit,
    incrementAccountStats,
    incrementCampaignStats,
    applySendJitter,
} from '../lib/outreach-sender'
import { generateOutreachToken } from '../lib/outreach-tokens'
import { createLogger, OUTREACH_PROCESSOR_SLOW_MS } from '../lib/logger'
import { sendXphereOutreachEvent } from '../lib/xphere-events'
import { runWithLock } from '../lib/cron-lock'

const log = createLogger('outreach.processor')

// Phase 17-02 — In-memory ring buffer of the last N processor tick latencies (ms).
// Plan 17-03's health endpoint consumes this via getRecentTickLatencies() to compute
// p50/p95 without needing a DB table. Not durable across restarts (acceptable per
// 17-CONTEXT.md §"Processor tick metrics").
const TICK_HISTORY_SIZE = 100
const tickHistory: number[] = []

function recordTick(latencyMs: number): void {
    tickHistory.push(latencyMs)
    if (tickHistory.length > TICK_HISTORY_SIZE) {
        tickHistory.shift()
    }
}

/**
 * Phase 17 — exposes the last 100 processor tick latencies (ms) for the
 * health endpoint to compute p50/p95. In-memory ring buffer; not durable
 * across restarts (acceptable per 17-CONTEXT.md §"Processor tick metrics").
 */
export function getRecentTickLatencies(): readonly number[] {
    return tickHistory.slice()
}

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

    const scheduleProbe = {
        timezone,
        sendStartTime,
        sendEndTime,
        sendOnWeekends,
    } as typeof campaigns.$inferSelect

    for (let i = 0; i < 14 * 48; i++) {
        if (isWithinSendWindow(scheduleProbe, next)) {
            return next
        }
        next.setMinutes(next.getMinutes() + 30)
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

// Phase 16 — standardized skip-reason log shape. Phase 17-02 promoted the carrier
// to pino structured logging; the enumerated `reason` values are preserved so ops
// dashboards can pivot by reason without re-mapping.
type SkipReason =
    | 'rate_limit_per_inbox'
    | 'daily_limit_reached'
    | 'suppression'
    | 'no_active_step'
    | 'outside_send_window'
    | 'claim_conflict'
    | 'unsubscribed'
    | 'campaign_inactive'
    | 'campaign_not_found'
    | 'lead_not_found'
    | 'no_account'
    | 'account_not_verified'
    | 'in_batch_duplicate'

function logSkip(reason: SkipReason, ctx: {
    campaignId?: string
    leadId?: string
    campaignLeadId?: string
    emailAccountId?: string
    extra?: Record<string, unknown>
}): void {
    log.info({
        action: 'outreach.send.skipped',
        reason,
        campaignId: ctx.campaignId,
        leadId: ctx.leadId,
        campaignLeadId: ctx.campaignLeadId,
        emailAccountId: ctx.emailAccountId,
        ...(ctx.extra ?? {}),
    }, `send skipped: ${reason}`)
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
    // audit-2026-07 (H4/#2): suppressions are written lowercased (unsubscribe.ts, processBounces.ts)
    // but lead emails are stored as-entered (mixed case), so a case-insensitive comparison is
    // required or an unsubscribed/bounced address re-imported with different casing gets mailed
    // again (CAN-SPAM/GDPR). Normalize both sides of the key to lowercase.
    const suppressedSet = new Set(allSuppressions.map(s => `${s.organizationId}:${s.emailAddress.toLowerCase()}`))

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

    // audit-2026-07 (SEND-BURST / C1): the batch query loads a SEPARATE assignedEmailAccount
    // snapshot per lead, so incrementing an account's currentDailySent / lastSentAt in the DB
    // after a send was invisible to the other 199 leads' stale copies — the whole daily-limit,
    // warmup and min-spacing gate was only enforced at tick boundaries, letting a single tick
    // fire an entire inbox's backlog back-to-back. Collapse to one canonical object per inbox so
    // in-tick increments (below) are seen by every subsequent lead sharing that inbox.
    const accountByIdInTick = new Map<string, typeof emailAccounts.$inferSelect>()
    for (const cl of pendingLeads) {
        const acct = cl.assignedEmailAccount
        if (acct && !accountByIdInTick.has(acct.id)) {
            accountByIdInTick.set(acct.id, acct)
        }
    }

    for (const campaignLead of pendingLeads) {
        result.processed++

        try {
            // Skip leads whose next send was pushed into the future earlier in THIS tick
            // (the per-inbox jitter reschedule below). They are picked up on a later tick.
            if (campaignLead.nextScheduledAt && campaignLead.nextScheduledAt.getTime() > now.getTime()) {
                continue
            }
            const campaign = campaignsMap.get(campaignLead.campaignId)
            if (!campaign) {
                logSkip('campaign_not_found', { campaignId: campaignLead.campaignId, campaignLeadId: campaignLead.id })
                result.errors++
                continue
            }

            if (campaign.status !== 'active') {
                logSkip('campaign_inactive', { campaignId: campaign.id, campaignLeadId: campaignLead.id })
                continue
            }

            const lead = campaignLead.lead
            if (!lead) {
                logSkip('lead_not_found', { campaignId: campaign.id, campaignLeadId: campaignLead.id })
                result.errors++
                continue
            }

            if (lead.unsubscribedAt) {
                logSkip('unsubscribed', { campaignId: campaign.id, leadId: lead.id, campaignLeadId: campaignLead.id })
                await db.update(campaignLeads)
                    .set({ status: 'unsubscribed', nextScheduledAt: null })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }

            const isSuppressed = suppressedSet.has(`${campaign.organizationId}:${lead.email.toLowerCase()}`)
            if (isSuppressed) {
                logSkip('suppression', { campaignId: campaign.id, leadId: lead.id, campaignLeadId: campaignLead.id })
                await db.update(campaignLeads)
                    .set({ status: 'bounced', nextScheduledAt: null })
                    .where(eq(campaignLeads.id, campaignLead.id))
                continue
            }

            if (!isWithinSendWindow(campaign, now)) {
                logSkip('outside_send_window', { campaignId: campaign.id, leadId: lead.id, campaignLeadId: campaignLead.id })
                continue
            }

            const emailAccount = campaignLead.assignedEmailAccountId
                ? accountByIdInTick.get(campaignLead.assignedEmailAccountId) ?? campaignLead.assignedEmailAccount
                : campaignLead.assignedEmailAccount
            if (!emailAccount) {
                logSkip('no_account', { campaignId: campaign.id, leadId: lead.id, campaignLeadId: campaignLead.id })
                result.errors++
                continue
            }

            if (emailAccount.status !== 'verified') {
                logSkip('account_not_verified', { campaignId: campaign.id, emailAccountId: emailAccount.id, campaignLeadId: campaignLead.id })
                result.errors++
                continue
            }

            // Phase 16 — INBOX-THROTTLE wire. canSendFromAccount(account, now) was extended
            // in Plan 16-01 to check (lastSentAt + minMinutesBetweenEmails*60s > now).
            // We discriminate the cause to emit the correct skip reason for ops visibility.
            if (!canSendFromAccount(emailAccount, now)) {
                const effectiveDailyLimit = getEffectiveDailySendLimit(emailAccount)
                if (emailAccount.currentDailySent >= effectiveDailyLimit) {
                    logSkip('daily_limit_reached', {
                        campaignId: campaign.id,
                        emailAccountId: emailAccount.id,
                        campaignLeadId: campaignLead.id,
                        extra: {
                            currentDailySent: emailAccount.currentDailySent,
                            dailySendLimit: emailAccount.dailySendLimit,
                            effectiveDailyLimit,
                            warmupEnabled: emailAccount.warmupEnabled,
                            warmupCurrentDay: emailAccount.warmupCurrentDay,
                            warmupDays: emailAccount.warmupDays,
                        },
                    })
                } else {
                    // Implied cause: lastSentAt + min*60s > now (the only other branch in canSendFromAccount).
                    logSkip('rate_limit_per_inbox', {
                        campaignId: campaign.id,
                        emailAccountId: emailAccount.id,
                        campaignLeadId: campaignLead.id,
                        extra: {
                            minMinutesBetweenEmails: emailAccount.minMinutesBetweenEmails,
                            lastSentAt: emailAccount.lastSentAt?.toISOString() ?? null,
                        },
                    })
                }
                continue
            }

            const currentStep = campaignLead.currentStep
            if (!currentStep) {
                logSkip('no_active_step', { campaignId: campaign.id, leadId: lead.id, campaignLeadId: campaignLead.id })
                result.errors++
                continue
            }

            // P0-05 idempotency-first: the in-memory guard catches duplicates within the
            // current batch; the ON CONFLICT DO NOTHING below is the DB-level guard that
            // survives process crashes and multi-instance races (in addition to the advisory
            // lock from Task 3 of plan 14-06).
            if (existingEmailsSet.has(`${campaignLead.id}:${currentStep.id}`)) {
                logSkip('in_batch_duplicate', { campaignId: campaign.id, campaignLeadId: campaignLead.id, extra: { sequenceStepId: currentStep.id } })
                continue
            }

            const abVariant = selectAbVariant(currentStep, lead.id)

            // Generate the HMAC tracking token up-front so the placeholder row has the NOT NULL value
            // AND the same token is passed to sendOutreachEmail so the URL-embedded token matches
            // the persisted one. Without this contract, track.ts lookups silently miss (Phase 15.1 fix).
            const trackingToken = generateOutreachToken({ kind: 'track', clid: campaignLead.id, cid: campaign.id })

            // Claim the (campaignLeadId, sequenceStepId) slot. The unique index
            // outreach_emails_campaign_lead_step_unique guarantees that only one INSERT wins.
            // Concurrent workers (or a re-tick after crash) see 0 rows returned → we skip
            // without sending. Status='queued' is used as the claim marker (the enum has no
            // 'sending' value — Plan 14-06 deviation Rule 1: enum does not include 'sending',
            // so we map sending→queued semantically).
            const claim = await db.insert(outreachEmails).values({
                organizationId: campaign.organizationId,
                campaignId: campaign.id,
                campaignLeadId: campaignLead.id,
                sequenceStepId: currentStep.id,
                emailAccountId: emailAccount.id,
                subject: currentStep.subject || '',
                plainBody: currentStep.plainBody ?? null,
                htmlBody: null,     // populated post-send with sendResult.finalHtml
                abVariant,
                trackingToken,
                status: 'queued',
                // sentAt deliberately NULL — set on successful send
            }).onConflictDoNothing({ target: [outreachEmails.campaignLeadId, outreachEmails.sequenceStepId] }).returning({ id: outreachEmails.id })

            if (claim.length === 0) {
                logSkip('claim_conflict', { campaignId: campaign.id, campaignLeadId: campaignLead.id, extra: { sequenceStepId: currentStep.id } })
                continue
            }

            const claimedEmailId = claim[0].id

            const trackingBaseUrl = process.env.FRONTEND_URL || 'http://localhost:9000'
            const sendResult = await sendOutreachEmail({
                account: emailAccount,
                lead,
                campaign,
                step: currentStep,
                campaignLeadId: campaignLead.id,
                trackingToken,
                trackOpens: campaign.trackOpens,
                trackClicks: campaign.trackClicks,
                trackingBaseUrl,
                abVariant,
            })

            if (!sendResult.success) {
                log.error({
                    action: 'outreach.send.failed',
                    campaignId: campaign.id,
                    leadId: lead.id,
                    campaignLeadId: campaignLead.id,
                    emailAccountId: emailAccount.id,
                    error: { message: sendResult.error || 'Unknown send error' },
                }, 'send failed')
                await db.update(outreachEmails)
                    .set({
                        status: 'failed',
                        bounceReason: (sendResult.error || 'Unknown send error').slice(0, 500),
                        updatedAt: new Date(),
                    })
                    .where(eq(outreachEmails.id, claimedEmailId))
                result.errors++
                continue
            }

            // audit-2026-07 (H2/#10): nodemailer returns messageId bracketed (`<id@host>`), but
            // the reply processor strips brackets from incoming In-Reply-To/References and does an
            // exact-match lookup — so a bracketed stored value never matched and stop-on-reply
            // silently degraded to the address heuristic. Persist the normalized (unbracketed) id.
            const normalizedMessageId = sendResult.messageId
                ? sendResult.messageId.replace(/[<>]/g, '').trim()
                : null

            // Update the claimed row to reflect successful send.
            await db.update(outreachEmails)
                .set({
                    status: 'sent',
                    messageId: normalizedMessageId,
                    htmlBody: sendResult.finalHtml ?? null,
                    sentAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(outreachEmails.id, claimedEmailId))

            sendXphereOutreachEvent('sent', {
                email: lead.email,
                campaign_id: campaign.id,
                lead_id: lead.id,
                customFields: lead.customFields,
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
            // and also sets emailAccounts.lastSentAt = NOW() so the next canSendFromAccount call
            // for this inbox returns false until minMinutesBetweenEmails has elapsed.
            //
            // audit-2026-07 (SEND-BURST / C1): mirror that DB increment into the shared in-tick
            // snapshot so the daily-limit and min-spacing checks (canSendFromAccount) for the NEXT
            // lead on this inbox see the updated counter and lastSentAt WITHIN this same tick.
            emailAccount.currentDailySent += 1
            emailAccount.lastSentAt = new Date()

            // Phase 16 — INBOX-THROTTLE: spread out the NEXT pending lead on the same inbox
            // so it doesn't become eligible at the same tick. Find the next eligible lead
            // in this batch sharing this emailAccountId; jitter its nextScheduledAt by a
            // random number of minutes in [min, max). No extra query — we walk the batch
            // we already loaded at line 81.
            const sameInboxNext = pendingLeads.find(cl =>
                cl.id !== campaignLead.id
                && cl.assignedEmailAccountId === emailAccount.id
                && cl.nextScheduledAt != null
                && cl.nextScheduledAt.getTime() <= now.getTime()
            )
            if (sameInboxNext) {
                const jittered = applySendJitter(
                    emailAccount.minMinutesBetweenEmails,
                    emailAccount.maxMinutesBetweenEmails,
                    new Date(),
                )
                await db.update(campaignLeads)
                    .set({ nextScheduledAt: jittered })
                    .where(eq(campaignLeads.id, sameInboxNext.id))
                // Mutate the in-memory copy so the rest of this tick's loop sees the new schedule.
                sameInboxNext.nextScheduledAt = jittered
                log.debug({
                    action: 'outreach.processor.jitter_next',
                    emailAccountId: emailAccount.id,
                    campaignLeadId: sameInboxNext.id,
                    jitteredAt: jittered.toISOString(),
                }, 'jittered next eligible send')
            }

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
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.processor.lead_exception',
                campaignLeadId: campaignLead.id,
                error: { message: err.message, stack: err.stack },
            }, 'lead processing threw')
            result.errors++
        }
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
    log.info({
        action: 'outreach.processor.reset_daily_limits',
        accountsReset: result.length,
    }, 'reset daily limits')
}

// P0-06 / audit-2026-07: Postgres advisory lock — prevents two container instances (or a
// blue-green deploy overlap) from running the processor concurrently.
//
// Uses runWithLock (src/server/lib/cron-lock.ts), which acquires and releases the advisory
// lock on the SAME reserved postgres-js connection. The previous inline implementation issued
// pg_try_advisory_lock / pg_advisory_unlock via the shared pool (db.execute), so acquire and
// release routinely landed on different sessions: the unlock no-op'd, the lock stranded on the
// acquiring connection, and later ticks were skipped as "contended" while nothing ran (and it
// provided no exclusion at all behind a transaction pooler). See audit findings H1/#8.
//
// Inspect held locks in production: `SELECT * FROM pg_locks WHERE locktype='advisory';`
const OUTREACH_PROCESSOR_LOCK_NAME = 'outreach-sequences-processor'

export async function runOutreachProcessorWithLock(): Promise<void> {
    await runWithLock(OUTREACH_PROCESSOR_LOCK_NAME, async () => {
        log.info({ action: 'outreach.processor.tick.start' }, 'tick start')
        const tickStart = performance.now()
        const result = await processOutreachSequences()
        const latencyMs = Math.round(performance.now() - tickStart)
        recordTick(latencyMs)
        const tickLogPayload = {
            action: 'outreach.processor.tick.complete',
            latencyMs,
            processed: result.processed,
            sent: result.sent,
            errors: result.errors,
        }
        if (latencyMs > OUTREACH_PROCESSOR_SLOW_MS) {
            log.warn({ ...tickLogPayload, action: 'outreach.processor.tick.slow', threshold: OUTREACH_PROCESSOR_SLOW_MS }, 'processor tick exceeded slow threshold')
        } else {
            log.info(tickLogPayload, 'tick complete')
        }
    })
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

    log.info({
        action: 'outreach.processor.campaigns_completed',
        count: completedCampaigns.length,
    }, 'marked campaigns completed')
}
