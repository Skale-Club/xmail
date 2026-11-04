import { resolveStagingHttpConfig } from './staging-config'

/** Importing this selector alone has no database, network or startup side effects. */
export async function startSelectedRuntime(env: NodeJS.ProcessEnv = process.env) {
    const config = resolveStagingHttpConfig(env)
    if (!config) return import('./production-server')
    const { startStagingHttp } = await import('./staging-http')
    return startStagingHttp(config)
}
