import { findProductionProjectRef } from './production-project-refs'

type DatabaseEnvironment = Record<string, string | undefined>

function developmentProject(url: string, projectRef: string): string {
    let parsed: URL
    let username: string
    try {
        parsed = new URL(url)
        username = decodeURIComponent(parsed.username)
        // postgres.js decodes both components while constructing a client.
        // Validate here so malformed configuration never escapes as a raw error.
        decodeURIComponent(parsed.password)
    } catch {
        throw new Error('Invalid XMAIL_DEV database URL (value omitted)')
    }
    if (findProductionProjectRef(projectRef) || findProductionProjectRef(url)) {
        throw new Error('The development project is a known production or retired production project')
    }
    const direct = parsed.hostname === `db.${projectRef}.supabase.co` && username === 'postgres'
    const pooler = parsed.hostname.endsWith('.pooler.supabase.com')
        && username === `postgres.${projectRef}`
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
        || (!direct && !pooler) || parsed.pathname !== '/postgres'
        || !parsed.password || (parsed.port && parsed.port !== '5432') || parsed.hash) {
        throw new Error('XMAIL_DEV database URL must target the explicitly approved Supabase development project')
    }

    // Only session/direct PostgreSQL with mandatory TLS is supported in dev.
    // Do not let arbitrary URI options enable driver debugging, change startup
    // parameters or weaken TLS after the target has passed the project check.
    const sslModes = parsed.searchParams.getAll('sslmode')
    if ([...parsed.searchParams.keys()].some(key => key !== 'sslmode')
        || sslModes.length > 1
        || (sslModes.length === 1 && !['require', 'verify-ca', 'verify-full'].includes(sslModes[0]))) {
        throw new Error('XMAIL_DEV database URL supports only a required TLS sslmode option (value omitted)')
    }
    parsed.port = '5432'
    if (sslModes.length === 0) parsed.searchParams.set('sslmode', 'require')
    return parsed.toString()
}

/** Select before constructing either pool. Never inherit production aliases in development. */
export function resolveDatabaseTarget(env: DatabaseEnvironment) {
    if (env.NODE_ENV !== 'development') {
        if (!env.DATABASE_URL) throw new Error('Missing DATABASE_URL')
        return { databaseUrl: env.DATABASE_URL, jobDatabaseUrl: env.DIRECT_URL || env.DATABASE_URL }
    }

    const projectRef = env.XMAIL_DEV_SUPABASE_PROJECT_REF?.trim()
    const configuredUrl = env.XMAIL_DEV_DATABASE_URL
    if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef) || !configuredUrl) {
        throw new Error('Development requires XMAIL_DEV_SUPABASE_PROJECT_REF and XMAIL_DEV_DATABASE_URL; production aliases are never used')
    }
    const databaseUrl = developmentProject(configuredUrl, projectRef)
    const jobDatabaseUrl = developmentProject(env.XMAIL_DEV_DIRECT_URL || databaseUrl, projectRef)
    return { databaseUrl, jobDatabaseUrl }
}
