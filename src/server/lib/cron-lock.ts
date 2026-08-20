import { createHash } from 'node:crypto'
import { queryClient } from '../../db'

// SEC-04 — cross-process / multi-tick cron mutual exclusion via Postgres advisory locks.
// See .planning/debug/system-wide-audit-2026-05-16.md H8 and
// .planning/phases/11-high-security/11-CONTEXT.md.
//
// IMPORTANT: The advisory-lock key is derived from the job NAME string.
// Renaming a job (e.g. `processQueue` → `processQueueV2`) would compute a
// different key, allowing old-name and new-name instances to overlap during
// rolling deploys. Keep names stable.

/**
 * Maps an arbitrary job name to a stable signed BIGINT (Postgres bigint range)
 * via SHA-256 → first 8 bytes → BigInt → masked to positive signed 63-bit range.
 *
 * Deterministic across processes: the same name always yields the same key.
 */
export function computeLockKey(name: string): bigint {
    const hash = createHash('sha256').update(name).digest()
    let key = 0n
    for (let i = 0; i < 8; i++) {
        key = (key << 8n) | BigInt(hash[i])
    }
    // Mask to positive 63-bit range so it fits in Postgres signed bigint.
    const SIGNED_MAX = (1n << 63n) - 1n
    return key & SIGNED_MAX
}

/**
 * Every job name ever passed to `runWithLock`. `computeLockKey` is one-way (SHA-256), so a raw
 * numeric key read back out of `pg_locks` cannot be turned into a job name without this list —
 * outreach-silence-query.ts uses it to name which job a stuck lock belongs to instead of just
 * reporting an opaque bigint. Keep in sync: add the literal string here whenever a new call site
 * passes a new `jobName` to `runWithLock`. An entry that falls out of sync only degrades a stale
 * lock's alert message to an unresolved key — it does not stop the alert from firing.
 */
export const KNOWN_LOCK_NAMES: readonly string[] = [
    'amortizeSubscriptionCosts',
    'outreach-unified-inbox-materializer', // also covers backfillUnifiedInbox.ts (shares the name)
    'deliverOutreachEventsToXphere',
    'enforceDeliverabilityGuardrails',
    'expireOutreachApprovals',
    'measureProspectingOutcomes',
    'outreach-bounces-processor',
    'outreach-followups-processor',
    'outreach-inbox-commands',
    'outreach-sequences-processor',
    'outreach-replies-processor',
    'warmup-mesh-processor',
    'reconcileOutreachEvents',
]

/**
 * Default budget for the job body — see the "budget" section below. 10 minutes covers every
 * 5/15/30-minute-cadence cron job (jobs/index.ts) with room to spare, and matches the warmup
 * mesh's own 10-minute cadence (that job gets an explicit shorter override — see processWarmup.ts
 * — so its lock still clears with margin before its own next tick).
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000

/** Distinguishes "the timer won the race" from any value `fn()` could legitimately resolve with. */
const JOB_TIMEOUT = Symbol('cron-lock-job-timeout')

/**
 * Runs `fn` only if the named advisory lock can be acquired immediately.
 *
 * The lock is TRANSACTION-scoped (`pg_try_advisory_xact_lock` inside an explicit
 * `BEGIN … COMMIT` on one reserved connection), not session-scoped. That is
 * deliberate: production reaches Postgres through the Supabase pooler in
 * transaction mode (`:6543`), where every statement outside a transaction may
 * land on a DIFFERENT backend. With `pg_try_advisory_lock`/`pg_advisory_unlock`
 * that meant the lock was taken on backend A and the unlock ran on backend B —
 * A kept the lock forever, and from then on roughly every other tick of EVERY
 * job (whichever landed on a backend other than A) logged
 * "already running … skipping" while nothing was running. Inside an open
 * transaction the pooler pins the backend, so lock, body and release all see
 * the same session, and COMMIT (or the connection dying) always frees it.
 *
 * Behavior:
 *   - If the lock is already held by another tick/process, logs a skip
 *     message and returns without error.
 *   - If acquired, runs `fn` and commits (releasing the lock) in `finally`.
 *   - On `kill -9` / process crash, the connection dies and Postgres rolls the
 *     transaction back, releasing the lock — no orphan-lock risk.
 *   - Session-scoped holders (`pg_advisory_lock` on the same key) still contend
 *     with this lock: session and xact advisory locks share one lock space.
 *
 * Never throws on lock-acquisition or release failure — those are logged and
 * swallowed so a single cron tick failure does not crash the scheduler.
 * Errors thrown by `fn` itself propagate to the caller.
 *
 * BUDGET (why this exists): `fn()` used to run unbounded inside the transaction. If it never
 * settled — a hung IMAP/SMTP socket with no timeout of its own was the real 2026-08-19/20
 * incident — the `finally` that commits (and releases the lock) never ran either. The
 * transaction sat `idle in transaction` holding the advisory lock forever, and every later tick
 * logged the ordinary-looking "already running … skipping" — indistinguishable from healthy
 * contention. Three jobs died silently that way for 2-4 days before a human noticed.
 *
 * `fn()` is now raced against a per-call `timeoutMs` (default `DEFAULT_JOB_TIMEOUT_MS`, override
 * via the `options.timeoutMs` param on the specific job — cadences differ, so one global number
 * cannot be right for all of them). If the timer wins:
 *   - A single, loudly-distinct log line fires (`cron.lock.job_timeout` in the message) — this is
 *     NOT the routine "skipping" line above; it means a job ACTUALLY overran, not that two ticks
 *     merely overlapped. Grep for `cron.lock.job_timeout` to find every occurrence.
 *   - The `finally` below still runs and COMMITs, so the transaction ends and the advisory lock
 *     is released on schedule regardless of what `fn()` is still doing. A job that overran must
 *     never keep the lock — that is the entire point of this change.
 *   - `runWithLock` does NOT throw for a timeout and returns normally, same as a successful run.
 *     Every caller in jobs/index.ts already does `.catch(err => log.error(...))` on the returned
 *     promise; making a timeout reject here would route it through that generic "<job> failed"
 *     log instead of (or on top of) the distinct line above, which is a worse signal, not a
 *     better one. The distinct log line above is the deliberate signal for this case.
 *   - The orphaned `fn()` promise is NOT cancelled — Postgres has no cooperative cancellation for
 *     an in-flight query from here, and Node has none for arbitrary async work. It keeps running
 *     in the background against a transaction that COMMITs (and a reserved connection that gets
 *     released back to the pool) out from under it; whatever it was doing when it finally settles
 *     is discarded — no result of a timed-out run is ever used. We attach a `.catch()` to it so a
 *     late rejection cannot surface as an unhandled promise rejection and crash the process; that
 *     is its only remaining purpose after a timeout.
 */
