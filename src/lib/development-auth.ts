type Environment = Record<string, string | undefined>

/** Development never falls back to production Auth or browser configuration. */
export function resolveDevelopmentAuth(env: Environment) {
    const ref = env.XMAIL_DEV_SUPABASE_PROJECT_REF?.trim()
    if (!ref || !/^[a-z0-9]{20}$/.test(ref)) {
        throw new Error('Development Auth requires XMAIL_DEV_SUPABASE_PROJECT_REF')
    }
    const productionUrls = [env.SUPABASE_URL, env.VITE_SUPABASE_URL]
    if (productionUrls.some(url => /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url || '')?.[1] === ref)
        || env.XMAIL_PRODUCTION_SUPABASE_PROJECT_REF === ref) {
        throw new Error('Development Auth must not use the production Supabase project')
    }
    const anonKey = env.XMAIL_DEV_SUPABASE_ANON_KEY
    if (!anonKey?.trim()) {
        throw new Error('Development Auth requires XMAIL_DEV_SUPABASE_ANON_KEY; production aliases are never used')
    }
    return { url: `https://${ref}.supabase.co`, anonKey }
}

export function resolveDevelopmentServerAuth(env: Environment) {
    const publicConfig = resolveDevelopmentAuth(env)
    const serviceRoleKey = env.XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY
    if (!serviceRoleKey?.trim()) {
        throw new Error('Development Auth requires XMAIL_DEV_SUPABASE_SERVICE_ROLE_KEY; production aliases are never used')
    }
    return { ...publicConfig, serviceRoleKey }
}
