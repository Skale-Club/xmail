import { checkDatabaseHealth } from '../../db'
import { checkSupabaseAuthHealth } from './supabase'
import { withTimeout } from './with-timeout'

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

export async function runReadinessChecks() {
    const startedAt = Date.now()
    const [dbResult, authResult] = await Promise.allSettled([
        withTimeout(checkDatabaseHealth(), READINESS_DB_TIMEOUT_MS, 'database readiness probe'),
        checkSupabaseAuthHealth(),
    ])

    const database = dbResult.status === 'fulfilled' && dbResult.value.ok
        ? { ok: true, latencyMs: dbResult.value.latencyMs }
        : {
            ok: false,
            error: dbResult.status === 'fulfilled'
                ? (dbResult.value.error ?? 'database probe returned ok=false')
                : (dbResult.reason instanceof Error ? dbResult.reason.message : 'Database healthcheck failed'),
        }

    // checkSupabaseAuthHealth resolves with { ok: true } or throws — fulfilled means healthy.
    const auth = authResult.status === 'fulfilled' && authResult.value.ok
        ? { ok: true }
        : {
            ok: false,
            error: authResult.status === 'fulfilled'
                ? 'supabase auth probe returned ok=false'
                : (authResult.reason instanceof Error ? authResult.reason.message : 'Supabase auth healthcheck failed'),
        }

    return {
        ok: database.ok && auth.ok,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        services: {
            database,
            auth,
        },
    }
}
