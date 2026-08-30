/**
 * Layer 3: turns a BURST of errors into ONE alert.
 *
 * Every other alert in this system names a specific failure someone thought to
 * instrument. This is the net under all of them: Xmail has ~280 error call
 * sites — the global Express error handler, 19 cron catch blocks, SMTP/IMAP/MX
 * failures, webhook dispatch, R2 uploads, credential decryption — and until now
 * every one of them ended at stdout. There is no Sentry in this project, so an
 * error that nobody greps for has never been seen by anyone.
 *
 * ## Why a rate, not an error
 *
 * Alerting per error would be unusable. One broken endpoint produces hundreds a
 * minute; the MX listener alone logs on every malformed inbound message, and
 * this box receives public internet mail on port 25. A channel that floods is a
 * channel that gets muted — which costs you the alerts that matter. So this
 * reports a CHANGE IN RATE: quiet while errors trickle at their normal
 * background level, one message when they jump, naming the events responsible
 * so the message says WHAT broke rather than merely that something did.
 *
 * ## The threshold is calibrated from production, not guessed
 *
 * A threshold pulled out of the air either floods or stays silent through a
 * real outage. This module therefore measures its own background rate: every
 * BASELINE_LOG_INTERVAL_MS it logs `error_spike.baseline` with the observed
 * errors-per-5-minutes. Read a day of those from production —
 *
 *   docker logs xmail --since 24h 2>&1 | grep error_spike.baseline
 *
 * — and set ERROR_SPIKE_THRESHOLD to roughly an order of magnitude above the
 * median. The default below is deliberately conservative and NOT yet measured
 * against this project; see docs/TELEGRAM-ALERTS.md.
 *
 * State is per-process and in memory. A restart resets it, which is correct: a
 * fresh process has no history to compare against, and a restart is itself
 * usually the response to the spike.
 */
// `escapeHtml` comes from the dependency-free module on purpose. This file is
// imported by the logging tap, which runs in every process that logs — a static
// import of ops-alert or telegram would drag the Drizzle client in with it and
// make merely logging an error open a database connection (and throw outright
// when DATABASE_URL is unset, as in tests and CLI scripts). The notifier is
// therefore loaded lazily, at the moment an alert actually fires.
import { escapeHtml } from './html-escape'

/** Rolling window over which errors are counted. */
const WINDOW_MS = 5 * 60_000

/**
 * Errors within one window before it counts as a spike.
 *
 * MEASURED against production on 2026-08-30, over the preceding 24 hours:
 *
 *   total error-level lines      770
 *   mean per 5-minute window     2.67
 *   busiest 5-minute window      23
 *   how often that peak recurs   ~32×/day, almost exactly every 45 minutes
 *
 * That peak is not random load. It is a single recurring defect —
 * `outreach.inbound.account_error`, a `value?.toISOString is not a function`
 * thrown once per native outreach account on every inbound-processing pass —
 * which accounts for ~398 of the last 400 errors. Until it is fixed it is the
 * structural noise floor, and any threshold at or below ~25 would fire on it
 * every 45 minutes and get the channel muted within a day.
 *
 * 60 sits ~2.6× above that recurring burst and ~22× above the mean, so the
 * known noise stays silent while a genuinely broken endpoint — which produces
 * hundreds a minute — trips it immediately. The signal is the jump, not the
 * errors.
 *
 * ONCE `outreach.inbound.account_error` IS FIXED, re-read a day of
 * `error_spike.baseline` lines and lower this to roughly 15; leaving it at 60
 * against a near-zero floor would make the detector insensitive.
 */
const SPIKE_THRESHOLD = Number(process.env.ERROR_SPIKE_THRESHOLD) > 0
    ? Math.floor(Number(process.env.ERROR_SPIKE_THRESHOLD))
    : 60

/**
 * Silence after firing. An outage lasts longer than one window, and repeating
 * "still broken" every five minutes is how a channel trains people to ignore
 * it. Thirty minutes is long enough to stay quiet through a deploy-and-recover
 * cycle and short enough that a genuinely worsening incident speaks again.
 */
const COOLDOWN_MS = Number(process.env.ERROR_SPIKE_COOLDOWN_MS) > 0
    ? Math.floor(Number(process.env.ERROR_SPIKE_COOLDOWN_MS))
    : 30 * 60_000

/** How often the observed background rate is logged for calibration. */
const BASELINE_LOG_INTERVAL_MS = 60 * 60_000

/** How many distinct event names the alert names before it stops listing. */
const TOP_EVENTS = 5

/**
 * Events this alert must never count, or it feeds on itself.
 *
 * Delivering the alert calls Telegram, and a failed send calls console.error —
 * which would count toward the next spike, which would fire another alert,
 * which would fail again. When the spike IS the database being unreachable,
 * reading the panel credentials fails too. The cooldown alone bounds the loop;
 * excluding the notifier's own failures prevents it from starting.
 */
const SELF_PREFIXES = ['telegram.', 'ops_alert.', 'error_spike.', '[telegram]']

let windowStartedAt = 0
let windowCount = 0
let windowEvents = new Map<string, number>()
let lastAlertAt = 0
/** Re-entrancy guard: errors logged while an alert is in flight don't count. */
let dispatching = false

// Baseline accounting, kept separate from the alerting window so that firing an
// alert (which resets the window) does not distort the measured rate.
let baselineWindows = 0
let baselineErrors = 0
let baselineMax = 0
let lastBaselineLogAt = 0

