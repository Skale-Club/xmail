import React from 'react'
import { useAuth } from '../../hooks/useAuth'
import {
    pinnedMailboxesStorageKey,
    showOtherOrgsStorageKey,
    warmupExpandedStorageKey,
    parseStoredIds,
    togglePinned,
} from './mailbox-navigation'

function readStorage(key: string): string | null {
    try {
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

function writeStorage(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value)
    } catch {
        // Private mode / blocked storage: the preference just lasts for this session.
    }
}

/** Per-browser switcher preferences: pinned mailboxes and the warm-up / "other organizations" toggles. */
export function useMailboxPreferences() {
    const { user } = useAuth()
    const userId = user?.id
    const pinnedKey = pinnedMailboxesStorageKey(userId)
    const showOthersKey = showOtherOrgsStorageKey(userId)
    const warmupKey = warmupExpandedStorageKey(userId)

    const [pinnedIds, setPinnedIds] = React.useState<Set<string>>(
        () => parseStoredIds(readStorage(pinnedKey)),
    )
    const [showOthers, setShowOthersState] = React.useState<boolean>(
        () => readStorage(showOthersKey) === '1',
    )
    const [showWarmup, setShowWarmupState] = React.useState<boolean>(
        () => readStorage(warmupKey) === '1',
    )

    // Signing in as another user (multi-session) loads that user's preferences.
    React.useEffect(() => {
        setPinnedIds(parseStoredIds(readStorage(pinnedKey)))
        setShowOthersState(readStorage(showOthersKey) === '1')
        setShowWarmupState(readStorage(warmupKey) === '1')
    }, [pinnedKey, showOthersKey, warmupKey])

    const togglePin = React.useCallback((mailboxId: string) => {
        setPinnedIds(previous => {
            const next = togglePinned(previous, mailboxId)
            writeStorage(pinnedKey, JSON.stringify([...next]))
            return next
        })
    }, [pinnedKey])

    const setShowOthers = React.useCallback((value: boolean) => {
        setShowOthersState(value)
        writeStorage(showOthersKey, value ? '1' : '0')
    }, [showOthersKey])

    const setShowWarmup = React.useCallback((value: boolean) => {
        setShowWarmupState(value)
        writeStorage(warmupKey, value ? '1' : '0')
    }, [warmupKey])

    return { pinnedIds, togglePin, showOthers, setShowOthers, showWarmup, setShowWarmup }
}
