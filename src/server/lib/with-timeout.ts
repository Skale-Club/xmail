/**
 * Bounds a promise. Dependency-free on purpose: this is imported by the readiness probe, the
 * Telegram credential loader and the database liveness watchdog — the three places that must
 * keep working while the rest of the process is stuck waiting on something that never answers.
 */

export class TimeoutError extends Error {
    readonly code = 'ETIMEDOUT' as const
    constructor(readonly label: string, readonly timeoutMs: number) {
        super(`${label} timed out after ${timeoutMs}ms`)
        this.name = 'TimeoutError'
    }
}

/**
 * Resolves/rejects with `promise`, or rejects with a TimeoutError after `timeoutMs`.
 *
 * The original promise is NOT cancelled (nothing in Node cancels arbitrary async work); it is
 * only detached, with a no-op catch so a late rejection cannot become an unhandled rejection.
 * Accepts any thenable (a Drizzle query included) and awaits it exactly once.
 */
export function withTimeout<T>(input: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
    // Settle the input into ONE native promise up front. A Drizzle query is a thenable whose
    // every `.then()`/`.catch()` call runs the query again; calling `.catch` on it below (to
    // detach a late rejection) would silently execute the SQL a second time.
    const promise = Promise.resolve(input)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
        promise.catch(() => { /* detached after timeout; see above */ })
    })
}
