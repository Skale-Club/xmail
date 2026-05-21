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
    onMarkRead?: () => void
    onRefresh?: () => void
    onCompose?: () => void
    onSelect?: () => void
    onSelectAll?: () => void
    onDeselectAll?: () => void
    onSend?: () => void
    onSaveDraft?: () => void
    onGoToInbox?: () => void
    onGoToSent?: () => void
    onEscape?: () => void
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
    onMarkRead,
    onRefresh,
    onCompose,
    onSelect,
    onSelectAll,
    onDeselectAll,
    onSend,
    onSaveDraft,
    onGoToInbox,
    onGoToSent,
    onEscape
}: UseKeyboardShortcutsOptions = {}) {
    const [lastKey, setLastKey] = React.useState<string>('')
    const [keyTimeout, setKeyTimeout] = React.useState<ReturnType<typeof setTimeout> | null>(null)

    React.useEffect(() => {
        if (!enabled) return

        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement
            const isInput = target.tagName === 'INPUT' || 
                           target.tagName === 'TEXTAREA' || 
                           target.isContentEditable

            if (keyTimeout) {
                clearTimeout(keyTimeout)
                setKeyTimeout(null)
            }

            const timeout = setTimeout(() => {
                setLastKey('')
            }, 500)
            setKeyTimeout(timeout)

            const currentKey = event.key.toLowerCase()

            if (event.key === 'Escape') {
                if (isInput) {
                    (target as HTMLInputElement).blur()
                }
                onEscape?.()
                return
            }

            if (isInput && !event.ctrlKey && !event.metaKey) {
                const allowedInInput = ['c', 'r', 'a', 'f', 'Enter']
                if (!event.ctrlKey && !allowedInInput.includes(currentKey)) {
                    return
                }
            }

            if (event.ctrlKey || event.metaKey) {
                switch (currentKey) {
                    case 'enter':
                        event.preventDefault()
                        onSend?.()
                        return
                    case 's':
                        event.preventDefault()
                        onSaveDraft?.()
                        return
                    case 'a':
                        event.preventDefault()
                        if (event.shiftKey) {
                            onDeselectAll?.()
                        } else {
                            onSelectAll?.()
                        }
                        return
                }
                return
            }

            switch (currentKey) {
                case 'j':
                case 'arrowdown':
                    event.preventDefault()
                    onNavigate?.('down')
                    break
                case 'k':
                case 'arrowup':
                    event.preventDefault()
                    onNavigate?.('up')
                    break
                case 'r':
                    if (!isInput) {
                        event.preventDefault()
                        onReply?.()
                    }
                    break
                case 'a':
                    if (!isInput) {
                        event.preventDefault()
                        onReplyAll?.()
                    }
                    break
                case 'f':
                    if (!isInput) {
                        event.preventDefault()
                        onForward?.()
                    }
                    break
                case 'e':
                    event.preventDefault()
                    onArchive?.()
                    break
                case '#':
                case 'delete':
                case 'backspace':
                    event.preventDefault()
                    onDelete?.()
                    break
                case 's':
                    if (!isInput) {
                        event.preventDefault()
                        onStar?.()
                    }
                    break
                case 'm':
                    event.preventDefault()
                    onMarkRead?.()
                    break
                case '.':
                    event.preventDefault()
                    onRefresh?.()
                    break
                case 'c':
                    if (!isInput) {
                        event.preventDefault()
                        onCompose?.()
                    }
                    break
                case 'x':
                    event.preventDefault()
                    onSelect?.()
                    break
                case 'g':
                    if (lastKey === 'g') {
                        event.preventDefault()
                        onGoToInbox?.()
                    }
                    break
            }

            if (event.shiftKey) {
                switch (currentKey) {
                    case 'g':
                        if (lastKey === 'g') {
                            event.preventDefault()
                            onGoToInbox?.()
                        }
                        break
                    case 's':
                        event.preventDefault()
                        onGoToSent?.()
                        break
                    case '3':
                    case '#':
                        event.preventDefault()
                        onDelete?.()
                        break
                }
            }

            setLastKey(currentKey)
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => {
            window.removeEventListener('keydown', handleKeyDown)
            if (keyTimeout) clearTimeout(keyTimeout)
        }
    }, [
        enabled,
        lastKey,
        keyTimeout,
        onNavigate,
        onReply,
        onReplyAll,
        onForward,
        onArchive,
        onDelete,
        onStar,
        onMarkRead,
        onRefresh,
        onCompose,
        onSelect,
        onSelectAll,
        onDeselectAll,
        onSend,
        onSaveDraft,
        onGoToInbox,
        onGoToSent,
        onEscape
    ])

    return { shortcuts }
}

export function useKeyboardShortcutHelp() {
    const [isOpen, setIsOpen] = React.useState(false)

    const openHelp = React.useCallback(() => setIsOpen(true), [])
    const closeHelp = React.useCallback(() => setIsOpen(false), [])

    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === '?' && event.shiftKey) {
                const target = event.target as HTMLElement
                const isInput = target.tagName === 'INPUT' ||
                               target.tagName === 'TEXTAREA' ||
                               target.isContentEditable
                if (isInput) return
                event.preventDefault()
                setIsOpen(prev => !prev)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [])

    return { isOpen, openHelp, closeHelp }
}
