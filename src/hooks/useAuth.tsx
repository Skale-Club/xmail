import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { apiFetch, clearTokenCache } from '../lib/api-client'
import { supabase } from '../lib/supabase'
import { ownedIdentityActive, probeOwnedIdentitySession } from '../lib/owned-identity'
import { browserAuthGeneration, legacyBrowserAuthSnapshotCurrent, requireLegacyBrowserAuth, subscribeBrowserAuthBoundary } from '../lib/browser-auth-authority'

interface User {
    id: string
    email: string
    user_metadata?: {
        firstName?: string
        lastName?: string
    }
}

interface AuthState {
    user: User | null
    isAdmin: boolean | null
    isLoading: boolean
}

const AuthContext = createContext<AuthState>({
    user: null,
    isAdmin: null,
    isLoading: true,
})

function useProvideAuth(): AuthState {
    const [user, setUser] = useState<User | null>(null)
    const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const mounted = useRef(true), profileVersion = useRef(0), profileAbort = useRef<AbortController>()

    async function fetchProfile(token?: string) {
        const generation = browserAuthGeneration()
        const version = ++profileVersion.current
        profileAbort.current?.abort()
        const controller = new AbortController()
        profileAbort.current = controller
        const timeout = window.setTimeout(() => controller.abort(), 10_000)
        try {
            const data = await apiFetch<{ user?: { isAdmin?: boolean } }>('/api/users/profile', {
                auth: !token,
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                signal: controller.signal,
            })
            if (mounted.current && version === profileVersion.current && legacyBrowserAuthSnapshotCurrent(generation) && !ownedIdentityActive()) setIsAdmin(data.user?.isAdmin === true)
        } catch {
            if (mounted.current && version === profileVersion.current && legacyBrowserAuthSnapshotCurrent(generation) && !ownedIdentityActive()) setIsAdmin(null)
        } finally { window.clearTimeout(timeout) }
    }

    useEffect(() => {
        let bootstrapComplete = false
        mounted.current = true
        let cancelled = false
        let unsubscribe: (() => void) | undefined
        const unsubscribeBoundary = subscribeBrowserAuthBoundary(() => {
            if (ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(browserAuthGeneration())) {
                profileVersion.current++; profileAbort.current?.abort()
                setUser(null); setIsAdmin(null); clearTokenCache()
            }
        })
        const initializeAuth = async () => {
            try {
                const owned = await probeOwnedIdentitySession()
                if (cancelled) return
                if (owned.kind === 'active' && owned.user) {
                    setUser({ id: owned.user.id, email: owned.user.email, user_metadata: {
                        firstName: owned.user.user_metadata?.firstName ?? undefined, lastName: owned.user.user_metadata?.lastName ?? undefined,
                    } })
                    setIsAdmin(owned.user.isAdmin === true)
                    return
                }
                if (owned.kind === 'expired') { setUser(null); setIsAdmin(false); return }
                if (owned.kind === 'unavailable') { setUser(null); setIsAdmin(null); return }
                await requireLegacyBrowserAuth()
                if (cancelled) return
                const generation = browserAuthGeneration()
                // Race against a timeout so the app never stays on the spinner forever
                const sessionResult = await Promise.race([
                    supabase.auth.getSession(),
                    new Promise<never>((_, reject) =>
                        window.setTimeout(() => reject(new Error('Session timeout')), 10_000)
                    ),
                ])

                const { data: { session }, error } = sessionResult
                if (cancelled || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) return

                if (error) throw error

                if (session?.user) {
                    setUser(session.user as User)
                    await fetchProfile(session.access_token)
                } else {
                    setUser(null)
                    setIsAdmin(false)
                }
                if (cancelled || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) return
                const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
                    if (cancelled || !bootstrapComplete || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) return
                    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session?.user) {
                        setUser(session.user as User)
                        await fetchProfile(session.access_token)
                    } else if (event === 'SIGNED_OUT') {
                        setUser(null); setIsAdmin(false); clearTokenCache()
                    }
                    setIsLoading(false)
                })
                unsubscribe = () => subscription.unsubscribe()
            } catch {
                if (!cancelled) { setUser(null); setIsAdmin(null) }
            } finally {
                bootstrapComplete = true
                if (!cancelled) setIsLoading(false)
            }
        }

        void initializeAuth()

        return () => {
            cancelled = true
            mounted.current = false; profileVersion.current++; profileAbort.current?.abort()
            unsubscribeBoundary()
            unsubscribe?.()
        }
    }, [])

    // Retry fetchProfile when isAdmin is null (transient error) and user is logged in
    const retryCount = useRef(0)
    useEffect(() => {
        if (isAdmin !== null || !user || isLoading) {
            retryCount.current = 0
            return
        }

        if (retryCount.current >= 3) {
            setIsAdmin(false)
            return
        }

        const timer = window.setTimeout(() => {
            retryCount.current++
            void fetchProfile()
        }, 2000)

        return () => window.clearTimeout(timer)
    }, [isAdmin, user, isLoading])

    return { user, isAdmin, isLoading }
}

export function useAuth(): AuthState {
    return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const auth = useProvideAuth()
    return (
        <AuthContext.Provider value={auth}>
            {children}
        </AuthContext.Provider>
    )
}