export async function runWithLock(
    jobName: string,
    fn: () => Promise<unknown>,
    options?: { timeoutMs?: number },
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    const key = computeLockKey(jobName)

    // Reserve a single connection so BEGIN, the lock and COMMIT travel on the
    // same client connection (and therefore the same pooled backend).
    let reserved: Awaited<ReturnType<typeof queryClient.reserve>>
    try {
        reserved = await queryClient.reserve()
    } catch (reserveErr) {
        console.error(`[cron-lock] ${jobName} failed to reserve connection:`, reserveErr)
        return
    }

    // postgres-js tagged-template parameters don't accept bigint; pass as string
    // and cast in SQL. The deterministic key still maps 1:1 across processes.
    const keyParam = key.toString()

    try {
        let acquired = false
        let inTransaction = false
        try {
            await reserved`BEGIN`
            inTransaction = true
            const rows = await reserved`SELECT pg_try_advisory_xact_lock(${keyParam}::bigint) AS got`
            const first = rows[0] as { got?: boolean } | undefined
            acquired = Boolean(first?.got)
        } catch (lockErr) {
            console.error(`[cron-lock] ${jobName} failed to acquire lock:`, lockErr)
            if (inTransaction) await endTransaction(jobName, reserved, 'ROLLBACK')
            return
        }

        if (!acquired) {
            await endTransaction(jobName, reserved, 'ROLLBACK')
            console.log(`[cron-lock] ${jobName} already running on another process/tick, skipping`)
            return
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const fnPromise = fn()
            const timeoutPromise = new Promise<typeof JOB_TIMEOUT>((resolve) => {
                timer = setTimeout(() => resolve(JOB_TIMEOUT), timeoutMs)
            })

            const outcome = await Promise.race([fnPromise, timeoutPromise])

            if (outcome === JOB_TIMEOUT) {
                // Distinct from "[cron-lock] <job> already running on another process/tick,
                // skipping" above: that line is routine contention, this one means a job
                // actually overran its budget. Keep "cron.lock.job_timeout" in the message so it
                // is grep-able independent of any structured-logging field.
                console.error(
                    `[cron-lock] ${jobName} cron.lock.job_timeout after ${timeoutMs}ms — releasing `
                        + 'the advisory lock now via COMMIT. The job body is NOT cancelled: it keeps '
                        + 'running orphaned, detached from this transaction, and its eventual result '
                        + 'is discarded. This is an abnormal stall, not normal tick overlap.',
                )

                // See the BUDGET doc above: never awaited, never cancelled — only guarded against
                // becoming an unhandled rejection once it finally settles.
                fnPromise.catch((orphanErr) => {
                    console.error(
                        `[cron-lock] ${jobName} orphaned job body rejected after cron.lock.job_timeout `
                            + '(result already discarded, lock already released):',
                        orphanErr,
                    )
                })
            }
        } finally {
            if (timer) clearTimeout(timer)
            // Ending the transaction is what releases the xact lock.
            await endTransaction(jobName, reserved, 'COMMIT')
        }
    } finally {
        // Always return the reserved connection to the pool.
        try {
            reserved.release()
        } catch (releaseErr) {
            console.error(`[cron-lock] ${jobName} connection release failed:`, releaseErr)
        }
    }
}

async function endTransaction(
    jobName: string,
    reserved: Awaited<ReturnType<typeof queryClient.reserve>>,
    verb: 'COMMIT' | 'ROLLBACK',
): Promise<void> {
    try {
        await reserved.unsafe(verb)
    } catch (endErr) {
        console.error(`[cron-lock] ${jobName} ${verb} failed:`, endErr)
    }
}
