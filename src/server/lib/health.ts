import { checkDatabaseHealth } from '../../db'
import { checkSupabaseAuthHealth } from './supabase'
import { TimeoutError, withTimeout } from './with-timeout'
import { browserAuthAuthority } from './identity/browser-auth-authority'
import { checkSelectedStorageHealth } from './object-storage'

/**
 * How long `/health/ready` waits for `select 1` before reporting the database as down.
 *
 * Without a bound the readiness probe inherits the pool's own wait: when every pooled
 * connection is stuck on a query that never returns, `select 1` queues behind them forever and
 * the endpoint never answers at all. That is exactly what the external probe saw for ten hours
 * on 2026-09-01 — `HTTP /health/ready → 000`, no body, nothing to triage — while the SMTP and
 * IMAP ports on the same process stayed green. A 503 with `database.error` naming the timeout
 * is a diagnosis; a hung socket is not. See lib/db-liveness.ts for what restarts the process.
 */
export const READINESS_DB_TIMEOUT_MS = 10_000
export const READINESS_AUTH_TIMEOUT_MS = 8_000
export const READINESS_STORAGE_TIMEOUT_MS = 4_000

async function selectedStorageReady() {
    const controller = new AbortController()
    try {
        return await withTimeout(checkSelectedStorageHealth(controller.signal), READINESS_STORAGE_TIMEOUT_MS, 'selected storage readiness probe')
    } finally { controller.abort() }
}

async function selectedAuthReady() {
    if (browserAuthAuthority(process.env) === 'legacy') return checkSupabaseAuthHealth()
    const controller = new AbortController()
    try {
        const operation = (async () => {
            const { getIdentityRuntime } = await import('./identity/runtime')
            await (await getIdentityRuntime()).assertReady(controller.signal)
            controller.signal.throwIfAborted()
            return { ok: true as const }
        })()
        return await withTimeout(operation, READINESS_AUTH_TIMEOUT_MS, 'owned identity readiness probe')
    } finally { controller.abort() }
}

export async function runReadinessChecks() {
    const startedAt = Date.now()
    const [dbResult, authResult, storageResult] = await Promise.allSettled([
        withTimeout(checkDatabaseHealth(), READINESS_DB_TIMEOUT_MS, 'database readiness probe'),
        withTimeout(selectedAuthReady(), READINESS_AUTH_TIMEOUT_MS, 'selected identity readiness probe'),
        selectedStorageReady(),
    ])

    const database = dbResult.status === 'fulfilled' && dbResult.value.ok
        ? { ok: true, latencyMs: dbResult.value.latencyMs }
        : {
            ok: false,
            error: dbResult.status === 'rejected' && dbResult.reason instanceof TimeoutError
                ? 'Database readiness timed out.' : 'Database readiness check failed.',
        }

    // Selected authority only. Provider/SDK errors may retain credential-bearing
    // request data, so only a static failure message may leave this health report.
    const auth = authResult.status === 'fulfilled' && authResult.value.ok
        ? { ok: true }
        : {
            ok: false,
            error: 'Selected identity readiness check failed.',
        }
    const storage = storageResult.status === 'fulfilled' && storageResult.value.ok
        ? { ok: true }
        : { ok: false, error: 'Selected object storage readiness check failed.' }

    return {
        ok: database.ok && auth.ok && storage.ok,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        services: {
            database,
            auth,
            storage,
        },
    }
}
