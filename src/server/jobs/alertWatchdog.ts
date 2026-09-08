/**
 * The in-app half of layer 2: conditions that are only visible from inside,
 * evaluated on a schedule rather than reported by whatever code hit them.
 *
 * Failure-shaped alerts (a cron threw, a request 500'd) already reach Telegram
 * through the error taps. This job covers the other family — states that
 * produce NO error at all and are therefore invisible to every other layer:
 * a queue that quietly stops draining, a process whose memory is climbing
 * toward the OOM killer, a disk filling up, or the outreach/prospecting
 * engine producing nothing at all (see `checkSilence` below). The external
 * HTTP probe stays green through all of it, right up until it abruptly does
 * not.
 *
 * Every check reports through `reportOpsCondition`, so each one alerts on the
 * way down, stays quiet while it remains broken, and sends exactly one recovery
 * message when it clears.
 */
import { and, count, inArray, lt } from 'drizzle-orm'
import { statfs } from 'node:fs/promises'
import { db } from '../../db'
import { messages } from '../../db/schema'
import { reportOpsCondition } from '../lib/ops-alert'
import { createLogger } from '../lib/logger'
import { escapeHtml } from '../lib/telegram'
import { buildSilenceAlerts } from '../lib/outreach-silence'
import { computeSilenceMetrics } from '../lib/outreach-silence-query'


const log = createLogger('ops.watchdog')

/**
 * How long a message may sit unsent before the queue counts as stalled.
 *
 * `processQueue` runs every minute, so anything older than fifteen has missed
 * roughly fifteen consecutive attempts — comfortably past a transient blip
 * (a slow upstream, a redeploy) and clearly not normal operation.
 */
const QUEUE_STALL_MINUTES = Number(process.env.QUEUE_STALL_MINUTES) > 0
    ? Math.floor(Number(process.env.QUEUE_STALL_MINUTES))
    : 15

/** Resident set size, in MB, above which the process is reported as bloated. */
const RSS_WARN_MB = Number(process.env.RSS_WARN_MB) > 0
    ? Math.floor(Number(process.env.RSS_WARN_MB))
    : 1024

/** Filesystem usage percentage that triggers a warning. */
const DISK_WARN_PERCENT = Number(process.env.DISK_WARN_PERCENT) > 0
    ? Math.floor(Number(process.env.DISK_WARN_PERCENT))
    : 85

/**
 * Messages stuck in a pre-send state past the stall window.
 *
 * Deliberately org-agnostic: this is a platform-health check, not tenant data,
 * and it is the one place where a global count is the correct question.
 */
async function checkQueue(): Promise<void> {
    const cutoff = new Date(Date.now() - QUEUE_STALL_MINUTES * 60_000)

    const [row] = await db
        .select({ stuck: count() })
        .from(messages)
        .where(and(inArray(messages.status, ['pending', 'queued']), lt(messages.createdAt, cutoff)))

    const stuck = Number(row?.stuck ?? 0)

    await reportOpsCondition('queue.stalled', stuck > 0, {
        failTitle: '🐌 <b>Xmail outbound queue is stalled</b>',
        failBody: [
            `<b>${stuck}</b> message(s) have been waiting longer than ${QUEUE_STALL_MINUTES} minutes.`,
            '',
            '<i>processQueue runs every minute, so these have missed many consecutive attempts. Nothing errors when the queue simply stops draining — no other layer would report this.</i>',
        ].join('\n'),
        okTitle: '✅ <b>Xmail outbound queue is draining again</b>',
        okBody: 'No messages older than the stall window remain.',
    })
}

/**
 * Process memory.
 *
 * This host is a 4 GB Hetzner box shared with the Hermes sidecar, so headroom
 * is genuinely tight and the OOM killer is a realistic end state. A process
 * killed for memory leaves no exception and no log line — just a restart.
 */
async function checkMemory(): Promise<void> {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024)

    await reportOpsCondition('process.memory', rssMb >= RSS_WARN_MB, {
        failTitle: '🧠 <b>Xmail memory is high</b>',
        failBody: [
            `Resident set size is <b>${rssMb} MB</b> (threshold ${RSS_WARN_MB} MB).`,
            '',
            '<i>The host has 4 GB and is shared with the Hermes sidecar. An OOM kill leaves no exception and no log line — only a restart.</i>',
        ].join('\n'),
        okTitle: '✅ <b>Xmail memory is back to normal</b>',
        okBody: `Resident set size is ${rssMb} MB.`,
    })
}

/**
 * Disk.
 *
 * A full disk breaks Postgres writes, R2 spooling and Docker itself, and it
 * arrives gradually enough that it is always catchable — if anyone is looking.
 */
