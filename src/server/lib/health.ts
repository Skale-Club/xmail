import { checkDatabaseHealth } from '../../db'
import { checkSupabaseAuthHealth } from './supabase'

export async function runReadinessChecks() {
    const startedAt = Date.now()
    const [dbResult, authResult] = await Promise.allSettled([
        checkDatabaseHealth(),
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
