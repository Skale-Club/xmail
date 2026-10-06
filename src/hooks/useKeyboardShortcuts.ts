import React from 'react'
import { SHORTCUTS, KeyboardShortcut } from '../lib/keyboard-shortcuts'

interface UseKeyboardShortcutsOptions {
    enabled?: boolean
    shortcuts?: KeyboardShortcut[]
    onNavigate?: (direction: 'up' | 'down') => void
    onReply?: () => void
    onReplyAll?: () => void
    onForward?: () => void
    onArchive?: () => void
    onDelete?: () => void
    onStar?: () => void
    /** Toggles read/unread for the selection ("m"). */
    onToggleRead?: () => void
    onRefresh?: () => void
    onCompose?: () => void
    onSelect?: () => void
    onSelectAll?: () => void
    onDeselectAll?: () => void
    onSend?: () => void
    onSaveDraft?: () => void
    onEscape?: () => void
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

/** True when the keystroke happens while typing in a field. */
export function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null
    if (!element || typeof element.tagName !== 'string') return false
    return element.tagName === 'INPUT'
        || element.tagName === 'TEXTAREA'
        || element.tagName === 'SELECT'
        || element.isContentEditable
}

/** True when focus sits inside an open dialog/menu: list shortcuts must not reach through it. */
export function isInsideDialog(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null
    return !!element && typeof element.closest === 'function' && !!element.closest(DIALOG_SELECTOR)
}

export function useKeyboardShortcuts({
    enabled = true,
    shortcuts = SHORTCUTS,
    onNavigate,
    onReply,
    onReplyAll,
    onForward,
    onArchive,
    onDelete,
    onStar,
    onToggleRead,
    onRefresh,
    onCompose,
    onSelect,
    onSelectAll,
    onDeselectAll,
    onSend,
    onSaveDraft,
    onEscape
}: UseKeyboardShortcutsOptions = {}) {
    // Handlers change on every render of the caller; keeping them in a ref means the window
    // listener is attached once instead of being torn down and re-added per keystroke.
    const handlersRef = React.useRef({
        onNavigate, onReply, onReplyAll, onForward, onArchive, onDelete, onStar, onToggleRead,
        onRefresh, onCompose, onSelect, onSelectAll, onDeselectAll, onSend, onSaveDraft, onEscape,
    })
    handlersRef.current = {
        onNavigate, onReply, onReplyAll, onForward, onArchive, onDelete, onStar, onToggleRead,
        onRefresh, onCompose, onSelect, onSelectAll, onDeselectAll, onSend, onSaveDraft, onEscape,
    }

    React.useEffect(() => {
        if (!enabled) return

        const handleKeyDown = (event: KeyboardEvent) => {
            const handlers = handlersRef.current
            const target = event.target
            const typing = isTypingTarget(target)
            const key = event.key
            const lower = key.toLowerCase()

            if (key === 'Escape') {
                if (typing) (target as HTMLElement).blur()
                handlers.onEscape?.()
                return
            }

            if (event.ctrlKey || event.metaKey) {
                // These two keep working while focus is in the compose editor
                // (subject/body/contentEditable) — they never conflict with native
                // input behavior, unlike Ctrl+A below.
                if (lower === 'enter') {
                    event.preventDefault()
                    handlers.onSend?.()
                    return
                }
                if (lower === 's') {
                    event.preventDefault()
                    handlers.onSaveDraft?.()
                    return
                }

                // Ctrl+A (select all messages) / Ctrl+Shift+A (deselect) are list shortcuts.
                // Inside a field or dialog they would hijack native "select all text".
                if (typing || isInsideDialog(target)) return
                if (lower === 'a') {
                    event.preventDefault()
                    if (event.shiftKey) handlers.onDeselectAll?.()
                    else handlers.onSelectAll?.()
                }
                return
            }

            // Everything below is a plain-key list shortcut: never while typing, and never
            // through an open dialog or menu.
            if (typing || isInsideDialog(target) || event.altKey) return

            if (key === '#' || key === 'Delete') {
                event.preventDefault()
                handlers.onDelete?.()
                return
            }

            // Shift+<letter> is reserved for the browser/OS and for future shortcuts: "S" must
            // never star a message.
            if (event.shiftKey) return

            switch (lower) {
                case 'j':
                case 'arrowdown':
                    event.preventDefault()
                    handlers.onNavigate?.('down')
                    break
                case 'k':
                case 'arrowup':
                    event.preventDefault()
                    handlers.onNavigate?.('up')
                    break
                case 'r':
                    event.preventDefault()
                    handlers.onReply?.()
                    break
                case 'a':
                    event.preventDefault()
                    handlers.onReplyAll?.()
                    break
                case 'f':
                    event.preventDefault()
                    handlers.onForward?.()
                    break
                case 'e':
                    event.preventDefault()
                    handlers.onArchive?.()
                    break
                case 's':
                    event.preventDefault()
                    handlers.onStar?.()
                    break
                case 'm':
                    event.preventDefault()
                    handlers.onToggleRead?.()
                    break
                case '.':
                    event.preventDefault()
                    handlers.onRefresh?.()
                    break
                case 'c':
                    event.preventDefault()
                    handlers.onCompose?.()
                    break
                case 'x':
                    event.preventDefault()
                    handlers.onSelect?.()
                    break
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [enabled])

    return { shortcuts }
}

/** How long the second key of a "g then <key>" sequence may take. */
const SEQUENCE_TIMEOUT_MS = 800

interface UseGoToShortcutsOptions {
    enabled?: boolean
    /** Maps the key after "g" to an action; unknown keys are ignored. */
    actions: Record<string, () => void>
}

/**
 * "g then <key>" navigation (g i = Inbox, g s = Sent, g d = Drafts, g m = mailbox switcher).
 * Mounted once, in the mail layout, so it works on every page of /mail.
 */
export function useGoToShortcuts({ enabled = true, actions }: UseGoToShortcutsOptions) {
    const actionsRef = React.useRef(actions)
    actionsRef.current = actions

    React.useEffect(() => {
        if (!enabled) return

        let armed = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const disarm = () => {
            armed = false
            if (timer) clearTimeout(timer)
            timer = null
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return
            if (isTypingTarget(event.target) || isInsideDialog(event.target)) return

            const lower = event.key.toLowerCase()
            if (armed) {
                const action = actionsRef.current[lower]
                disarm()
                if (action && !event.shiftKey) {
                    event.preventDefault()
                    action()
                }
                return
            }

            if (lower === 'g' && !event.shiftKey) {
                armed = true
                timer = setTimeout(disarm, SEQUENCE_TIMEOUT_MS)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => {
            window.removeEventListener('keydown', handleKeyDown)
            disarm()
        }
    }, [enabled])
}

export function useKeyboardShortcutHelp() {
    const [isOpen, setIsOpen] = React.useState(false)

    const openHelp = React.useCallback(() => setIsOpen(true), [])
    const closeHelp = React.useCallback(() => setIsOpen(false), [])

    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === '?' && event.shiftKey) {
                if (isTypingTarget(event.target)) return
                event.preventDefault()
                setIsOpen(prev => !prev)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [])

    return { isOpen, openHelp, closeHelp }
}
