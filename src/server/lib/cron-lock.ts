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
 */
export async function runWithLock(jobName: string, fn: () => Promise<unknown>): Promise<void> {
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

        try {
            await fn()
        } finally {
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