/** Test seam — the module is process-global, so tests must be able to reset it. */
export function __resetErrorSpikeState(): void {
    windowStartedAt = 0
    windowCount = 0
    windowEvents = new Map()
    lastAlertAt = 0
    dispatching = false
    baselineWindows = 0
    baselineErrors = 0
    baselineMax = 0
    lastBaselineLogAt = 0
}

/** Diagnostics + deterministic unit tests. */
export function getErrorSpikeState(): {
    windowCount: number
    lastAlertAt: number
    threshold: number
    baselineMeanPerWindow: number
    baselineMaxPerWindow: number
} {
    return {
        windowCount,
        lastAlertAt,
        threshold: SPIKE_THRESHOLD,
        baselineMeanPerWindow: baselineWindows > 0 ? baselineErrors / baselineWindows : 0,
        baselineMaxPerWindow: baselineMax,
    }
}

/**
 * Collapses a raw error message into a stable grouping key.
 *
 * Most of Xmail's error surface is `console.error('Error updating X:', err)`
 * with no structured action field, so the message text is all there is. Ids,
 * numbers and addresses are stripped so that a hundred failures of the same
 * kind report as one named event with a count, rather than a hundred distinct
 * names that overflow the list and say nothing.
 */
export function normalizeEventName(raw: unknown): string {
    let text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw)
    text = text
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
        .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, '<email>')
        .replace(/\b\d+\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
    return text.slice(0, 80) || 'unknown'
}

/** Overridable for tests so a case can assert what was sent without network. */
type Dispatcher = (title: string, body: string) => Promise<unknown>
let dispatcher: Dispatcher | null = null
export function __setErrorSpikeDispatcher(fn: Dispatcher | null): void {
    dispatcher = fn
}

async function dispatch(title: string, body: string): Promise<unknown> {
    if (dispatcher) return dispatcher(title, body)
    // Loaded here, not at module scope, so the import chain below (ops-alert ->
    // telegram -> db) is only paid by a process that actually alerts.
    //
    // Routed through alertOps so a sustained error storm obeys the same
    // repeat-suppression as every other condition, rather than inventing a
    // second rate-limiting scheme that has to be reasoned about separately.
    const { alertOps } = await import('./ops-alert')
    return alertOps('error_spike', title, body)
}

/**
 * Records one error and fires the alert when the window crosses the threshold.
 *
 * Synchronous, allocation-light and NEVER throws — it runs inside the logger and
 * inside console.error, on the hot path of every request that fails. The send
 * itself is fire-and-forget.
 */
export function recordError(eventName: string, now = Date.now()): void {
    try {
        if (dispatching) return
        if (SELF_PREFIXES.some((p) => eventName.startsWith(p))) return

        if (windowStartedAt === 0) {
            windowStartedAt = now
            lastBaselineLogAt = now
        }

        if (now - windowStartedAt > WINDOW_MS) {
            // Close the window for measurement before opening the next one.
            baselineWindows += 1
            baselineErrors += windowCount
            if (windowCount > baselineMax) baselineMax = windowCount

            if (now - lastBaselineLogAt >= BASELINE_LOG_INTERVAL_MS) {
                lastBaselineLogAt = now
                const mean = baselineErrors / baselineWindows
                // console.log, not the logger: this must never itself be an
                // error record, and it must survive LOG_LEVEL tightening.
                console.log(JSON.stringify({
                    action: 'error_spike.baseline',
                    windowMinutes: WINDOW_MS / 60_000,
                    windowsObserved: baselineWindows,
                    meanErrorsPerWindow: Number(mean.toFixed(2)),
                    maxErrorsPerWindow: baselineMax,
                    configuredThreshold: SPIKE_THRESHOLD,
                }))
            }

            windowStartedAt = now
            windowCount = 0
            windowEvents = new Map()
        }

        windowCount += 1
        windowEvents.set(eventName, (windowEvents.get(eventName) ?? 0) + 1)

        if (windowCount < SPIKE_THRESHOLD) return
        if (now - lastAlertAt < COOLDOWN_MS) return

        lastAlertAt = now
        const topEvents = [...windowEvents.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, TOP_EVENTS)
        const count = windowCount

        // Closing the window here means the next alert measures a FRESH burst
        // rather than re-reporting the same one the moment the cooldown lapses.
        windowStartedAt = now
        windowCount = 0
        windowEvents = new Map()

        const lines = topEvents
            .map(([name, n]) => `• <b>${escapeHtml(n)}×</b> ${escapeHtml(name)}`)
            .join('\n')
        const body = [
            `${count} errors in ${WINDOW_MS / 60_000} minutes (threshold ${SPIKE_THRESHOLD}).`,
            '',
            'Most frequent:',
            lines,
            '',
            `<i>Quiet for the next ${Math.round(COOLDOWN_MS / 60_000)} minutes unless a fresh burst starts.</i>`,
        ].join('\n')

        dispatching = true
        void Promise.resolve(dispatch('🔥 <b>Xmail error spike</b>', body))
            .catch(() => {
                // dispatch never throws; belt-and-braces for the import path.
            })
            .finally(() => {
                dispatching = false
            })
    } catch {
        // The never-throw guarantee is absolute: this runs inside console.error.
        dispatching = false
    }
}
