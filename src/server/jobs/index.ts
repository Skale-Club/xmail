import cron from 'node-cron'
import { processQueue } from './processQueue'
import { processHeldMessages } from './processHeld'
import { cleanupOldMessages } from './cleanupMessages'
import { runOutreachProcessorWithLock, resetDailyLimits } from './processOutreachSequences'
import { runRepliesProcessorWithLock } from './processReplies'
import { runBouncesProcessorWithLock } from './processBounces'
import { runFollowUpsProcessorWithLock } from './processFollowUps'
import { runMaterializerWithLock } from './materializeUnifiedInbox'
import { runInboxCommandsWithLock } from './processInboxCommands'
import { cleanupExpiredAttachments } from '../lib/inbox-attachments'
import { logAutonomousAutomationStatus } from '../lib/inbox-ai-automation-runtime'
import { runOutreachEventDeliveryWithLock } from './deliverOutreachEvents'
import { runOutreachEventReconciliationWithLock } from './reconcileOutreachEvents'
import { runDeliverabilityGuardrailsWithLock } from './enforceDeliverabilityGuardrails'
import { runApprovalExpiryWithLock } from './expireOutreachApprovals'

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

    // Process autonomous AI follow-ups every 10 minutes (advisory-locked). Phase 23 (AI-03/04)
    // retired the legacy direct-send path: this cadence now claims audited, leased autonomous runs
    // from outreach_ai_runs and dispatches each ONLY through the single executeInboxSendCommand
    // executor (Phase 18 policy-gated), and drains the inert legacy next_follow_up_at queue. It is
    // inert unless BOTH the organization AND the campaign have opted into autonomy and neither is
    // paused.
    cron.schedule('*/10 * * * *', () => {
        runFollowUpsProcessorWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processFollowUps_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processFollowUps failed')
        })
    })

    // Materialize staged provider events into the Unified Inbox every 5 minutes. Runs AFTER
    // the reply/bounce staging cadence and consumes the same durable events through the
    // dedicated, independent materialization lifecycle (never touches processed_at). The
    // named advisory lock inside runMaterializerWithLock makes overlapping ticks a no-op.
    cron.schedule('*/5 * * * *', () => {
        runMaterializerWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.materializeUnifiedInbox_failed',
                error: { message: e.message, stack: e.stack },
            }, 'materializeUnifiedInbox failed')
        })
    })

    // Phase 22 — claim + dispatch due Unified Inbox send commands and notify due reminders every
    // minute. The advisory lock inside runInboxCommandsWithLock makes overlapping ticks a no-op;
    // leased claims + a stable idempotency key make dispatch restart-safe and at-most-once.
    cron.schedule('* * * * *', () => {
        runInboxCommandsWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.processInboxCommands_failed',
                error: { message: e.message, stack: e.stack },
            }, 'processInboxCommands failed')
        })
    })

    // Phase 29: stop active campaigns when statistically meaningful 24h bounce/unsubscribe
    // rates cross the organization's configured circuit-breaker thresholds.
    cron.schedule('*/10 * * * *', () => {
        runDeliverabilityGuardrailsWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.deliverabilityGuard_failed',
                error: { message: e.message, stack: e.stack },
            }, 'deliverability guard failed')
        })
    })

    cron.schedule('*/5 * * * *', () => {
        runApprovalExpiryWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({ action: 'outreach.jobs.approvalExpiry_failed', error: { message: e.message, stack: e.stack } }, 'approval expiry failed')
        })
    })

    cron.schedule('*/5 * * * *', () => {
        runOutreachEventReconciliationWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.reconcileOutreachEvents_failed',
                error: { message: e.message, stack: e.stack },
            }, 'reconcileOutreachEvents failed')
        })
    })

    // Phase 26 — durable Xphere adapter. Domain events are committed to the outbox by their
    // producers; this retrying consumer is independent from Hermes polling.
    cron.schedule('* * * * *', () => {
        runOutreachEventDeliveryWithLock().catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err))
            log.error({
                action: 'outreach.jobs.deliverOutreachEvents_failed',
                error: { message: e.message, stack: e.stack },
            }, 'deliverOutreachEvents failed')
        })
    })

    // Phase 22 — storage hygiene: prune abandoned Unified Inbox attachment uploads (expired
    // intents AND never-bound `ready` orphans) daily so their objects don't leak in the private
    // bucket. Global reaper (no org scope needed); the isNull(sendCommandId) + 24h TTL guard keeps
    // any in-flight compose→bind window safe.
    cron.schedule('30 3 * * *', () => {
        cleanupExpiredAttachments()
            .then((removed) => {
                if (removed > 0) log.info({ action: 'outreach.jobs.cleanupInboxAttachments_removed', removed }, 'pruned abandoned inbox attachments')
            })
            .catch((err) => {
                const e = err instanceof Error ? err : new Error(String(err))
                log.error({
                    action: 'outreach.jobs.cleanupInboxAttachments_failed',
                    error: { message: e.message, stack: e.stack },
                }, 'cleanupInboxAttachments failed')
            })
    })

    log.info({
        action: 'outreach.jobs.scheduler_ready',
        schedule: 'processQueue=1min, processHeld=5min, cleanup=daily-3am, outreach=5min, resetLimits=daily-midnight-UTC, dailyDigest=09:00-UTC, replies=15min, bounces=30min, deliverabilityGuard=10min, approvalExpiry=5min, followups=10min, unifiedInbox=5min, inboxCommands=1min, outreachEvents=1min, eventReconciliation=5min, cleanupInboxAttachments=daily-3:30am',
    }, 'scheduler ready')

    // Phase 23 (AI-03): log the GLOBAL autonomous-automation kill-control posture once at startup
    // (enabled/disabled/paused org counts only — never any tenant content). Best-effort.
    logAutonomousAutomationStatus().catch(() => { /* status logging is best-effort */ })
}
