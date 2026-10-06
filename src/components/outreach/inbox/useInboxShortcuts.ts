import { useEffect, useRef } from 'react'

// ============================================================
// Keyboard shortcuts for the unified inbox
// ============================================================
// j / k  next / previous conversation (moves the list cursor)
// Enter  open the conversation under the cursor
// r / a / f  reply / reply all / forward
// e  archive (or restore) the highlighted (j/k) conversation, else the open one
// u  toggle unread on the highlighted (j/k) conversation, else the open one
// /  focus the search box
// ?  show the shortcut help
//
// Shortcuts never fire while the operator is typing (input, textarea, select, contenteditable), while
// a dialog / menu is open, or when a modifier key is held (so browser and OS shortcuts keep working).

export interface InboxShortcutHandlers {
    next: () => void
    prev: () => void
    open: () => void
    reply: () => void
    replyAll: () => void
    forward: () => void
    archive: () => void
    toggleUnread: () => void
    focusSearch: () => void
    toggleHelp: () => void
}

export const SHORTCUT_HELP: ReadonlyArray<{ keys: string; description: string }> = [
    { keys: 'j / k', description: 'Next / previous conversation' },
    { keys: 'Enter', description: 'Open the selected conversation' },
    { keys: 'r', description: 'Reply' },
    { keys: 'a', description: 'Reply all' },
    { keys: 'f', description: 'Forward' },
    { keys: 'e', description: 'Archive or restore the highlighted conversation (the open one if none)' },
    { keys: 'u', description: 'Mark the highlighted conversation read or unread (the open one if none)' },
    { keys: '/', description: 'Search conversations' },
    { keys: '?', description: 'Show this help' },
    { keys: 'Ctrl+Enter', description: 'Send the reply (in the composer)' },
    { keys: 'Esc', description: 'Close the composer, menu or search' },
]

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"]'

export function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    return target.isContentEditable || target.closest(EDITABLE_SELECTOR) !== null
}

function isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    return target.closest('button, a, summary, [role="button"], [role="menuitem"]') !== null
}

export function useInboxShortcuts(handlers: InboxShortcutHandlers, enabled = true): void {
    const handlersRef = useRef(handlers)
    handlersRef.current = handlers

    useEffect(() => {
        if (!enabled) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return
            if (event.ctrlKey || event.metaKey || event.altKey) return
            if (isEditableTarget(event.target)) return
            if (document.querySelector(OVERLAY_SELECTOR)) return

            const h = handlersRef.current
            let handled = true
            switch (event.key) {
                case 'j': h.next(); break
                case 'k': h.prev(); break
                case 'Enter':
                    // Enter on a focused button/link keeps its native meaning.
                    if (isInteractiveTarget(event.target)) return
                    h.open()
                    break
                case 'r': h.reply(); break
                case 'a': h.replyAll(); break
                case 'f': h.forward(); break
                case 'e': h.archive(); break
                case 'u': h.toggleUnread(); break
                case '/': h.focusSearch(); break
                case '?': h.toggleHelp(); break
                default: handled = false
            }
            if (handled) event.preventDefault()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [enabled])
}
