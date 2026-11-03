type DatabaseEnvironment = Record<string, string | undefined>

function developmentProject(url: string, projectRef: string): void {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        throw new Error('Invalid XMAIL_DEV database URL (value omitted)')
    }
    const direct = parsed.hostname === `db.${projectRef}.supabase.co`
    const pooler = parsed.hostname.endsWith('.pooler.supabase.com')
        && decodeURIComponent(parsed.username) === `postgres.${projectRef}`
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
        || (!direct && !pooler) || parsed.pathname !== '/postgres') {
        throw new Error('XMAIL_DEV database URL must target the explicitly approved Supabase development project')
    }
}

/** Select before constructing either pool. Never inherit production aliases in development. */
export function resolveDatabaseTarget(env: DatabaseEnvironment) {
    if (env.NODE_ENV !== 'development') {
        if (!env.DATABASE_URL) throw new Error('Missing DATABASE_URL')
        return { databaseUrl: env.DATABASE_URL, jobDatabaseUrl: env.DIRECT_URL || env.DATABASE_URL }
    }

    const projectRef = env.XMAIL_DEV_SUPABASE_PROJECT_REF?.trim()
    const databaseUrl = env.XMAIL_DEV_DATABASE_URL
    if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef) || !databaseUrl) {
        throw new Error('Development requires XMAIL_DEV_SUPABASE_PROJECT_REF and XMAIL_DEV_DATABASE_URL; production aliases are never used')
    }
    developmentProject(databaseUrl, projectRef)
    const jobDatabaseUrl = env.XMAIL_DEV_DIRECT_URL || databaseUrl
    developmentProject(jobDatabaseUrl, projectRef)
    return { databaseUrl, jobDatabaseUrl }
}
