import { createClient } from '@supabase/supabase-js'
import { legacyBrowserAuthConfirmed, subscribeBrowserAuthBoundary } from './browser-auth-authority'

const runtimeConfig = typeof window !== 'undefined' ? window.__APP_CONFIG__ : undefined
const supabaseUrl = runtimeConfig?.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = runtimeConfig?.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY

let client: ReturnType<typeof createClient> | undefined
subscribeBrowserAuthBoundary(() => {
    if (client && !legacyBrowserAuthConfirmed()) void client.auth.stopAutoRefresh().catch(() => {})
})
// Imports cannot restore browser storage, detect recovery URL tokens or start an
// auto-refresh timer. Only a confirmed server legacy authority permits creation.
export const supabase = new Proxy({} as ReturnType<typeof createClient>, {
    get(_target, property) {
        if (!legacyBrowserAuthConfirmed()) throw new Error('Legacy browser authentication is unavailable.')
        if (!supabaseUrl || !supabaseAnonKey) throw new Error('Missing Supabase environment variables')
        // Refresh is explicit and preceded by a fresh authority check in callers.
        client ??= createClient(supabaseUrl, supabaseAnonKey, { auth: { autoRefreshToken: false } })
        return Reflect.get(client, property, client)
    },
})

// Types for Supabase auth
export interface AuthUser {
    id: string
    email: string
    aud: string
    role?: string
    email_confirmed_at?: string
    phone?: string
    confirmed_at?: string
    last_sign_in_at?: string
    app_metadata?: Record<string, unknown>
    user_metadata?: {
        firstName?: string
        lastName?: string
        avatarUrl?: string
    }
    identities?: unknown[]
    created_at?: string
    updated_at?: string
}

export interface AuthSession {
    access_token: string
    token_type: string
    expires_in: number
    expires_at?: number
    refresh_token: string
    user: AuthUser
}
