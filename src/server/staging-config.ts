export interface StagingHttpConfig { databaseUrl: string; origin: string; port: number }
type Env = Record<string, string | undefined>
const fail = (): never => { throw new Error('Explicit isolated HTTP staging configuration is required.') }

export function resolveStagingHttpConfig(env: Env): StagingHttpConfig | null {
    const flag = env.XMAIL_STAGING_HTTP_ONLY
    if (flag !== undefined && !['true', 'false'].includes(flag)) fail()
    if (flag !== 'true') {
        if (env.XMAIL_STAGING_DATABASE_URL || env.XMAIL_STAGING_ORIGIN) fail()
        return null
    }
    if (env.NODE_ENV === 'development' || env.XMAIL_GOOGLE_AUTH_ENABLED === 'true' || env.GOOGLE_AUTH_ENABLED === 'true') fail()
    try {
        const target = new URL(env.XMAIL_STAGING_DATABASE_URL || '')
        if (!['postgres:', 'postgresql:'].includes(target.protocol)
            || target.hostname !== 'e12scyfsrp822dag7m9wwd4x' || target.port !== '5432' || target.pathname !== '/xmail'
            || decodeURIComponent(target.username) !== 'xmail_staging_reader' || !target.password
            || /[\r\n]/.test(decodeURIComponent(target.password)) || target.search || target.hash) fail()
        const origin = new URL(env.XMAIL_STAGING_ORIGIN || '')
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/'
            || origin.username || origin.password || origin.search || origin.hash) fail()
        const port = Number(origin.port)
        if (!Number.isInteger(port) || port > 65535 || port < (env.NODE_ENV === 'test' ? 0 : 1)) fail()
        return { databaseUrl: target.href, origin: origin.origin, port }
    } catch { return fail() }
}