async function checkDisk(): Promise<void> {
    let usedPercent: number
    try {
        const stats = await statfs('/')
        const total = stats.blocks * stats.bsize
        const free = stats.bfree * stats.bsize
        if (!total) return
        usedPercent = Math.round(((total - free) / total) * 100)
    } catch (err) {
        // statfs is unavailable on some platforms (notably Windows dev boxes).
        // Not being able to check is not the same as being unhealthy.
        log.debug({ action: 'ops.watchdog.disk_unavailable', error: String(err) }, 'statfs unavailable')
        return
    }

    await reportOpsCondition('host.disk', usedPercent >= DISK_WARN_PERCENT, {
        failTitle: '💾 <b>Xmail disk is filling up</b>',
        failBody: [
            `Filesystem at <b>${usedPercent}%</b> (threshold ${DISK_WARN_PERCENT}%).`,
            '',
            '<i>A full disk stops Postgres writes and Docker itself. Try <code>docker system prune</code> on the host.</i>',
        ].join('\n'),
        okTitle: '✅ <b>Xmail disk usage is back to normal</b>',
        okBody: `Filesystem at ${usedPercent}%.`,
    })
}

/**
 * `kind`s (from `buildSilenceAlerts`) that were active as of the previous tick.
 *
 * `buildSilenceAlerts` only ever reports what IS currently true — it has no notion of "this
 * used to be a problem" — so the moment a kind stops appearing has to be detected here, by
 * diffing this tick's findings against the last one, in order to send the explicit
 * `reportOpsCondition(key, false, …)` call that resolves it. Module-level and in-memory, same
 * as `ops-alert.ts`'s own `active` map: a restart clears it, which just means a recovery right
 * after a restart may not get its "cleared" message re-sent — already true of every other
 * condition in this file.
 */
let previouslyActiveSilenceKinds = new Set<string>()

/** Test seam — module-global state must be resettable between cases. */
export function __resetAlertWatchdogSilenceState(): void {
    previouslyActiveSilenceKinds = new Set()
}

/**
 * The silence half of the "invisible to every other layer" list above.
 *
 * `buildSilenceAlerts` (outreach-silence.ts) already carries roughly a dozen rules for exactly
 * this job's blind spot — states where nothing errors, so no error-shaped alert would ever see
 * them. Until 2026-09-08 its only caller was the on-demand admin route
 * (routes/admin/outreach-health.ts), which nothing polls: not the external uptime probe (it
 * hits `/health/ready`), not this watchdog. Verified against 24h of production logs: zero
 * occurrences of any silence-detector output. A detector for "nothing happened" that itself
 * never runs is the exact failure mode it exists to catch.
 *
 * Wiring it in here — same five-minute tick, same `reportOpsCondition` path the checks above
 * use — is the fix, not a parallel alerting mechanism. Each finding's `kind` becomes its own
 * `silence.<kind>` condition, keyed independently, so one noisy rule's cooldown can never mask
 * another's first occurrence.
 */
async function checkSilence(now: Date): Promise<void> {
    const metrics = await computeSilenceMetrics(now)
    const findings = buildSilenceAlerts(metrics, now)
    const currentKinds = new Set(findings.map((finding) => finding.kind))

    for (const finding of findings) {
        const icon = finding.severity === 'critical' ? '🚨' : '🔇'
        await reportOpsCondition(`silence.${finding.kind}`, true, {
            failTitle: `${icon} <b>Outreach silence: ${escapeHtml(finding.kind)}</b>`,
            failBody: escapeHtml(finding.message),
            okTitle: `✅ <b>Outreach silence cleared: ${escapeHtml(finding.kind)}</b>`,
            okBody: 'This condition is no longer present.',
        })
    }

    // Findings that were active last tick and are not in this tick's set have cleared —
    // buildSilenceAlerts will never tell us that directly, so an explicit resolve call is the
    // only way the recovery message (and the ops-alert state cleanup) happens at all.
    for (const kind of previouslyActiveSilenceKinds) {
        if (currentKinds.has(kind)) continue
        await reportOpsCondition(`silence.${kind}`, false, {
            failTitle: '', // unused: isFailing is false, so reportOpsCondition takes the resolve branch
            okTitle: `✅ <b>Outreach silence cleared: ${escapeHtml(kind)}</b>`,
            okBody: 'This condition is no longer present.',
        })
    }

    previouslyActiveSilenceKinds = currentKinds

    // The line that proves the detector ran, even when it found nothing — its absence is
    // exactly what someone auditing this after an incident would have looked for.
    log.info(
        { action: 'ops.watchdog.silence_checked', findingCount: findings.length, kinds: [...currentKinds] },
        `silence check found ${findings.length} finding(s)`,
    )
}

/**
 * Runs every check, isolating each so one failure cannot hide the others.
 *
 * Never throws: it is called from a cron tick whose only other option would be
 * to log an error, which would then feed the spike detector and make a
 * monitoring failure look like an application failure.
 */
export async function runAlertWatchdog(now: Date = new Date()): Promise<void> {
    const checks: Array<[string, () => Promise<void>]> = [
        ['queue', checkQueue],
        ['memory', checkMemory],
        ['disk', checkDisk],
        ['silence', () => checkSilence(now)],
    ]

    for (const [name, fn] of checks) {
        try {
            await fn()
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.warn(
                { action: 'ops.watchdog.check_failed', check: name, error: message },
                `watchdog check ${name} failed`,
            )
            // Reported as a warning, not an error: a failing CHECK is not a
            // failing SYSTEM, and routing it to the spike detector would let
            // the monitoring generate the alerts it is supposed to measure.
        }
    }
}
