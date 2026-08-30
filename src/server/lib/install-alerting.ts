/**
 * Wires the alerting layers into the running process. Called once from
 * src/server/index.ts, after the HTTP listener is up.
 *
 * Kept separate from the modules it installs so that importing any of them —
 * from a test, a script, or a route — has no global side effects. Nothing here
 * runs unless the server actually starts.
 */
import { recordError, normalizeEventName } from './error-spike-alert'
import { setErrorSink } from './error-taps'
import { alertOps } from './ops-alert'
import { escapeHtml, isTelegramConfigured } from './telegram'

let installed = false

/**
 * The `console.error` tap.
 *
 * The pino hook in logger.ts covers ~35 call sites. It does NOT cover the other
 * ~246, which use `console.error` directly — including the global Express error
 * handler, the SMTP/IMAP/MX servers, and most of the route layer. Tapping the
 * console is the only way to see them without editing every file, and editing
 * every file is exactly how a future call site gets forgotten.
 *
 * The original is always called first, so stdout is byte-for-byte unchanged and
 * `docker logs` keeps working the way the runbooks assume.
 */
function tapConsoleError(): void {
    const original = console.error.bind(console)
    console.error = (...args: unknown[]): void => {
        original(...args)
        try {
            recordError(normalizeEventName(args[0]))
        } catch {
            /* instrumentation must never break logging */
        }
    }
}

/**
 * Gives an in-flight alert a moment to reach Telegram before the process dies.
 *
 * On an uncaught exception the runtime is about to exit; an un-awaited fetch
 * would be discarded with the event loop. Bounded hard, because a hung network
 * must not turn a crash into a hang — a crashed process at least gets restarted
 * by Docker, whereas one stuck here would keep failing health checks silently.
 */
async function flushWithin(ms: number, work: Promise<unknown>): Promise<void> {
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms))])
}

/**
 * Alerts on the two failure modes that leave no trace anywhere else.
 *
 * An uncaught exception kills the process; Docker restarts it and the only
 * record is a gap in the logs that nobody is watching. An unhandled rejection
 * does not kill it — it leaves the app running in an unknown state, which is
 * worse, because every external probe stays green.
 */
function installCrashHandlers(): void {
    process.on('uncaughtException', (err: Error) => {
        console.error('[fatal] uncaughtException:', err.message, err.stack)
        void flushWithin(
            5_000,
            alertOps(
                'process.uncaught_exception',
                '💥 <b>Xmail crashed</b>',
                [
                    `<b>${escapeHtml(err.name)}:</b> ${escapeHtml(err.message)}`,
                    '',
                    `<pre>${escapeHtml((err.stack ?? '').split('\n').slice(1, 6).join('\n'))}</pre>`,
                    '',
                    '<i>The process is exiting; Docker will restart it. If the external uptime probe stays green, the restart worked.</i>',
                ].join('\n'),
            ),
        ).finally(() => {
            // Exit non-zero so the container restarts. Staying alive after an
            // uncaught exception means running on corrupted state.
            process.exit(1)
        })
    })

    process.on('unhandledRejection', (reason: unknown) => {
        const err = reason instanceof Error ? reason : new Error(String(reason))
        console.error('[fatal] unhandledRejection:', err.message, err.stack)
        // Deliberately does NOT exit: an unhandled rejection is usually a single
        // dropped promise, and killing a mail server mid-delivery over one would
        // cost more than it saves. It is alerted precisely because it is silent.
        void alertOps(
            'process.unhandled_rejection',
            '⚠️ <b>Xmail: unhandled promise rejection</b>',
            [
                `<b>${escapeHtml(err.name)}:</b> ${escapeHtml(err.message)}`,
                '',
                `<pre>${escapeHtml((err.stack ?? '').split('\n').slice(1, 5).join('\n'))}</pre>`,
                '',
                '<i>The process is still running, in an unknown state. Nothing else would have reported this.</i>',
            ].join('\n'),
        )
    })
}

/**
 * Installs every in-app alerting tap. Idempotent.
 *
 * Safe to call when Telegram is not configured: every downstream send is a
 * silent no-op in that case, so a fresh clone or a CI run behaves exactly as
 * before. The startup log line says which state it is in, because "alerts are
 * on" is precisely the kind of thing that must not be assumed.
 */
export async function installAlerting(): Promise<void> {
    if (installed) return
    installed = true

    setErrorSink(recordError)
    tapConsoleError()
    installCrashHandlers()

    const configured = await isTelegramConfigured()
    console.log(
        configured
            ? '[alerting] Telegram alerts ACTIVE (credentials from the admin panel).'
            : '[alerting] Telegram alerts INACTIVE — configure them at /admin/integrations and enable the toggle. Error taps are installed either way.',
    )
}
