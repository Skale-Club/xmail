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

    if (!isOpen) return null

    return (
        <>
            <div
                className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
                onClick={onClose}
            />
            <div className="fixed inset-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-w-lg z-50 bg-popover text-popover-foreground rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-2rem)]">
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-3">
                        <Keyboard className="w-5 h-5 text-muted-foreground" />
                        <h2 className="text-lg font-semibold text-foreground">
                            Keyboard Shortcuts
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
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
                                            key={`${shortcut.key}-${index}`}
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
        >
            <Keyboard className="w-5 h-5" />
        </button>
    )
}
