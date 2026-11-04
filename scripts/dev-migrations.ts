import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { resolveDatabaseTarget } from '../src/db/database-target'

const args = process.argv.slice(2)
if (args.length !== 1 || !['--plan', '--apply'].includes(args[0])) {
    throw new Error('Use --plan to list pending migrations or --apply to explicitly apply them to development')
}
const target = resolveDatabaseTarget({ ...process.env, NODE_ENV: 'development' })
const result = spawnSync(process.execPath, [
    'scripts/apply-pending-migrations.mjs',
    ...(args[0] === '--plan' ? ['--plan'] : []),
], {
    stdio: 'inherit',
    env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: target.jobDatabaseUrl,
        DIRECT_URL: target.jobDatabaseUrl,
    },
})
process.exitCode = result.status ?? 1
