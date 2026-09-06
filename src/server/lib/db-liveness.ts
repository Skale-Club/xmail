/**
 * Database liveness watchdog — the piece that would have ended the 2026-09-01 outage in five
 * minutes instead of ten hours.
 *
 * ## What happened
 *
 * From 20:04 UTC on 2026-09-01 the external probe reported `/health/ready → 000` (curl gave up
 * after 25 s with no response at all) while the SMTP and IMAP ports on the SAME process kept
 * answering. The process was alive; the event loop was fine. Every query against Postgres had
 * simply stopped returning: every cron job overran its cron-lock budget at the same time
 * (`reconcileOutreachEvents` is one SQL statement; `outreach-followups-processor` is one SELECT
 * on a tiny table), fresh connections failed to `BEGIN`, and `/health/ready`'s own `select 1`
 * queued behind twenty hung connections forever. Nothing in the process restarts it for that:
 * a hang throws nothing, Docker only restarts on exit, and `restart: unless-stopped` never sees
 * a health check. The outage ended at 06:35 UTC only because an UNRELATED uncaught exception
 * (an IMAP socket timeout, now fixed in lib/imap-client.ts) happened to kill the process, and
 * the fresh process got fresh connections.
 *
 * ## What this does
 *
 * Every `intervalMs` it runs `select 1` through the SAME pool the application uses, bounded by
 * `probeTimeoutMs`. A wedged pool and an unreachable database both fail this probe; the
 * distinction does not change the remedy. After `exitAfterMs` of continuous failure it logs a
 * fatal line, pushes one Telegram alert (bounded, and with the credential lookup itself bounded
 * so the alert cannot hang on the very database that is down), and exits non-zero so Docker
 * restarts the container. A restart loop during a genuine Supabase outage is the accepted
 * cost: it is loud, the readiness probe reports 503 correctly in between, and a mail server
 * that cannot reach its database is not serving anyone by staying up.
 *
 * Alerts on the way down (after two consecutive failures, so a single slow probe stays quiet)
 * and once on recovery, through the same `reportOpsCondition` de-duplication as every other
 * ops condition.
 *
 * `DB_LIVENESS_EXIT_AFTER_MS=0` keeps the probe and the alerts but disables the exit.
 */
import { queryClient } from '../../db'
import { createLogger } from './logger'
import { alertOps, reportOpsCondition } from './ops-alert'
import { escapeHtml } from './html-escape'
import { withTimeout } from './with-timeout'

const log = createLogger('db.liveness')

