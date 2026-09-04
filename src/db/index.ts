import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
    throw new Error('Missing DATABASE_URL')
}

// Determine if we're in development
const isDev = process.env.NODE_ENV === 'development'

// Connection pool configuration for Supabase Supavisor.
// IMPORTANT: prepare MUST be false when DATABASE_URL targets the transaction
// pooler (port 6543). Supavisor reuses backend connections across requests so
// prepared statements created in one request vanish for the next, causing
// "prepared statement does not exist" / "already exists" 500 errors.
// Session pooler (port 5432) supports prepared statements, but false is safe
// for both modes and avoids connection-specific state issues.
// idle_timeout is deliberately well above the 1-minute processQueue cron tick.
// At the previous 10s, pooled connections died between every tick and postgres-js
// re-ran its type-introspection query (~400 catalog rows) on each reconnect —
// ~265k reconnects shipped ~3 GB out of Supabase and dominated egress after the
// IMAP fix below. Lower it via DB_IDLE_TIMEOUT_SECONDS if pooler slots get tight.
export const queryClient = postgres(connectionString, {
    max: Number(process.env.DB_POOL_MAX || 20),
    idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS || 300),
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_SECONDS || 30),
    max_lifetime: Number(process.env.DB_MAX_LIFETIME_SECONDS || 60 * 30),
    // Must be false for Supabase transaction pooler (port 6543)
    prepare: false,
    // Enable debug in development
    debug: isDev,
    // Transform undefined to null
    transform: {
        undefined: null,
    },
    // On notice from Postgres
    onnotice: (notice) => {
        if (isDev) {
            console.log('[DB Notice]', notice.message)
        }
    },
    // Handle connection errors
    onclose: (connectionId) => {
        if (isDev) {
            console.log('[DB] Connection closed:', connectionId)
        }
    },
})

// ─── Job query client — a SEPARATE pool for background jobs (cron-lock.ts's runWithLock) ───────
//
// `queryClient` above is sized and configured for the HTTP request path: many short-lived
// transactions against Supabase's TRANSACTION pooler (DATABASE_URL, port 6543), which is exactly
// what Supavisor's transaction mode is designed for.
//
// `runWithLock` in cron-lock.ts does the opposite: it calls `.reserve()` to pin ONE connection
// for the entire job body — `BEGIN` → `pg_try_advisory_xact_lock` → the job's own (sometimes
// multi-minute) work → `COMMIT` — a long-lived, session-scoped usage pattern that a transaction
// pooler is explicitly not built for (Supavisor can and does recycle/reassign backend
// connections between statements in that mode). Production showed 61 CONNECTION_DESTROYED /
// ECONNRESET errors over 7 days, clustered on incident days, consistent with exactly that.
//
// `DIRECT_URL` (already used by drizzle.config.ts and scripts/verify-tables.ts for the same
// "bypass the transaction pooler" reason) is preferred here; when it is unset this falls back to
// `DATABASE_URL` — today's behavior, unchanged. This also isolates jobs' connection usage from
// the request path entirely: a pile-up of long-running or orphaned job bodies (see cron-lock.ts's
// in-flight/orphan tracking, added for the 2026-09-01/02 incident) can no longer exhaust
// `queryClient`'s pool and starve the HTTP API along with it.
//
// POOL SIZE ARITHMETIC: cron-lock.ts's own comment on `runWithLock` records a MEASURED peak of
// "up to 10 concurrent bodies" (e.g. warmup-mesh-processor and outreach-replies-processor
// overlapping) across the 17 registered cron jobs — each concurrent body holds exactly one
// reserved connection for its whole run. 10 (measured peak) + 2 (headroom for a manual one-off
// script or a health probe sharing this same pool) = 12. Jobs are FEW and LONG (multi-second to
// multi-minute bodies on a 1-minute-or-slower tick, not the high-frequency short queries the
// request path makes), so this deliberately stays far below `queryClient`'s pool of 20 — a
// larger pool here would buy nothing but more idle connections held open against Supabase's
// shared connection ceiling.
//
// `prepare: false` unless PROVABLY not a transaction pooler: `DIRECT_URL`, when set, is expected
// to be a non-transaction-pooler connection (e.g. Supabase's session pooler on port 5432, which
// DOES support prepared statements) — but this file has no reliable way to prove that from an
// arbitrary connection string, and a wrong guess would reintroduce the exact "prepared statement
// does not exist" failure mode `prepare: false` exists to prevent on `queryClient` above. Kept
// false unconditionally on both the `DIRECT_URL` and `DATABASE_URL` branches.
const directConnectionString = process.env.DIRECT_URL
const jobConnectionString = directConnectionString || connectionString
console.log(
    `[DB] jobQueryClient using ${directConnectionString ? 'DIRECT_URL' : 'DATABASE_URL (DIRECT_URL not set)'}`
)

