import cron from 'node-cron'
import { processQueue } from './processQueue'
import { processHeldMessages } from './processHeld'
import { cleanupOldMessages } from './cleanupMessages'
import { runOutreachProcessorWithLock, resetDailyLimits } from './processOutreachSequences'
import { processReplies } from './processReplies'
import { processBounces } from './processBounces'

import { dailyOutreachDigest } from './dailyOutreachDigest'
import { createLogger } from '../lib/logger'

const log = createLogger('outreach.jobs')

// P0-06: the previous in-memory mutex was removed in plan 14-06. It only protected
// within a single Node process; multi-instance deploys (blue-green overlap, future
// horizontal scale) could still double-send. The DB-level lock now lives inside
// runOutreachProcessorWithLock — see processOutreachSequences.ts.
//
// TODO(phase-15): also wrap processReplies and processBounces in advisory locks
//   (LOCK_ID_REPLY_PROCESSOR = 4016 / LOCK_ID_BOUNCE_PROCESSOR = 4015 — same pattern
//   as outreach). Lower priority because both jobs are already idempotent at the
//   per-message level.

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

    // Process outreach sequences every 5 minutes (advisory-locked at the DB layer)
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
    //   docker logs skaleclub-mail 2>&1 | jq 'select(.action=="outreach.digest.daily")'
    cron.schedule('0 9 * * *', () => {
        dailyOutreachDigest().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.dailyOutreachDigest_failed',
                error: { message: e.message, stack: e.stack },
            }, 'dailyOutreachDigest failed')
        })
    }, { timezone: 'UTC' })

    // Process replies every 15 minutes
    cron.schedule('*/15 * * * *', () => {
        processReplies().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processReplies_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processReplies failed')
        })
    })

    // Process bounces every 30 minutes
    cron.schedule('*/30 * * * *', () => {
        processBounces().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processBounces_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processBounces failed')
        })
    })

    log.info({
        action: 'outreach.jobs.scheduler_ready',
        schedule: 'processQueue=1min, processHeld=5min, cleanup=daily-3am, outreach=5min, resetLimits=daily-midnight-UTC, dailyDigest=09:00-UTC, replies=15min, bounces=30min',
    }, 'scheduler ready')
}
