import { Keyboard } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { cn } from '../../../lib/utils'
import { SHORTCUT_HELP } from './useInboxShortcuts'

// Small popover that lists the inbox keyboard shortcuts. Controlled so the "?" shortcut can open it.

export function ShortcutsHelp({
    open,
    onOpenChange,
    className,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    className?: string
}) {
    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label="Keyboard shortcuts"
                    title="Keyboard shortcuts (?)"
                    className={cn(
                        'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        className,
                    )}
                >
                    <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-3 text-xs">
                <p className="mb-2 text-sm font-semibold text-foreground">Keyboard shortcuts</p>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5">
                    {SHORTCUT_HELP.map((item) => (
                        <div key={item.keys} className="contents">
                            <dt>
                                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{item.keys}</kbd>
                            </dt>
                            <dd className="text-muted-foreground">{item.description}</dd>
                        </div>
                    ))}
                </dl>
            </PopoverContent>
        </Popover>
    )
}

export default ShortcutsHelp
