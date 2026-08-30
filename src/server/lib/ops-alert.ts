/**
 * Layer 2 of the alerting design: the things only the app can know.
 *
 * An external HTTP probe sees "the page loads" and stays green while a cron
 * silently stops, the outbound queue stalls, or the MX listener dies — this is
 * a MAIL server, and ports 25/587/993 bypass the HTTP proxy entirely, so an
 * uptime check on :9001 says nothing at all about the thing customers use.
 * These alerts fill that blind spot from inside the process.
 *
 * ## Everything here is a TRANSITION, not an event
 *
 * A stuck queue is stuck on every tick. Alerting per observation would send one
 * message a minute for hours, and a channel that floods is a channel that gets
 * muted — which costs you the alerts that matter. So each condition has a key
 * and a state: the first observation alerts, repeat observations are silent
 * until REPEAT_MS has passed, and the condition clearing sends exactly one
 * recovery message.
 *
 * State is per-process and in memory, like the rest of this design. A restart
 * resets it, which is correct: a fresh process has no history to compare
 * against, and a restart is usually the response to the incident anyway. The
 * cost is one duplicate alert per restart-during-incident, which is cheap
 * compared to a disk-backed store that can itself fail.
 */
import { sendTelegram, escapeHtml } from './telegram'

/**
 * How long the same condition stays quiet after firing.
 *
 * An outage lasts longer than one detection cycle, and repeating "still broken"
 * every few minutes is how a channel trains people to ignore it. Six hours
 * matches the on-box watchdog's ALERT_REPEAT_HOURS so the two layers do not
 * drift into different rhythms for the same class of problem.
 */
const REPEAT_MS = Number(process.env.OPS_ALERT_REPEAT_MS) > 0
    ? Math.floor(Number(process.env.OPS_ALERT_REPEAT_MS))
    : 6 * 60 * 60_000

interface AlertState {
    firstSeenAt: number
    lastSentAt: number
    occurrences: number
}

const active = new Map<string, AlertState>()

/** Test seam — module-global state must be resettable between cases. */
export function __resetOpsAlertState(): void {
    active.clear()
}

/** Diagnostics: which conditions this process currently considers unhealthy. */
export function getActiveOpsAlerts(): string[] {
    return [...active.keys()]
}

function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60_000)
    if (minutes < 60) return `${minutes}min`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ${minutes % 60}min`
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Reports that `key` is currently in a bad state.
 *
 * Sends on the first observation and then at most once per REPEAT_MS, so a
 * caller may invoke this on every tick without thinking about rate limiting.
 * Returns true when a message was actually dispatched.
 *
 * Fire-and-forget: awaiting is optional and callers on hot paths should not.
 */
export async function alertOps(key: string, title: string, body = ''): Promise<boolean> {
    try {
        const now = Date.now()
        const existing = active.get(key)

        if (existing) {
            existing.occurrences += 1
            if (now - existing.lastSentAt < REPEAT_MS) return false

            existing.lastSentAt = now
            const forHowLong = formatDuration(now - existing.firstSeenAt)
            const suffix = `\n\n<i>Still failing after ${escapeHtml(forHowLong)} — ${existing.occurrences} occurrences since the first alert.</i>`
            const result = await sendTelegram(title, body + suffix)
            return result.ok
        }

        active.set(key, { firstSeenAt: now, lastSentAt: now, occurrences: 1 })
        const result = await sendTelegram(title, body)
        return result.ok
    } catch {
        // This runs on cron ticks and request paths. It cannot throw.
        return false
    }
}

/**
 * Reports that `key` is healthy again.
 *
 * Silent unless that key had actually alerted — a green check following a green
 * check says nothing, and announcing "all clear" for a condition that was never
 * announced as broken is how a channel becomes noise. Returns true when a
 * recovery message was dispatched.
 */
export async function resolveOps(key: string, title: string, body = ''): Promise<boolean> {
    try {
        const existing = active.get(key)
        if (!existing) return false

        active.delete(key)
        const downFor = formatDuration(Date.now() - existing.firstSeenAt)
        const suffix = `\n\n<i>Recovered after ${escapeHtml(downFor)}.</i>`
        const result = await sendTelegram(title, body + suffix)
        return result.ok
    } catch {
        return false
    }
}

/**
 * Convenience for the common "evaluate a boolean condition each tick" shape.
 *
 * Collapses the alert/resolve pair into one call so a caller cannot accidentally
 * implement only half of the transition — forgetting the resolve side is how an
 * alert channel ends up full of problems that were fixed hours ago.
 */
export async function reportOpsCondition(
    key: string,
    isFailing: boolean,
    messages: { failTitle: string; failBody?: string; okTitle: string; okBody?: string },
): Promise<void> {
    if (isFailing) {
        await alertOps(key, messages.failTitle, messages.failBody ?? '')
    } else {
        await resolveOps(key, messages.okTitle, messages.okBody ?? '')
    }
}
