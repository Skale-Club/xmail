type Environment = Record<string, string | undefined>
type Targets = { databaseUrl: string; jobDatabaseUrl?: string }

function integer(env: Environment, name: string, fallback: number, minimum: number, maximum: number) {
    const value = env[name]
    if (value === undefined || value === '') return fallback
    if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${name} database pool setting.`)
    const result = Number(value)
    if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${name} database pool setting.`)
    return result
}
function targetIdentity(value: string) {
    try {
        const url = new URL(value)
        return { host: url.hostname, port: url.port || '5432', database: url.pathname, role: decodeURIComponent(url.username),
            privateOptionsSafe: ['postgres:', 'postgresql:'].includes(url.protocol) && !url.search && !url.hash }
    } catch { throw new Error('Database pool target configuration is unavailable.') }
}

/** Static declared budget only; never opens connections or changes role grants.
 * Owned identity shares the HTTP client. Isolated staging uses a different role. */
export function resolveDatabasePoolBudget(env: Environment, targets: Targets) {
    const http = integer(env, 'DB_POOL_MAX', 20, 1, 512)
    const jobs = integer(env, 'DB_JOB_POOL_MAX', 12, 1, 512)
    const admin = integer(env, 'XMAIL_ADMIN_DB_POOL_MAX', 2, 1, 2)
    const httpTarget = targetIdentity(targets.databaseUrl)
    const jobTarget = targetIdentity(targets.jobDatabaseUrl || targets.databaseUrl)
    const privateRole = httpTarget.role === 'xmail_runtime' || jobTarget.role === 'xmail_runtime'
    if (privateRole && (httpTarget.role !== 'xmail_runtime' || jobTarget.role !== 'xmail_runtime'
        || !httpTarget.privateOptionsSafe || !jobTarget.privateOptionsSafe
        || httpTarget.host !== jobTarget.host || httpTarget.port !== jobTarget.port || httpTarget.database !== jobTarget.database)) {
        throw new Error('Private runtime HTTP and job pools must use the same reviewed database and role.')
    }
    const enforced = privateRole || env.XMAIL_BROWSER_AUTH_AUTHORITY === 'owned'
        || (env.XMAIL_DB_ROLE_CONNECTION_LIMIT !== undefined && env.XMAIL_DB_ROLE_CONNECTION_LIMIT !== '')
    const processes = integer(env, 'XMAIL_DB_PROCESS_COUNT', 1, 1, 10)
    const reserve = integer(env, 'XMAIL_DB_CONNECTION_RESERVE', 2, 2, 20)
    // The prepared candidate role has CONNECTION LIMIT20. Raising this ceiling
    // requires a separate reviewed role/operational change, never a larger env claim.
    const roleLimit = integer(env, 'XMAIL_DB_ROLE_CONNECTION_LIMIT', 20, 1, 20)
    const perProcess = http + jobs + admin
    const total = perProcess * processes + reserve
    if (enforced && total > roleLimit) throw new Error('Declared runtime database pools exceed the reviewed connection budget. Configure HTTP, jobs, administration and rollout processes explicitly.')
    return { http, jobs, admin, perProcess, processes, reserve, total, roleLimit, enforced }
}
