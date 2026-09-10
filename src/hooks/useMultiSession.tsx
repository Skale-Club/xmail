import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { clearTokenCache } from '../lib/api-client'
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

export function MultiSessionProvider({ children }: { children: React.ReactNode }) {
    const queryClient = useQueryClient()
    const [sessions, setSessions] = useState<SessionInfo[]>([])
    const [activeSessionId, setActiveSessionIdState] = useState<string | null>(null)
    const [initialized, setInitialized] = useState(false)

    const refreshSessions = useCallback(() => {
        const stored = getStoredSessions()
        setSessions(stored.map(toSessionInfo))
        return stored
    }, [])

    const initializeActiveSession = useCallback(async (stored: StoredSession[]) => {
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
                if (error) {
                    if (stored.length > 1) {
                        removeStoredSession(target.userId)
                        const remaining = getStoredSessions()
                        refreshSessions()
                        if (remaining.length > 0) {
                            initializeActiveSession(remaining)
                        } else {
                            clearAllSessions()
                            await supabase.auth.signOut()
                        }
                    } else {
                        clearAllSessions()
                        await supabase.auth.signOut()
                    }
                    return
                }
                setActiveSessionIdState(target.userId)
            } catch {
                clearAllSessions()
                await supabase.auth.signOut().catch(() => {})
            }
        }
    }, [refreshSessions])

    useEffect(() => {
        const stored = getStoredSessions()
        if (stored.length > 0) {
            refreshSessions()
            initializeActiveSession(stored).finally(() => setInitialized(true))
        } else {
            setInitialized(true)
        }
    }, [refreshSessions, initializeActiveSession])

    useEffect(() => {
        if (!initialized) return

        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (event, session) => {
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
        if (userId === activeSessionId) return

        const stored = getStoredSessions()
        const target = stored.find(s => s.userId === userId)
        if (!target) return

        clearTokenCache()

        const { error } = await supabase.auth.setSession({
            access_token: target.accessToken,
            refresh_token: target.refreshToken,
        })

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
                if (error) {
                    removeStoredSession(next.userId)
                    refreshSessions()
                    const after = getStoredSessions()
                    if (after.length > 0) {
                        await removeAccount(after[0].userId)
                    } else {
                        clearAllSessions()
                        queryClient.clear()
                        await supabase.auth.signOut().catch(() => {})
                    }
                    return
                }
                queryClient.clear()
                setActiveSessionIdState(next.userId)
                setActiveSessionId(next.userId)
            } else {
                clearAllSessions()
                queryClient.clear()
                await supabase.auth.signOut().catch(() => {})
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
