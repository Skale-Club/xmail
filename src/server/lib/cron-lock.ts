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
 * Behavior:
 *   - If `pg_try_advisory_lock` returns false (lock already held by THIS or
 *     ANOTHER process/session), logs a skip message and returns without error.
 *   - If acquired, runs `fn` and releases the lock in a `finally` block on
 *     the SAME reserved connection (required for `pg_advisory_unlock` to match
 *     the session that acquired the lock).
 *   - On `kill -9` / process crash, the underlying postgres-js connection dies
 *     and Postgres releases the advisory lock automatically (session-scoped) —
 *     no orphan-lock risk.
 *
 * Never throws on lock-acquisition or unlock failure — those are logged and
 * swallowed so a single cron tick failure does not crash the scheduler.
 * Errors thrown by `fn` itself propagate to the caller.
 */
export async function runWithLock(jobName: string, fn: () => Promise<unknown>): Promise<void> {
    const key = computeLockKey(jobName)

    // Reserve a single connection so lock and unlock target the same session.
    // postgres-js .reserve() returns a tagged-template SQL function with a
    // .release() method to return the connection to the pool.
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
        try {
            const rows = await reserved`SELECT pg_try_advisory_lock(${keyParam}::bigint) AS got`
            const first = rows[0] as { got?: boolean } | undefined
            acquired = Boolean(first?.got)
        } catch (lockErr) {
            console.error(`[cron-lock] ${jobName} failed to acquire lock:`, lockErr)
            return
        }

        if (!acquired) {
            console.log(`[cron-lock] ${jobName} already running on another process/tick, skipping`)
            return
        }

        try {
            await fn()
        } finally {
            try {
                await reserved`SELECT pg_advisory_unlock(${keyParam}::bigint)`
            } catch (unlockErr) {
                console.error(`[cron-lock] ${jobName} unlock failed:`, unlockErr)
            }
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
