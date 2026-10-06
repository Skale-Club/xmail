import React from 'react'
import {
    PINNED_MAILBOXES_STORAGE_KEY,
    SHOW_OTHER_ORGS_STORAGE_KEY,
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

/** Per-browser switcher preferences: pinned mailboxes and the "other organizations" toggle. */
export function useMailboxPreferences() {
    const [pinnedIds, setPinnedIds] = React.useState<Set<string>>(
        () => parseStoredIds(readStorage(PINNED_MAILBOXES_STORAGE_KEY)),
    )
    const [showOthers, setShowOthersState] = React.useState<boolean>(
        () => readStorage(SHOW_OTHER_ORGS_STORAGE_KEY) === '1',
    )

    const togglePin = React.useCallback((mailboxId: string) => {
        setPinnedIds(previous => {
            const next = togglePinned(previous, mailboxId)
            writeStorage(PINNED_MAILBOXES_STORAGE_KEY, JSON.stringify([...next]))
            return next
        })
    }, [])

    const setShowOthers = React.useCallback((value: boolean) => {
        setShowOthersState(value)
        writeStorage(SHOW_OTHER_ORGS_STORAGE_KEY, value ? '1' : '0')
    }, [])

    return { pinnedIds, togglePin, showOthers, setShowOthers }
}
