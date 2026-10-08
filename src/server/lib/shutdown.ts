/**
 * Process-wide "we are shutting down" flag.
 *
 * Set by the SIGINT/SIGTERM handler in src/server/index.ts the moment the signal arrives, BEFORE
 * the mail servers and the DB pool start closing. A blue-green deploy SIGTERMs the old container
 * while a cron tick may be mid-flight; every connection error that tick then raises is caused by
 * us leaving, not by the mailbox being unhealthy. Code that would turn an error into persisted
 * state (a backoff, a failure counter) asks this first and records nothing.
 */
let shuttingDown = false

export function markShuttingDown(): void {
    shuttingDown = true
}

export function isShuttingDown(): boolean {
    return shuttingDown
}

/** Test seam: the flag is module state, so a suite that flips it must be able to put it back. */
export function resetShutdownForTests(): void {
    shuttingDown = false
}
