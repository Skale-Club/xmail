import cron from 'node-cron'
import { processQueue } from './processQueue'
import { processHeldMessages } from './processHeld'
import { cleanupOldMessages } from './cleanupMessages'
import { runOutreachProcessorWithLock, resetDailyLimits } from './processOutreachSequences'
import { runRepliesProcessorWithLock } from './processReplies'
import { runBouncesProcessorWithLock } from './processBounces'
import { runFollowUpsProcessorWithLock } from './processFollowUps'

import { dailyOutreachDigest } from './dailyOutreachDigest'
import { createLogger } from '../lib/logger'

const log = createLogger('outreach.jobs')

// P0-06: the previous in-memory mutex was removed in plan 14-06. It only protected
// within a single Node process; multi-instance deploys (blue-green overlap, future
// horizontal scale) could still double-send. The DB-level advisory locks now live inside
// runOutreachProcessorWithLock, runRepliesProcessorWithLock, and runBouncesProcessorWithLock.
// See processOutreachSequences.ts, processReplies.ts, processBounces.ts.
// Lock IDs: outreach=4014, bounces=4015, replies=4016.

export function startJobs(): void {
    log.info({ action: 'outreach.jobs.scheduler_start' }, 'starting background job scheduler')

    // Process email queue every minute
    cron.schedule('* * * * *', () => {
        processQueue().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processQueue_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processQueue failed')
        })
    })

    // Process expired held messages every 5 minutes
    cron.schedule('*/5 * * * *', () => {
        processHeldMessages().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processHeld_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processHeld failed')
        })
    })

    // Cleanup old messages daily at 3 AM
    cron.schedule('0 3 * * *', () => {
        cleanupOldMessages().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.cleanup_failed',
                error: { message: e.message, stack: e.stack },
            }, 'cleanup failed')
        })
    })

    // Process outreach sequences and terminal campaign completion every 5 minutes.
    // Both operations run inside the same advisory-locked tick, including empty due-work ticks.
    cron.schedule('*/5 * * * *', () => {
        runOutreachProcessorWithLock()
            .catch((err) => {
                const e = err instanceof Error ? err : new Error(String(err))
                log.error({
                    action: 'outreach.jobs.processOutreachSequences_failed',
                    error: { message: e.message, stack: e.stack },
                }, 'processOutreachSequences failed')
            })
    })

    // Phase 16 — INBOX-THROTTLE: reset per-account daily send counter at midnight UTC.
    // Explicit timezone option pins the schedule to UTC independently of container TZ env
    // (today alpine defaults to UTC, but pinning here prevents silent breakage if TZ is
    // set by a future ops change). Pair with processOutreachSequences.resetDailyLimits.
    cron.schedule('0 0 * * *', () => {
        resetDailyLimits().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.resetDailyLimits_failed',
                error: { message: e.message, stack: e.stack },
            }, 'resetDailyLimits failed')
        })
    }, { timezone: 'UTC' })

    // Phase 17 — Daily outreach digest at 09:00 UTC. Log-only (no email/slack).
    // Timezone pinned to UTC matching the resetDailyLimits cron above; depends on
    // outreach-metrics.ts aggregate helpers (Plan 17-03). The digest is one log
    // line with action='outreach.digest.daily' — grep with:
    //   docker logs xmail 2>&1 | jq 'select(.action=="outreach.digest.daily")'
    cron.schedule('0 9 * * *', () => {
        dailyOutreachDigest().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.dailyOutreachDigest_failed',
                error: { message: e.message, stack: e.stack },
            }, 'dailyOutreachDigest failed')
        })
    }, { timezone: 'UTC' })

    // Process replies every 15 minutes (advisory-locked at the DB layer)
    cron.schedule('*/15 * * * *', () => {
        runRepliesProcessorWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processReplies_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processReplies failed')
        })
    })

    // Process bounces every 30 minutes (advisory-locked at the DB layer)
    cron.schedule('*/30 * * * *', () => {
        runBouncesProcessorWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processBounces_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processBounces failed')
        })
    })

    // Process agentic follow-ups every 10 minutes (advisory-locked). Inert unless a campaign
    // has agentic_followup_enabled = true (P001/P002).
    cron.schedule('*/10 * * * *', () => {
        runFollowUpsProcessorWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processFollowUps_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processFollowUps failed')
        })
    })

    log.info({
        action: 'outreach.jobs.scheduler_ready',
        schedule: 'processQueue=1min, processHeld=5min, cleanup=daily-3am, outreach=5min, resetLimits=daily-midnight-UTC, dailyDigest=09:00-UTC, replies=15min, bounces=30min, followups=10min',
    }, 'scheduler ready')
}
