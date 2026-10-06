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
    /** INBOX unread count, from GET /api/mail/mailboxes. */
    unreadCount?: number
    /** First organization of the mailbox owner; null when none. */
    organizationName?: string | null
    /** Operation domain or own mailbox. Undefined (older API) = treat as operation. */
    isOperationMailbox?: boolean
}

interface MailboxContextType {
    mailboxes: Mailbox[]
    selectedMailbox: Mailbox | null
    setSelectedMailbox: (mailbox: Mailbox | null) => void
    /** True only for the very first load (nothing to show yet). */
    isLoading: boolean
    /** True while a later refresh runs in the background; the mailbox list stays on screen. */
    isRefreshing: boolean
    refreshMailboxes: () => Promise<void>
}

/** How often unread counts are re-read while the tab is visible. */
const MAILBOX_POLL_MS = 120_000
/** Minimum gap between focus-triggered refreshes, so alt-tabbing cannot hammer the API. */
const MAILBOX_FOCUS_MIN_GAP_MS = 30_000

function sameMailbox(a: Mailbox, b: Mailbox): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

const MailboxContext = React.createContext<MailboxContextType | undefined>(undefined)

export function MailboxProvider({ children }: { children: React.ReactNode }) {
    const { user, isAdmin, isLoading: authLoading } = useAuth()
    const { activeSessionId } = useMultiSession()
    const [mailboxes, setMailboxes] = React.useState<Mailbox[]>([])
    const [selectedMailbox, setSelectedMailbox] = React.useState<Mailbox | null>(null)
    const [isLoading, setIsLoading] = React.useState(true)
    const [isRefreshing, setIsRefreshing] = React.useState(false)
    const hasLoadedRef = React.useRef(false)
    const storageKey = React.useMemo(
        () => getSelectedMailboxStorageKey(activeSessionId || user?.id || null),
        [activeSessionId, user?.id]
    )

    const refreshMailboxes = React.useCallback(async () => {
        // The first load shows the skeleton; every later refresh is a background refetch
        // so the folder and the switcher never blank out.
        const background = hasLoadedRef.current
        if (background) setIsRefreshing(true)
        else setIsLoading(true)
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
            hasLoadedRef.current = true
            React.startTransition(() => {
                setMailboxes(fetchedMailboxes)
                // Keep the same object when nothing visible changed so effects keyed on
                // the selected mailbox do not re-run on every background poll.
                setSelectedMailbox(prev => (prev && selected && sameMailbox(prev, selected) ? prev : selected))
                setIsLoading(false)
                setIsRefreshing(false)
            })
        } catch (error) {
            console.error('Error fetching mailboxes:', error)
            setIsLoading(false)
            setIsRefreshing(false)
        }
    }, [storageKey])

    React.useEffect(() => {
        if (authLoading) return
        if (!user) {
            localStorage.removeItem(APP_CONSTANTS.STORAGE.SELECTED_MAILBOX_KEY)
            hasLoadedRef.current = false
            React.startTransition(() => {
                setMailboxes([])
                setSelectedMailbox(null)
                setIsLoading(false)
            })
            return
        }
        refreshMailboxes()
    }, [user, isAdmin, authLoading, activeSessionId, refreshMailboxes])

    // Keep per-mailbox unread counts fresh: poll while the tab is visible and refresh
    // when the user comes back to it.
    React.useEffect(() => {
        if (authLoading || !user) return

        let lastRefresh = Date.now()
        const refreshIfVisible = (minGapMs: number) => {
            if (document.visibilityState !== 'visible') return
            if (Date.now() - lastRefresh < minGapMs) return
            lastRefresh = Date.now()
            void refreshMailboxes()
        }
        const interval = window.setInterval(() => refreshIfVisible(MAILBOX_POLL_MS - 1000), MAILBOX_POLL_MS)
        const onFocus = () => refreshIfVisible(MAILBOX_FOCUS_MIN_GAP_MS)
        window.addEventListener('focus', onFocus)
        return () => {
            window.clearInterval(interval)
            window.removeEventListener('focus', onFocus)
        }
    }, [authLoading, user, refreshMailboxes])

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
        isRefreshing,
        refreshMailboxes
    }), [mailboxes, selectedMailbox, handleSetSelectedMailbox, isLoading, isRefreshing, refreshMailboxes])

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
