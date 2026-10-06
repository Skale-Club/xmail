export interface KeyboardShortcut {
    key: string
    /** Second key of a "g then <key>" sequence; `key` is the first. */
    then?: string
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
    description: string
    category: 'navigation' | 'actions' | 'compose' | 'selection'
    action?: () => void
}

// Keep this list in sync with the handlers: useKeyboardShortcuts (list/compose keys) and
// useGoToShortcuts ("g" sequences, mounted in MailLayout).
export const SHORTCUTS: KeyboardShortcut[] = [
    // Navigation
    { key: 'j', description: 'Move to next email', category: 'navigation' },
    { key: 'k', description: 'Move to previous email', category: 'navigation' },
    { key: 'g', then: 'i', description: 'Go to Inbox', category: 'navigation' },
    { key: 'g', then: 's', description: 'Go to Sent', category: 'navigation' },
    { key: 'g', then: 'd', description: 'Go to Drafts', category: 'navigation' },
    { key: 'g', then: 'm', description: 'Switch mailbox (focus mailbox search)', category: 'navigation' },
    { key: 'Escape', description: 'Go back / Close modal', category: 'navigation' },

    // Actions
    { key: 'r', description: 'Reply', category: 'actions' },
    { key: 'a', description: 'Reply All', category: 'actions' },
    { key: 'f', description: 'Forward', category: 'actions' },
    { key: 'e', description: 'Archive', category: 'actions' },
    { key: '#', shift: true, description: 'Delete', category: 'actions' },
    { key: 's', description: 'Star/Unstar', category: 'actions' },
    { key: 'm', description: 'Mark as read/unread', category: 'actions' },
    { key: '.', description: 'Refresh', category: 'actions' },

    // Compose
    { key: 'c', description: 'Compose new email', category: 'compose' },
    { key: 'Enter', ctrl: true, description: 'Send email', category: 'compose' },
    { key: 's', ctrl: true, description: 'Save draft', category: 'compose' },

    // Selection
    { key: 'x', description: 'Select/Deselect email', category: 'selection' },
    { key: 'a', ctrl: true, description: 'Select all', category: 'selection' },
    { key: 'a', ctrl: true, shift: true, description: 'Deselect all', category: 'selection' },
]

export const SHORTCUT_CATEGORIES = {
    navigation: { label: 'Navigation', order: 1 },
    actions: { label: 'Actions', order: 2 },
    compose: { label: 'Compose', order: 3 },
    selection: { label: 'Selection', order: 4 },
}

function formatKey(key: string): string {
    if (key === ' ') return 'Space'
    if (key === 'ArrowUp') return '↑'
    if (key === 'ArrowDown') return '↓'
    if (key === 'Escape') return 'Esc'
    return key.toUpperCase()
}

export function formatShortcut(shortcut: KeyboardShortcut): string {
    if (shortcut.then) {
        return `${formatKey(shortcut.key)} then ${formatKey(shortcut.then)}`
    }

    const parts: string[] = []

    if (shortcut.ctrl) parts.push('Ctrl')
    if (shortcut.alt) parts.push('Alt')
    // "#" already is Shift+3 on most layouts: showing "Shift + #" would be redundant.
    if (shortcut.shift && shortcut.key !== '#') parts.push('Shift')

    parts.push(formatKey(shortcut.key))

    return parts.join(' + ')
}
