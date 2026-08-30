/**
 * The seam between "something logged an error" and "something counts errors".
 *
 * Deliberately dependency-free. `logger.ts` is imported by nearly every module
 * in the server, including standalone scripts; if it imported the spike
 * detector directly it would pull in ops-alert, telegram and the Drizzle client
 * behind them, so merely importing a logger would open a database pool. This
 * indirection keeps that chain unloaded until `installErrorTaps()` runs at
 * server startup — and keeps it entirely absent in tests and CLI scripts.
 *
 * Registration is optional: with no sink installed, `emitError` is a no-op and
 * every logging call site behaves exactly as it did before.
 */

type ErrorSink = (eventName: string) => void

let sink: ErrorSink | null = null

export function setErrorSink(fn: ErrorSink | null): void {
    sink = fn
}

/** Never throws — it is called from inside logging paths that must not fail. */
export function emitError(eventName: string): void {
    if (!sink) return
    try {
        sink(eventName)
    } catch {
        /* a broken sink must not break logging */
    }
}
