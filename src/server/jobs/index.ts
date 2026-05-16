import cron from 'node-cron'
import { processQueue } from './processQueue'
import { processHeldMessages } from './processHeld'
import { cleanupOldMessages } from './cleanupMessages'
import { processOutreachSequences, resetDailyLimits } from './processOutreachSequences'
import { processReplies } from './processReplies'
import { processBounces } from './processBounces'
import { runWithLock } from '../lib/cron-lock'

// SEC-04 — every cron callback is gated by pg_try_advisory_lock for multi-tick
// + multi-instance mutual exclusion. See
// .planning/debug/system-wide-audit-2026-05-16.md (H8) and
// .planning/phases/11-high-security/11-CONTEXT.md.
//
// IMPORTANT: job names below are used as the advisory-lock key. Renaming a job
// after rollout would compute a different key, allowing old- and new-name
// instances to overlap during rolling deploys. Keep names stable.
function schedule(name: string, expression: string, fn: () => Promise<unknown>): void {
    cron.schedule(expression, () => {
        runWithLock(name, fn).catch((err) =>
            console.error(`[jobs] ${name} failed:`, err)
        )
    })
}

export function startJobs(): void {
    console.log('[jobs] Starting background job scheduler...')

    schedule('processQueue',             '* * * * *',     processQueue)
    schedule('processHeldMessages',      '*/5 * * * *',   processHeldMessages)
    schedule('cleanupOldMessages',       '0 3 * * *',     cleanupOldMessages)
    schedule('processOutreachSequences', '*/5 * * * *',   processOutreachSequences)
    schedule('resetDailyLimits',         '0 0 * * *',     resetDailyLimits)
    schedule('processReplies',           '*/15 * * * *',  processReplies)
    schedule('processBounces',           '*/30 * * * *',  processBounces)

    console.log('[jobs] Scheduled: processQueue (1min), processHeld (5min), cleanup (daily 3am), outreach (5min), resetLimits (daily midnight), replies (15min), bounces (30min)')
}
