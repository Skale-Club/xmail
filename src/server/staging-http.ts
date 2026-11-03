import express from 'express'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StagingHttpConfig } from './staging-config'

type ReaderProof = {
    database: string; current_role: string; session_role: string; read_only: string
    login: boolean; superuser: boolean; create_db: boolean; create_role: boolean; replication: boolean; bypass_rls: boolean
    memberships: number; tables: number; readable: number; owns_database: boolean; owns_tables: boolean
    create_schema: boolean; create_database: boolean; temp_database: boolean; table_writes: boolean
    sequence_writes: boolean; function_execute: boolean
}
const proofSql = `SELECT current_database() AS database,current_user AS current_role,session_user AS session_role,
 current_setting('transaction_read_only') AS read_only,r.rolcanlogin AS login,r.rolsuper AS superuser,
 r.rolcreatedb AS create_db,r.rolcreaterole AS create_role,r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,
 (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid) AS memberships,
 (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS tables,
 (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT')) AS readable,
 (SELECT datdba=r.oid FROM pg_database WHERE datname=current_database()) AS owns_database,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'USAGE')) AS owns_tables,
 has_schema_privilege(current_user,'public','CREATE') AS create_schema,
 has_database_privilege(current_user,current_database(),'CREATE') AS create_database,
 has_database_privilege(current_user,current_database(),'TEMP') AS temp_database,
 EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS table_writes,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE')) AS sequence_writes,
 EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS function_execute
 FROM pg_roles r WHERE r.rolname=current_user`

function assertReader(proof?: ReaderProof) {
    if (!proof || proof.database !== 'xmail' || proof.current_role !== 'xmail_staging_reader' || proof.session_role !== 'xmail_staging_reader'
        || proof.read_only !== 'on' || proof.login !== true || proof.bypass_rls !== true || proof.memberships !== 0
        || proof.tables !== 70 || proof.readable !== 70
        || ['superuser', 'create_db', 'create_role', 'replication', 'owns_database', 'owns_tables', 'create_schema',
            'create_database', 'temp_database', 'table_writes', 'sequence_writes', 'function_execute'].some(key => proof[key as keyof ReaderProof] !== false)) {
        throw new Error('Staging reader authority is unavailable.')
    }
}
async function verifyReader(tx: TransactionSql) { assertReader((await tx.unsafe<ReaderProof[]>(proofSql))[0]) }
async function readSummary(sql: Sql) {
    return sql.begin('read only', async tx => {
        await verifyReader(tx)
        const rows = await tx.unsafe(`SELECT (SELECT count(*)::int FROM public.users) AS users,
          (SELECT count(*)::int FROM public.organization_users) AS organization_users,
          (SELECT count(*)::int FROM public.users WHERE is_admin) AS platform_admins,
          (SELECT count(*)::int FROM public.users WHERE password_hash IS NOT NULL AND password_hash<>'') AS native_password_hashes`)
        return rows[0]
    })
}

/** Deliberately does not import legacy routes, Supabase, mail, jobs or integrations. */
export async function startStagingHttp(config: StagingHttpConfig) {
    const sql = postgres(config.databaseUrl, { max: 2, prepare: false, connect_timeout: 8, idle_timeout: 10,
        ssl: false, onnotice: () => {}, connection: { application_name: 'xmail-staging-http-only',
            default_transaction_read_only: 'on', statement_timeout: '5000', lock_timeout: '500' } })
    try { await sql.begin('read only', verifyReader) } catch {
        await sql.end({ timeout: 2 }); throw new Error('Staging reader startup verification failed.')
    }
    const app = express()
    app.disable('x-powered-by')
    let expectedHost = new URL(config.origin).host
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" })
        if (req.get('host') !== expectedHost) return res.status(403).json({ error: 'Staging host is not allowed.' })
        if (req.method !== 'GET') return res.status(405).json({ error: 'HTTP staging is read-only.' })
        if (req.get('content-length') || req.get('transfer-encoding')) return res.status(400).json({ error: 'Staging requests must not have a body.' })
        if (!['/health', '/health/ready', '/api/staging/summary'].includes(req.path)) return res.status(403).json({ error: 'Route is unavailable in HTTP staging.' })
        next()
    })
    app.get('/health', (_req, res) => res.json({ status: 'ok', mode: 'staging-http-only', sideEffectsEnabled: false }))
    app.get(['/health/ready', '/api/staging/summary'], (_req, res) => { void readSummary(sql)
        .then(summary => res.json({ status: 'ok', mode: 'staging-http-only', summary }))
        .catch(() => res.status(503).json({ error: 'Staging database is unavailable.' })) })
    let server: Server
    try {
        server = await new Promise<Server>((resolve, reject) => {
            const listener: Server = app.listen(config.port, '127.0.0.1', () => resolve(listener))
            listener.once('error', reject)
        })
    } catch { await sql.end({ timeout: 2 }); throw new Error('Staging HTTP listener is unavailable.') }
    if (config.port === 0) expectedHost = `127.0.0.1:${(server.address() as AddressInfo).port}`
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000
    const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await sql.end({ timeout: 2 }) }
    const shutdown = () => { void close().finally(() => { process.exitCode = 0 }) }
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
    return { app, server, close: async () => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); await close() } }
}
