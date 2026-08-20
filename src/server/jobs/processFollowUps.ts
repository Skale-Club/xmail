/**
 * Autonomous AI follow-up processor (Phase 23 AI-03/04).
 *
 * RETIRES the legacy direct-send path. The old job scanned `campaign_leads.next_follow_up_at`, asked
 * a decider, and called the shared outreach dispatcher DIRECTLY — bypassing organization/campaign
 * autonomy enablement, durable audit, leases, full reply bodies, and the single policy-gated executor.
 *
 * This job now has exactly one delivery path and zero direct sends:
 *   1. It claims AUDITED, LEASED autonomous runs from `outreach_ai_runs` (scheduled by processReplies
 *      when effective org+campaign autonomy is enabled) and processes each through the SINGLE
 *      `executeInboxSendCommand` executor via the runtime. It imports NO provider adapter and never
 *      calls the low-level threaded sender or the shared dispatcher.
 *   2. It DRAINS the legacy `next_follow_up_at` queue WITHOUT sending. The column is now a rollout
 *      compatibility artifact; leaving it armed would only block campaign completion (which counts an
 *      armed agentic follow-up as pending work). A campaign now earns an autonomous follow-up ONLY via
 *      the new opt-in flags (org `autonomous_enabled` + campaign `ai_autonomous_enabled`), never the
 *      legacy `agentic_followup_enabled` boolean alone.
 */

import { and, isNotNull, lte } from 'drizzle-orm'
import { db } from '../../db'
import { campaignLeads } from '../../db/schema'
import { createLogger } from '../lib/logger'
import { runWithLock } from '../lib/cron-lock'
import { processDueAutonomousRuns, type ProcessAutonomousRunsResult } from '../lib/inbox-ai-automation-runtime'

const log = createLogger('outreach.followup')

export interface FollowUpsResult {
    autonomous: ProcessAutonomousRunsResult
    /** Legacy `next_follow_up_at` rows cleared this tick (no send). */
    legacyDrained: number
}

/**
 * Process due autonomous AI runs and drain the retired legacy follow-up queue. No email is ever sent
 * from this function directly — every send is a durable command dispatched by the single executor.
 */
export async function processFollowUps(): Promise<FollowUpsResult> {
    const autonomous = await processDueAutonomousRuns()
    const legacyDrained = await drainLegacyFollowUps()
    return { autonomous, legacyDrained }
}

/**
 * Clear any DUE legacy `next_follow_up_at` without sending. The direct-send path is gone; an armed
 * column would only keep an agentic campaign from completing. This is the inert successor to the old
 * "send or clear" branch — it can now only clear.
 */
async function drainLegacyFollowUps(): Promise<number> {
    const now = new Date()
    const cleared = await db
        .update(campaignLeads)
        .set({ nextFollowUpAt: null, updatedAt: now })
        .where(and(isNotNull(campaignLeads.nextFollowUpAt), lte(campaignLeads.nextFollowUpAt, now)))
        .returning({ id: campaignLeads.id })
    return cleared.length
}

// Stable advisory-lock name — renaming would let old/new instances overlap during a rollout.
const FOLLOWUP_PROCESSOR_LOCK_NAME = 'outreach-followups-processor'

export async function runFollowUpsProcessorWithLock(): Promise<void> {
    // jobs/index.ts schedules this every 10 minutes — the same as cron-lock's default budget.
    // 8 minutes leaves a margin so the lock reliably clears before the next scheduled tick instead
    // of racing it.
    await runWithLock(FOLLOWUP_PROCESSOR_LOCK_NAME, async () => {
        const result = await processFollowUps()
        if (result.autonomous.claimable > 0 || result.legacyDrained > 0) {
            log.info({
                action: 'outreach.followup.tick.complete',
                ...result.autonomous,
                legacyDrained: result.legacyDrained,
            }, 'autonomous AI follow-up tick complete')
        }
    }, { timeoutMs: 8 * 60 * 1000 })
}
