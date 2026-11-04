import { createClient } from '@supabase/supabase-js'
import { resolveDevelopmentServerAuth } from '../../lib/development-auth'
import { browserAuthAuthority } from './identity/browser-auth-authority'

function settings() {
    return process.env.NODE_ENV === 'development' ? resolveDevelopmentServerAuth(process.env)
        : { url: process.env.SUPABASE_URL || '', anonKey: process.env.SUPABASE_ANON_KEY || '', serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '' }
}
// Legacy development still validates isolation before any consumer can select
// production aliases. Owned startup needs no hosted Auth settings merely to import.
const auth = browserAuthAuthority(process.env) === 'owned' ? { url: '', anonKey: '' } : settings()
export const supabasePublicConfig = { url: auth.url, anonKey: auth.anonKey }
const serverOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

function requireLegacyAuth() {
    if (browserAuthAuthority(process.env) !== 'legacy') throw new Error('Legacy server authentication is unavailable.')
}
function lazyClient(kind: 'anonKey' | 'serviceRoleKey'): ReturnType<typeof createClient> {
    let client: ReturnType<typeof createClient> | undefined
    return new Proxy({} as ReturnType<typeof createClient>, {
        get(_target, property) {
            if (property === 'auth') requireLegacyAuth()
            const config = settings()
            if (!config.url || !config[kind]) throw new Error('Legacy provider configuration is unavailable.')
            client ??= createClient(config.url, config[kind], serverOptions)
            return Reflect.get(client, property, client)
        },
    })
}
export const supabaseAnonClient = lazyClient('anonKey')
// Storage remains an explicit legacy dependency until its independent cutover.
export const supabaseAdminClient = lazyClient('serviceRoleKey')

export function createSupabaseUserClient(accessToken: string) {
    requireLegacyAuth()
    const config = settings()
    if (!config.url || !config.anonKey) throw new Error('Legacy provider configuration is unavailable.')
    return createClient(config.url, config.anonKey, {
        ...serverOptions,
        global: {
            headers: { Authorization: `Bearer ${accessToken}` },
        },
    })
}

export async function checkSupabaseAuthHealth(timeoutMs = 5_000) {
    requireLegacyAuth()
    const config = settings()
    if (!config.url || !config.anonKey) throw new Error('Legacy provider configuration is unavailable.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const response = await fetch(`${config.url}/auth/v1/settings`, {
            method: 'GET',
            headers: {
                apikey: config.anonKey,
            },
            signal: controller.signal,
        })

        if (!response.ok) {
            throw new Error(`Supabase auth healthcheck failed with status ${response.status}`)
        }

        return { ok: true as const }
    } finally {
        clearTimeout(timeout)
    }
}