export const jobQueryClient = postgres(jobConnectionString, {
    max: 12, // see POOL SIZE ARITHMETIC above: 10 measured peak concurrent job bodies + 2 headroom
    idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS || 300),
    connect_timeout: Number(process.env.DB_CONNECT_TIMEOUT_SECONDS || 30),
    max_lifetime: Number(process.env.DB_MAX_LIFETIME_SECONDS || 60 * 30),
    // Must stay false unless proven otherwise — see the comment above.
    prepare: false,
    debug: isDev,
    transform: {
        undefined: null,
    },
    onnotice: (notice) => {
        if (isDev) {
            console.log('[DB Notice][jobs]', notice.message)
        }
    },
    onclose: (connectionId) => {
        if (isDev) {
            console.log('[DB][jobs] Connection closed:', connectionId)
        }
    },
})

// Create Drizzle instance with logger in development
export const db = drizzle(queryClient, {
    schema,
    logger: isDev ? {
        logQuery: (query, params) => {
            console.log('[DB Query]', query, params)
        }
    } : undefined
})

// Connection state tracking
let connectionState = {
    lastHealthCheck: 0,
    healthy: true,
    latencyMs: 0,
    totalQueries: 0,
    failedQueries: 0,
}

/**
 * Check database health with detailed metrics
 */
export async function checkDatabaseHealth() {
    const startedAt = Date.now()
    try {
        await queryClient`select 1`
        const latencyMs = Date.now() - startedAt
        
        connectionState = {
            ...connectionState,
            lastHealthCheck: Date.now(),
            healthy: true,
            latencyMs,
        }
        
        return {
            ok: true as const,
            latencyMs,
            timestamp: new Date().toISOString(),
        }
    } catch (error) {
        connectionState.healthy = false
        connectionState.failedQueries++
        
        return {
            ok: false as const,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
        }
    }
}

/**
 * Get connection pool statistics
 */
export async function getPoolStats() {
    try {
        // Query Supabase for connection stats
        const result = await queryClient`
            SELECT 
                count(*) as total_connections,
                count(*) FILTER (WHERE state = 'active') as active_connections,
                count(*) FILTER (WHERE state = 'idle') as idle_connections,
                count(*) FILTER (WHERE state = 'idle in transaction') as idle_in_transaction
            FROM pg_stat_activity 
            WHERE datname = current_database()
        `
        
        return {
            pool: {
                max: Number(process.env.DB_POOL_MAX || 20),
                idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS || 10),
            },
            connections: result[0] || {},
            state: connectionState,
        }
    } catch (error) {
        return {
            pool: {
                max: Number(process.env.DB_POOL_MAX || 20),
                idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_SECONDS || 10),
            },
            connections: null,
            state: connectionState,
            error: error instanceof Error ? error.message : 'Failed to get pool stats',
        }
    }
}

/**
 * Execute a query with automatic retry on connection failure
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 100
): Promise<T> {
    let lastError: Error | null = null
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            connectionState.totalQueries++
            return await fn()
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
            connectionState.failedQueries++
            
            // Check if it's a connection error that should be retried
            const isConnectionError = 
                lastError.message.includes('ECONNRESET') ||
                lastError.message.includes('ETIMEDOUT') ||
                lastError.message.includes('connection') ||
                lastError.message.includes('timeout')
            
            if (!isConnectionError || attempt === maxRetries - 1) {
                throw lastError
            }
            
            // Exponential backoff
            const delay = delayMs * Math.pow(2, attempt)
            console.warn(`[DB] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`)
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }
    
    throw lastError
}

/**
 * Close database connection gracefully
 */
export async function closeDatabaseConnection() {
    try {
        await queryClient.end()
        console.log('[DB] Connection pool closed')
    } catch (error) {
        console.error('[DB] Error closing connection:', error)
    }
}

// Export schema for convenience
export * from './schema'
