import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { clearTokenCache } from '../lib/api-client'
import { ownedIdentityActive, probeOwnedIdentitySession } from '../lib/owned-identity'
import { browserAuthGeneration, legacyBrowserAuthConfirmed, legacyBrowserAuthSnapshotCurrent, requireLegacyBrowserAuth, subscribeBrowserAuthBoundary } from '../lib/browser-auth-authority'
import {
    type StoredSession,
    type SessionInfo,
    getStoredSessions,
    addStoredSession,
    updateStoredSessionTokens,
    removeStoredSession,
    getActiveSessionId,
    setActiveSessionId,
    clearAllSessions,
    toSessionInfo,
    supabaseSessionToStored,
} from '../lib/session-store'

interface MultiSessionContextType {
    sessions: SessionInfo[]
    activeSessionId: string | null
    switchSession: (userId: string) => Promise<void>
    removeAccount: (userId: string) => Promise<void>
}

const MultiSessionContext = createContext<MultiSessionContextType | null>(null)
async function signOutLegacy() { await requireLegacyBrowserAuth(); await supabase.auth.signOut() }

export function MultiSessionProvider({ children }: { children: React.ReactNode }) {
    const queryClient = useQueryClient()
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null)
    const [initialized, setInitialized] = useState(false)
    const mounted = useRef(true)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

    const refreshSessions = useCallback(() => {
        const stored = getStoredSessions()
        setSessions(stored.map(toSessionInfo))
        return stored
    }, [])

    const initializeActiveSession = useCallback(async (stored: StoredSession[]) => {
        await requireLegacyBrowserAuth()
        if (!mounted.current) return
        const generation = browserAuthGeneration()
        const savedActiveId = getActiveSessionId()
        const target = savedActiveId
            ? stored.find(s => s.userId === savedActiveId)
            : stored[0]

        if (target) {
            try {
                const { error } = await supabase.auth.setSession({
                    access_token: target.accessToken,
                    refresh_token: target.refreshToken,
                })
                if (!mounted.current || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) return
                if (error) {
                    if (stored.length > 1) {
                        removeStoredSession(target.userId)
                        const remaining = getStoredSessions()
                        refreshSessions()
                        if (remaining.length > 0) {
                            initializeActiveSession(remaining)
                        } else {
                            clearAllSessions()
                            await signOutLegacy()
                        }
                    } else {
                        clearAllSessions()
                        await signOutLegacy()
                    }
                    return
                }
                setActiveSessionIdState(target.userId)
            } catch {
                if (!mounted.current || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) return
                clearAllSessions()
                await signOutLegacy().catch(() => {})
            }
        }
    }, [refreshSessions])

    useEffect(() => {
        return subscribeBrowserAuthBoundary(() => {
            if (ownedIdentityActive() || !legacyBrowserAuthConfirmed()) {
                setSessions([]); setActiveSessionIdState(null); queryClient.clear(); clearTokenCache()
            }
        })
    }, [queryClient])

    useEffect(() => {
        let cancelled = false
        // Share the own-cookie probe with AuthProvider before restoring any saved
        // legacy credential. Once absent/disabled, preserve the existing parallel
        // legacy bootstrap instead of waiting for a protected-route redirect.
        void probeOwnedIdentitySession().then(result => {
            if (cancelled) return
            if (result.kind === 'active' || result.kind === 'expired' || result.kind === 'unavailable' || ownedIdentityActive() || !legacyBrowserAuthConfirmed()) {
                setSessions([]); setActiveSessionIdState(null); setInitialized(true); return
            }
            const stored = getStoredSessions()
            if (stored.length > 0) {
                refreshSessions()
                void initializeActiveSession(stored).catch(() => {}).finally(() => { if (!cancelled) setInitialized(true) })
            } else setInitialized(true)
        })
        return () => { cancelled = true }
    }, [refreshSessions, initializeActiveSession])

    useEffect(() => {
        if (!initialized || ownedIdentityActive() || !legacyBrowserAuthConfirmed()) return

        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (event, session) => {
                if (!mounted.current || ownedIdentityActive() || !legacyBrowserAuthConfirmed()) return
                if (event === 'SIGNED_IN' && session) {
                    const stored = supabaseSessionToStored(session)
                    addStoredSession(stored)
                    setActiveSessionIdState(session.user.id)
                    setActiveSessionId(session.user.id)
                    refreshSessions()
                }

                if (event === 'TOKEN_REFRESHED' && session) {
                    updateStoredSessionTokens(
                        session.user.id,
                        session.access_token,
                        session.refresh_token,
                    )
                }

                if (event === 'SIGNED_OUT') {
                    const currentActive = getActiveSessionId()
                    if (currentActive) {
                        removeStoredSession(currentActive)
                        clearAllSessions()
                    }
                    setActiveSessionIdState(null)
                    refreshSessions()
                }
            }
        )

        return () => {
            subscription?.unsubscribe()
        }
    }, [initialized, refreshSessions])

    const switchSession = useCallback(async (userId: string) => {
        await requireLegacyBrowserAuth()
        const generation = browserAuthGeneration()
        if (ownedIdentityActive()) throw new Error('Sign out of verified sign-in before switching legacy accounts.')
        if (userId === activeSessionId) return

        const stored = getStoredSessions()
        const target = stored.find(s => s.userId === userId)
        if (!target) return

        clearTokenCache()

        const { error } = await supabase.auth.setSession({
            access_token: target.accessToken,
            refresh_token: target.refreshToken,
        })
        if (!mounted.current || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) throw new Error('Sign-in authority changed. Reload to continue.')

        if (error) {
            removeStoredSession(userId)
            refreshSessions()
            throw new Error('Session expired. Please sign in again.')
        }

        // Every cached query (mailboxes, messages, folders, contacts, notifications,
        // organizations...) was fetched under the previous user's auth token. Without
        // dropping it, the new session would briefly render — or worse, act on — the
        // last session's data until each query happened to refetch on its own.
        queryClient.clear()

        setActiveSessionIdState(userId)
        setActiveSessionId(userId)
    }, [activeSessionId, refreshSessions, queryClient])

    const removeAccount = useCallback(async (userId: string) => {
        await requireLegacyBrowserAuth()
        const generation = browserAuthGeneration()
        if (ownedIdentityActive()) throw new Error('Use verified sign-in to manage this session.')
        const wasActive = userId === activeSessionId
        const stored = getStoredSessions()
        const remaining = stored.filter(s => s.userId !== userId)

        removeStoredSession(userId)
        refreshSessions()

        if (wasActive) {
            if (remaining.length > 0) {
                const next = remaining[0]
                clearTokenCache()
                const { error } = await supabase.auth.setSession({
                    access_token: next.accessToken,
                    refresh_token: next.refreshToken,
                })
                if (!mounted.current || ownedIdentityActive() || !legacyBrowserAuthSnapshotCurrent(generation)) throw new Error('Sign-in authority changed. Reload to continue.')
                if (error) {
                    removeStoredSession(next.userId)
                    refreshSessions()
                    const after = getStoredSessions()
                    if (after.length > 0) {
                        await removeAccount(after[0].userId)
                    } else {
                        clearAllSessions()
                        queryClient.clear()
                        await signOutLegacy().catch(() => {})
                    }
                    return
                }
                queryClient.clear()
                setActiveSessionIdState(next.userId)
                setActiveSessionId(next.userId)
            } else {
                clearAllSessions()
                queryClient.clear()
                await signOutLegacy().catch(() => {})
            }
        }
    }, [activeSessionId, refreshSessions, queryClient])

    const value = React.useMemo<MultiSessionContextType>(() => ({
        sessions,
        activeSessionId,
        switchSession,
        removeAccount,
    }), [sessions, activeSessionId, switchSession, removeAccount])

    return (
        <MultiSessionContext.Provider value={value}>
            {children}
        </MultiSessionContext.Provider>
    )
}

export function useMultiSession(): MultiSessionContextType {
    const context = useContext(MultiSessionContext)
    if (!context) {
        throw new Error('useMultiSession must be used within a MultiSessionProvider')
    }
    return context
}
