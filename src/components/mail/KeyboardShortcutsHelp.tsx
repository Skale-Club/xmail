import React from 'react'
import { SHORTCUTS, SHORTCUT_CATEGORIES, formatShortcut } from '../../lib/keyboard-shortcuts'
import { X, Keyboard } from 'lucide-react'

interface KeyboardShortcutsHelpProps {
    isOpen: boolean
    onClose: () => void
}

export function KeyboardShortcutsHelp({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
    // Phase 12 COR-07: hooks must be called unconditionally; the early-return below replaces the
    // previous `if (!isOpen) return null` that preceded React.useMemo.
    const categorizedShortcuts = React.useMemo(() => {
        const categories: Record<string, typeof SHORTCUTS> = {}

        for (const shortcut of SHORTCUTS) {
            if (!categories[shortcut.category]) {
                categories[shortcut.category] = []
            }
            categories[shortcut.category].push(shortcut)
        }

        return Object.entries(categories)
            .sort(([a], [b]) =>
                (SHORTCUT_CATEGORIES[a as keyof typeof SHORTCUT_CATEGORIES]?.order || 0) -
                (SHORTCUT_CATEGORIES[b as keyof typeof SHORTCUT_CATEGORIES]?.order || 0)
            )
    }, [])

    const dialogRef = React.useRef<HTMLDivElement>(null)
    const closeButtonRef = React.useRef<HTMLButtonElement>(null)

    // Modal behavior: move focus in, keep Tab inside, close on Escape, give focus back.
    React.useEffect(() => {
        if (!isOpen) return
        const previouslyFocused = document.activeElement as HTMLElement | null
        closeButtonRef.current?.focus()

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
                return
            }
            if (event.key !== 'Tab' || !dialogRef.current) return

            const focusable = Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
            ).filter(element => !element.hasAttribute('disabled'))
            if (focusable.length === 0) {
                event.preventDefault()
                return
            }
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            const active = document.activeElement
            if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
                event.preventDefault()
                last.focus()
            } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
                event.preventDefault()
                first.focus()
            }
        }

        document.addEventListener('keydown', handleKeyDown, true)
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true)
            previouslyFocused?.focus?.()
        }
    }, [isOpen, onClose])

    if (!isOpen) return null

    return (
        <>
            <div
                className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
                onClick={onClose}
                aria-hidden="true"
            />
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="keyboard-shortcuts-title"
                className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg z-50 bg-popover text-popover-foreground rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]"
            >
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-3">
                        <Keyboard className="w-5 h-5 text-muted-foreground" />
                        <h2 id="keyboard-shortcuts-title" className="text-lg font-semibold text-foreground">
                            Keyboard Shortcuts
                        </h2>
                    </div>
                    <button
                        ref={closeButtonRef}
                        onClick={onClose}
                        aria-label="Close keyboard shortcuts"
                        className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                    <p className="text-sm text-muted-foreground mb-6">
                        Press <kbd className="px-2 py-0.5 bg-muted rounded text-xs font-mono">Shift + ?</kbd> anytime to toggle this help
                    </p>

                    <div className="space-y-6">
                        {categorizedShortcuts.map(([category, shortcuts]) => (
                            <div key={category}>
                                <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
                                    {SHORTCUT_CATEGORIES[category as keyof typeof SHORTCUT_CATEGORIES]?.label || category}
                                </h3>
                                <div className="space-y-2">
                                    {shortcuts.map((shortcut, index) => (
                                        <div
                                            key={`${shortcut.key}-${shortcut.then ?? ''}-${index}`}
                                            className="flex items-center justify-between py-2"
                                        >
                                            <span className="text-sm text-muted-foreground">
                                                {shortcut.description}
                                            </span>
                                            <kbd className="px-2 py-1 bg-muted rounded text-xs font-mono text-foreground min-w-[60px] text-center">
                                                {formatShortcut(shortcut)}
                                            </kbd>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="px-6 py-4 border-t border-border bg-muted/50">
                    <p className="text-xs text-muted-foreground text-center">
                        Shortcuts work when not focused on text inputs
                    </p>
                </div>
            </div>
        </>
    )
}

export function KeyboardShortcutsButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
            title="Keyboard shortcuts (Shift + ?)"
            aria-label="Keyboard shortcuts"
        >
            <Keyboard className="w-5 h-5" />
        </button>
    )
}
