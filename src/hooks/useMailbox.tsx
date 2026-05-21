import React from 'react'
import { apiFetch } from '../lib/api-client'
import { APP_CONSTANTS, getSelectedMailboxStorageKey } from '../lib/constants'
import { useAuth } from './useAuth'
import { useMultiSession } from './useMultiSession'

export interface Mailbox {
    id: string
    email: string
    displayName: string | null
    isDefault: boolean
    isActive: boolean
    isNative?: boolean
    lastSyncAt: string | null
    syncError: string | null
    provider?: 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'custom'
    unreadCount?: number
}

interface MailboxContextType {
    mailboxes: Mailbox[]
    selectedMailbox: Mailbox | null
    setSelectedMailbox: (mailbox: Mailbox | null) => void
    isLoading: boolean
    refreshMailboxes: () => Promise<void>
}

const MailboxContext = React.createContext<MailboxContextType | undefined>(undefined)

export function MailboxProvider({ children }: { children: React.ReactNode }) {
    const { user, isAdmin, isLoading: authLoading } = useAuth()
    const { activeSessionId } = useMultiSession()
    const [mailboxes, setMailboxes] = React.useState<Mailbox[]>([])
    const [selectedMailbox, setSelectedMailbox] = React.useState<Mailbox | null>(null)
    const [isLoading, setIsLoading] = React.useState(true)
    const storageKey = React.useMemo(
        () => getSelectedMailboxStorageKey(activeSessionId || user?.id || null),
        [activeSessionId, user?.id]
    )

    const refreshMailboxes = React.useCallback(async () => {
        setIsLoading(true)
        try {
            const data = await apiFetch<{ mailboxes: Mailbox[] }>('/api/mail/mailboxes')
            const fetchedMailboxes = data.mailboxes || []

            const savedId = localStorage.getItem(storageKey)
            const legacySavedId = localStorage.getItem(APP_CONSTANTS.STORAGE.SELECTED_MAILBOX_KEY)
            const saved = savedId ? fetchedMailboxes.find((m: Mailbox) => m.id === savedId) : null
            const legacySaved = !saved && legacySavedId
                ? fetchedMailboxes.find((m: Mailbox) => m.id === legacySavedId)
                : null
            const defaultMailbox = fetchedMailboxes.find((m: Mailbox) => m.isDefault)
            const selected = saved || legacySaved || defaultMailbox || fetchedMailboxes[0] || null

            if (legacySaved) {
                localStorage.setItem(storageKey, legacySaved.id)
            }
            localStorage.removeItem(APP_CONSTANTS.STORAGE.SELECTED_MAILBOX_KEY)

            if (selected) {
                localStorage.setItem(storageKey, selected.id)
            } else {
                localStorage.removeItem(storageKey)
            }

            // Batch state updates together to avoid multiple re-renders
            React.startTransition(() => {
                setMailboxes(fetchedMailboxes)
                setSelectedMailbox(selected)
                setIsLoading(false)
            })
        } catch (error) {
            console.error('Error fetching mailboxes:', error)
            setIsLoading(false)
        }
    }, [storageKey])

    React.useEffect(() => {
        if (authLoading) return
        if (!user) {
            localStorage.removeItem(APP_CONSTANTS.STORAGE.SELECTED_MAILBOX_KEY)
            React.startTransition(() => {
                setMailboxes([])
                setSelectedMailbox(null)
                setIsLoading(false)
            })
            return
        }
        refreshMailboxes()
    }, [user, isAdmin, authLoading, activeSessionId, refreshMailboxes])

    const handleSetSelectedMailbox = React.useCallback((mailbox: Mailbox | null) => {
        setSelectedMailbox(mailbox)
        localStorage.removeItem(APP_CONSTANTS.STORAGE.SELECTED_MAILBOX_KEY)
        if (mailbox) {
            localStorage.setItem(storageKey, mailbox.id)
        } else {
            localStorage.removeItem(storageKey)
        }
    }, [storageKey])

    const contextValue = React.useMemo(() => ({
        mailboxes,
        selectedMailbox,
        setSelectedMailbox: handleSetSelectedMailbox,
        isLoading,
        refreshMailboxes
    }), [mailboxes, selectedMailbox, handleSetSelectedMailbox, isLoading, refreshMailboxes])

    return (
        <MailboxContext.Provider value={contextValue}>
            {children}
        </MailboxContext.Provider>
    )
}

export function useMailbox() {
    const context = React.useContext(MailboxContext)
    if (context === undefined) {
        throw new Error('useMailbox must be used within a MailboxProvider')
    }
    return context
}

export function getProviderIcon(provider?: string): string {
    switch (provider) {
        case 'gmail':
            return 'G'
        case 'outlook':
            return 'O'
        case 'yahoo':
            return 'Y'
        case 'icloud':
            return 'i'
        default:
            return '@'
    }
}

export function getProviderColor(provider?: string): string {
    switch (provider) {
        case 'gmail':
            return 'bg-red-500'
        case 'outlook':
            return 'bg-blue-500'
        case 'yahoo':
            return 'bg-purple-500'
        case 'icloud':
            return 'bg-gray-500'
        default:
            return 'bg-gray-600'
    }
}
