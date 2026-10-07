import React from 'react'
import { useMediaQuery } from '../../hooks/useIsMobile'

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'xmail:mail:sidebar-collapsed'

/** Tailwind's `xl`: from here up the sidebar opens by default, below it starts collapsed. */
export const SIDEBAR_AUTO_OPEN_QUERY = '(min-width: 1280px)'

/** The user's saved choice, or null when they never made one (storage blocked counts as none). */
export function readSidebarPreference(): boolean | null {
    try {
        const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)
        if (stored === '1') return true
        if (stored === '0') return false
    } catch {
        // Storage blocked: behave as if nothing was saved.
    }
    return null
}

function writeSidebarPreference(collapsed: boolean) {
    try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
        // Storage blocked: the sidebar just forgets its state on reload.
    }
}

/**
 * Sidebar collapsed state. A saved preference always wins; without one the sidebar follows the
 * viewport (collapsed below xl). Both the media query and the stored value are read
 * synchronously on the first render, so there is no open-then-collapse flash.
 */
export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
    const wideEnough = useMediaQuery(SIDEBAR_AUTO_OPEN_QUERY)
    const [preference, setPreference] = React.useState<boolean | null>(readSidebarPreference)

    const setCollapsed = React.useCallback((collapsed: boolean) => {
        setPreference(collapsed)
        writeSidebarPreference(collapsed)
    }, [])

    return [preference ?? !wideEnough, setCollapsed]
}