function envMs(name: string, fallback: number): number {
    const raw = process.env[name]
    if (raw == null || raw === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

export const DEFAULT_DB_LIVENESS_INTERVAL_MS = envMs('DB_LIVENESS_INTERVAL_MS', 30_000)
export const DEFAULT_DB_LIVENESS_PROBE_TIMEOUT_MS = envMs('DB_LIVENESS_PROBE_TIMEOUT_MS', 15_000)
export const DEFAULT_DB_LIVENESS_EXIT_AFTER_MS = envMs('DB_LIVENESS_EXIT_AFTER_MS', 5 * 60_000)

/** Consecutive failed probes before the condition is reported (not exited on). */
const ALERT_AFTER_FAILURES = 2

export interface DbLivenessOptions {
    intervalMs?: number
    probeTimeoutMs?: number
    /** 0 disables the exit; the probe and alerts still run. */
    exitAfterMs?: number
    /** Test seams. */
    probe?: () => Promise<unknown>
    exit?: (code: number) => void
    now?: () => number
    report?: typeof reportOpsCondition
    alert?: typeof alertOps
}

export interface DbLivenessWatchdog {
    /** Runs one probe now. Exposed for tests; the interval calls it on its own. */
    tick(): Promise<void>
    stop(): void
    /** Diagnostics. */
    state(): { failingSince: number | null; consecutiveFailures: number }
}

async function defaultProbe(): Promise<unknown> {
    return queryClient`select 1`
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000)
    if (seconds < 90) return `${seconds}s`
    return `${Math.round(seconds / 60)}min`
}

export function startDbLivenessWatchdog(options: DbLivenessOptions = {}): DbLivenessWatchdog {
    const intervalMs = options.intervalMs ?? DEFAULT_DB_LIVENESS_INTERVAL_MS
    const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_DB_LIVENESS_PROBE_TIMEOUT_MS
    const exitAfterMs = options.exitAfterMs ?? DEFAULT_DB_LIVENESS_EXIT_AFTER_MS
    const probe = options.probe ?? defaultProbe
    const exit = options.exit ?? ((code: number) => process.exit(code))
    const now = options.now ?? Date.now
    const report = options.report ?? reportOpsCondition
    const alert = options.alert ?? alertOps

    let failingSince: number | null = null
    let consecutiveFailures = 0
    let inFlight = false
    let exiting = false
    let timer: ReturnType<typeof setInterval> | undefined

    async function tick(): Promise<void> {
        if (inFlight || exiting) return
        inFlight = true
        try {
            const startedAt = now()
            try {
                await withTimeout(probe(), probeTimeoutMs, 'database liveness probe')
            } catch (err) {
                await onFailure(err, startedAt)
                return
            }
            await onSuccess(startedAt)
        } finally {
            inFlight = false
        }
    }

    async function onSuccess(at: number): Promise<void> {
        if (failingSince === null) return
        const downFor = at - failingSince
        const hadAlerted = consecutiveFailures >= ALERT_AFTER_FAILURES
        log.info({
            action: 'db.liveness.recovered',
            downForMs: downFor,
            failedProbes: consecutiveFailures,
        }, 'database is answering again')
        failingSince = null
        consecutiveFailures = 0
        if (hadAlerted) {
            await report('db.unreachable', false, {
                failTitle: '',
                okTitle: '✅ <b>Xmail can reach its database again</b>',
                okBody: `Queries were failing or hanging for ${escapeHtml(formatDuration(downFor))}.`,
            }).catch(() => { /* alerting is best-effort */ })
        }
    }

    async function onFailure(err: unknown, at: number): Promise<void> {
        const error = err instanceof Error ? err : new Error(String(err))
        if (failingSince === null) failingSince = at
        consecutiveFailures += 1
        const downFor = at - failingSince

        log.warn({
            action: 'db.liveness.probe_failed',
            consecutiveFailures,
            downForMs: downFor,
            exitAfterMs,
            error: { message: error.message, code: (error as { code?: unknown }).code ?? null },
        }, 'database liveness probe failed')

        if (consecutiveFailures === ALERT_AFTER_FAILURES) {
            // Not awaited past its own bound: the credential lookup inside is timeboxed, but the
            // alert must never be what keeps the watchdog from reaching its exit decision.
            void report('db.unreachable', true, {
                failTitle: '🛑 <b>Xmail cannot reach its database</b>',
                failBody: [
                    `<b>${escapeHtml(error.name)}:</b> ${escapeHtml(error.message)}`,
                    '',
                    exitAfterMs > 0
                        ? `<i>Every query is failing or hanging. If this persists for ${escapeHtml(formatDuration(exitAfterMs))} the process exits so Docker restarts it with fresh connections — the 2026-09-01 outage lasted ten hours because nothing did.</i>`
                        : '<i>Every query is failing or hanging. Automatic restart is disabled (DB_LIVENESS_EXIT_AFTER_MS=0).</i>',
                ].join('\n'),
                okTitle: '✅ <b>Xmail can reach its database again</b>',
            }).catch(() => { /* alerting is best-effort */ })
        }

        if (exitAfterMs > 0 && downFor >= exitAfterMs) {
            await exitForRestart(error, downFor)
        }
    }

    async function exitForRestart(error: Error, downFor: number): Promise<void> {
        exiting = true
        stop()
        console.error(
            `[fatal] database unreachable for ${formatDuration(downFor)} (${consecutiveFailures} consecutive failed probes; last: ${error.message}) — exiting so Docker restarts the container with fresh connections`,
        )
        // Same bound as the crash handler: a hung network must not turn a restart into a hang.
        await withTimeout(
            alert(
                'db.unreachable_restart',
                '♻️ <b>Xmail is restarting itself</b>',
                [
                    `The database has been unreachable for <b>${escapeHtml(formatDuration(downFor))}</b> (${consecutiveFailures} consecutive failed probes).`,
                    '',
                    `<b>Last error:</b> ${escapeHtml(error.message)}`,
                    '',
                    '<i>Exiting so Docker restarts the container. If the external uptime probe goes green afterwards, the pool was wedged and the restart fixed it. If this repeats every few minutes, the database itself is down — check status.supabase.com.</i>',
                ].join('\n'),
            ),
            5_000,
            'restart alert',
        ).catch(() => { /* never block the exit on the alert */ })
        exit(1)
    }

    function stop(): void {
        if (timer) {
            clearInterval(timer)
            timer = undefined
        }
    }

    timer = setInterval(() => { void tick() }, intervalMs)
    // Never the reason the process stays alive (tests, scripts, graceful shutdown).
    timer.unref?.()

    log.info({
        action: 'db.liveness.started',
        intervalMs,
        probeTimeoutMs,
        exitAfterMs,
    }, exitAfterMs > 0
        ? 'database liveness watchdog armed — the process restarts itself after sustained database unreachability'
        : 'database liveness watchdog armed (alert only; self-restart disabled)')

    return {
        tick,
        stop,
        state: () => ({ failingSince, consecutiveFailures }),
    }
}
