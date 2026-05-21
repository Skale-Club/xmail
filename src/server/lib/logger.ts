/**
 * Phase 17 — Structured logging for the outreach module.
 *
 * - Production: pure JSON to stdout (Docker captures, ops can `jq` it).
 * - Development: pretty-printed via pino-pretty transport for human eyes.
 * - Log level: env-driven via LOG_LEVEL, defaulting to 'info' in prod and 'debug' in dev.
 *
 * Conventions (enforced by Phase 17-02 callers):
 *   logger.info({ action: 'outreach.<area>.<event>', ...context }, 'human message')
 *
 * The `action` field is the primary grep key. Standard suffixes:
 *   .send.success, .send.failed, .send.skipped
 *   .processor.tick.start, .processor.tick.complete, .processor.tick.slow
 *   .reply.matched, .reply.unmatched, .reply.auto_reply
 *   .bounce.detected, .bounce.suppressed
 *   .unsubscribe.requested, .unsubscribe.completed
 *   .track.open, .track.click
 *   .digest.daily
 */

import pino, { type Logger } from 'pino'

const isDev = process.env.NODE_ENV !== 'production'
const level = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info')

// Production: default JSON serialisation to stdout.
// Development: pretty transport. We use transport (not prettyPrint, which was removed in pino v7+).
export const logger: Logger = pino(
    isDev
        ? {
            level,
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                },
            },
        }
        : {
            level,
            // Production: include hostname (Docker container id) and pid so multi-instance deploys
            // can disambiguate log lines from each replica.
            base: { pid: process.pid, hostname: process.env.HOSTNAME || undefined },
            // Standard pino timestamp (ISO-string) — easier to grep than epoch ms in dev runs.
            timestamp: pino.stdTimeFunctions.isoTime,
            // Pull error.stack into a flat string field instead of pino's default formatter
            // (matches the shape downstream `jq` queries assume).
            formatters: {
                level(label) {
                    return { level: label }
                },
            },
        },
)

/**
 * Create a child logger with a bound `module` field.
 * All downstream outreach files should call this once at module scope:
 *   const log = createLogger('outreach.processor')
 */
export function createLogger(module: string): Logger {
    return logger.child({ module })
}

// -------------------------------------------------------------------------
// Alert thresholds — exported constants so processor, health endpoint, and
// digest job all read the SAME numbers. Single source of truth.
// -------------------------------------------------------------------------

/**
 * Bounce rate over the last 1 hour above which the processor logs WARN.
 * Per 17-CONTEXT.md §"Alert thresholds": 5% in a rolling 1h window is the
 * first signal that a campaign is being rejected at scale.
 */
export const OUTREACH_BOUNCE_WARN_1H = 0.05

/**
 * Bounce rate over the last 24 hours above which the processor logs ERROR
 * and the health endpoint emits a 'critical' alert. Per 17-CONTEXT.md: 10%
 * over 24h is the deliverability cliff (Gmail/Yahoo will start sandboxing
 * the sender). Phase 18+ will wire this to webhook/email notification.
 */
export const OUTREACH_BOUNCE_ERROR_24H = 0.10

/**
 * Processor tick duration in MILLISECONDS above which we log a WARN with
 * action 'outreach.processor.tick.slow'. Per 17-CONTEXT.md: 30s is the cron
 * cadence floor — if a tick takes longer than the time between ticks we
 * risk overlapping work (advisory lock prevents the harm but the symptom
 * is worth alerting on).
 */
export const OUTREACH_PROCESSOR_SLOW_MS = 30_000
