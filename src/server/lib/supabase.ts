import { createClient } from '@supabase/supabase-js'
import { resolveDevelopmentServerAuth } from '../../lib/development-auth'

const auth = process.env.NODE_ENV === 'development'
    ? resolveDevelopmentServerAuth(process.env)
    : { url: process.env.SUPABASE_URL!, anonKey: process.env.SUPABASE_ANON_KEY!, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY! }
const supabaseUrl = auth.url
const supabaseAnonKey = auth.anonKey
const supabaseServiceRoleKey = auth.serviceRoleKey

export const supabasePublicConfig = { url: supabaseUrl, anonKey: supabaseAnonKey }

export const supabaseAnonClient = createClient(supabaseUrl, supabaseAnonKey)
export const supabaseAdminClient = createClient(supabaseUrl, supabaseServiceRoleKey)

export function createSupabaseUserClient(accessToken: string) {
    return createClient(supabaseUrl, supabaseAnonKey, {
        global: {
            headers: { Authorization: `Bearer ${accessToken}` },
        },
    })
}

export async function checkSupabaseAuthHealth(timeoutMs = 5_000) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const response = await fetch(`${supabaseUrl}/auth/v1/settings`, {
            method: 'GET',
            headers: {
                apikey: supabaseAnonKey,
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
