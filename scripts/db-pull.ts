// npm run db:pull — replace the DEVELOPMENT database (Supabase) with a snapshot of production.
// `npm run dev` never does this on its own; only this explicit command does.
//
// 1. Over SSH, find the production database container's private address and
//    credentials. They stay in memory; the database is never exposed.
// 2. Open a temporary SSH tunnel (127.0.0.1 only) and refuse any destination that is
//    not the declared Supabase development project (XMAIL_DEV_*), or that is a known
//    production project.
// 3. Save a JSON backup of the destination (../xmail-db-backups/).
// 4. Bring the destination schema to the repo's state with the SQL migrations
//    (scripts/dev-migrations.ts --apply; never db:push) and compare it with
//    production. Any difference aborts before data moves.
// 5. Read production in one READ ONLY snapshot and replace the destination data in ONE
//    transaction: any error leaves the destination untouched. Sign-in state stays
//    local (EXCLUDED_TABLES) and mailbox passwords, Outlook tokens and the Telegram
//    token are never copied (SCRUBBED_COLUMNS).
// 6. Close the tunnel.
//
// Settings (none secret), in .env:
//   XMAIL_PROD_SSH            ssh target of the Coolify server (e.g. root@<host>)
//   XMAIL_PROD_DB_CONTAINER   production PostgreSQL container (default below)
//   XMAIL_PROD_DB_NAME        optional; default is the container's own POSTGRES_DB
//   XMAIL_DEV_DATABASE_URL, XMAIL_DEV_SUPABASE_PROJECT_REF   the destination, as for npm run dev
// Flags: --allow-triggers  copy even if user triggers cannot be disabled.

import 'dotenv/config'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import postgres from 'postgres'
import {
    assertPullDestination, backupDestination, EXCLUDED_TABLES, postgresJsDb, pullDatabase, SCRUBBED_COLUMNS,
} from '../src/server/lib/dev-db-pull'
import { installDevOutboundGuard } from '../src/server/lib/dev-outbound-guard'

const SSH_TARGET = process.env.XMAIL_PROD_SSH
const CONTAINER = process.env.XMAIL_PROD_DB_CONTAINER || 'e12scyfsrp822dag7m9wwd4x'
const TUNNEL_PORT = 55434
const BACKUP_DIR = resolve(process.cwd(), '..', 'xmail-db-backups')

function fail(message: string): never {
    throw new Error(message)
}

function ssh(remote: string, what: string): string {
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', SSH_TARGET!, remote], { encoding: 'utf8' })
    if (r.status !== 0) fail(`${what}: ${(r.stderr || '').trim().split('\n').pop() || `ssh exited with ${r.status}`}`)
    return r.stdout
}

/** Private address + credentials of the production DB container, read on the server. */
function productionTarget() {
    if (!/^[a-z0-9]+$/.test(CONTAINER)) fail('XMAIL_PROD_DB_CONTAINER must be a plain container name')
    const ip = ssh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${CONTAINER}`, 'finding the production database')
        .trim().split(/\s+/)[0]
    if (!ip) fail(`container ${CONTAINER} has no network address`)
    // Single quotes: the variables expand inside the container, not on this machine.
    const [user, password, containerDb] = ssh(`docker exec ${CONTAINER} sh -c 'printf "%s\\n%s\\n%s" "$POSTGRES_USER" "$POSTGRES_PASSWORD" "$POSTGRES_DB"'`, 'reading the production database settings').split('\n')
    const db = process.env.XMAIL_PROD_DB_NAME || containerDb
    if (!user || !db) fail('could not read the production database user and name')
    return { ip, url: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@127.0.0.1:${TUNNEL_PORT}/${encodeURIComponent(db)}` }
}

async function openTunnel(ip: string) {
    const tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', `127.0.0.1:${TUNNEL_PORT}:${ip}:5432`, SSH_TARGET!], { stdio: 'ignore' })
    for (let i = 0; i < 40; i++) {
        if (tunnel.exitCode !== null) fail(`ssh tunnel closed (port ${TUNNEL_PORT} busy?)`)
        const open = await new Promise<boolean>(done => {
            const sock = createConnection(TUNNEL_PORT, '127.0.0.1')
            sock.once('connect', () => { sock.destroy(); done(true) })
            sock.once('error', () => done(false))
        })
        if (open) return tunnel
        await new Promise(r => setTimeout(r, 250))
    }
    tunnel.kill()
    return fail('ssh tunnel did not open')
}

/** One connection only: the pull drives BEGIN/COMMIT itself. */
function connect(url: string, tls: boolean) {
    return postgres(url, { max: 1, prepare: false, ssl: tls ? 'require' : false, onnotice: () => undefined, connect_timeout: 30 })
}

/** Level the destination schema with the repo's SQL migrations, in a child process. */
function migrateDestination() {
    console.log('→ applying pending SQL migrations to the development database ...')
    const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/dev-migrations.ts', '--apply'], {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'development' },
    })
    if (r.status !== 0) fail(`migrations failed (exit ${r.status}); the data was not touched. A development database whose migration ledger is empty needs a baseline first (docs/dev-database-pull.md).`)
}

async function main() {
    if (!SSH_TARGET) fail('set XMAIL_PROD_SSH (the ssh target of the Coolify server)')
    const destination = assertPullDestination(process.env)
    // The pull itself only needs loopback (the tunnel) and the development database.
    installDevOutboundGuard({ ...process.env, NODE_ENV: 'development' })
    console.log(`→ destination: development project ${destination.projectRef} (${destination.host})`)

    const backupClient = connect(destination.url, true)
    try {
        console.log('→ backing up the development database ...')
        console.log(`✓ backup ${await backupDestination(postgresJsDb(backupClient), BACKUP_DIR)}`)
    } finally {
        await backupClient.end({ timeout: 5 })
    }

    migrateDestination()

    console.log(`→ connecting to production through ${SSH_TARGET} ...`)
    const target = productionTarget()
    const tunnel = await openTunnel(target.ip)
    const prodSql = connect(target.url, false)
    const destSql = connect(destination.url, true)
    try {
        const result = await pullDatabase({
            prod: postgresJsDb(prodSql),
            dest: postgresJsDb(destSql),
            destUrl: destination.url,
            allowTriggers: process.argv.includes('--allow-triggers'),
            log: m => console.warn(m),
        })
        const rows = Object.entries(result.copied).filter(([, n]) => n > 0).map(([t, n]) => `${t}=${n}`)
        console.log(`✓ copied ${rows.length} tables with data: ${rows.join(' ')}`)
        if (result.truncated.length) console.log(`✓ emptied dependents (not refilled): ${result.truncated.join(', ')}`)
        console.log(`✓ secrets blanked: ${result.scrubbed.join(', ') || '-'}`)
        console.log(`✓ kept local: ${result.kept.join(', ') || '-'} (excluded by rule: ${EXCLUDED_TABLES.join(', ')})`)
        console.log(`✓ done. Scrub rules: ${Object.keys(SCRUBBED_COLUMNS).join(', ')}. npm run dev can neither send nor receive real mail.`)
    } finally {
        await prodSql.end({ timeout: 5 }).catch(() => undefined)
        await destSql.end({ timeout: 5 }).catch(() => undefined)
        tunnel.kill()
    }
}

main().catch(e => {
    console.error(`✗ ${(e as Error).message}`)
    process.exit(1)
})
