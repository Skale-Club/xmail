import { Check, ChevronDown } from 'lucide-react'
import type { Mailbox } from '../../hooks/useMailbox'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { mailboxDomain, mailboxLocalPart } from './mailbox-navigation'

/** Above this many senders the picker shows a search box. */
const SEARCH_THRESHOLD = 8

function SenderAddress({ mailbox }: { mailbox: Pick<Mailbox, 'email' | 'displayName'> }) {
    const name = mailbox.displayName?.trim()
    return (
        <span className="min-w-0 flex-1 truncate">
            {name ? <span className="text-muted-foreground">{name} </span> : null}
            <span className="font-semibold text-foreground">{mailboxLocalPart(mailbox.email)}</span>
            <span className="text-muted-foreground">@{mailboxDomain(mailbox.email)}</span>
        </span>
    )
}

/**
 * Compose "From" picker. Replaces the native select, whose popup ignored the dark theme
 * (white list, light text). Styled like the mailbox switcher; searchable when the list is long.
 * The compose window sits at z-[60], so the popover content goes above it.
 */
export function ComposeFromPicker({
    id,
    senders,
    value,
    onChange,
    open,
    onOpenChange,
}: {
    id: string
    senders: Mailbox[]
    value: string | null
    onChange: (mailboxId: string) => void
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const current = senders.find(mailbox => mailbox.id === value) ?? null
    const searchable = senders.length > SEARCH_THRESHOLD

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <button
                    id={id}
                    type="button"
                    role="combobox"
                    aria-expanded={open}
                    aria-haspopup="listbox"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {current ? <SenderAddress mailbox={current} /> : <span className="flex-1 text-muted-foreground">Choose a sender</span>}
                    <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                sideOffset={4}
                className="z-[70] w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
                onOpenAutoFocus={event => { if (!searchable) event.preventDefault() }}
            >
                <Command
                    // Match on address and display name.
                    filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
                >
                    {searchable ? <CommandInput placeholder="Search senders..." /> : null}
                    <CommandList className="max-h-72">
                        <CommandEmpty>No sender found.</CommandEmpty>
                        {senders.map(mailbox => {
                            const selected = mailbox.id === value
                            return (
                                <CommandItem
                                    key={mailbox.id}
                                    value={`${mailbox.email} ${mailbox.displayName ?? ''} ${mailbox.id}`}
                                    onSelect={() => { onChange(mailbox.id); onOpenChange(false) }}
                                    className={cn('flex items-center gap-2', selected && 'bg-primary/10')}
                                >
                                    <SenderAddress mailbox={mailbox} />
                                    {selected ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
                                </CommandItem>
                            )
                        })}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    )
}
