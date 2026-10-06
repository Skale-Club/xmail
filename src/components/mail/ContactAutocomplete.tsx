import React from 'react'
import { mailApi, ContactItem } from '../../lib/mail-api'

interface ContactAutocompleteProps {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    className?: string
    id?: string
}

export function ContactAutocomplete({ value, onChange, placeholder, className, id }: ContactAutocompleteProps) {
    const [suggestions, setSuggestions] = React.useState<ContactItem[]>([])
    const [isOpen, setIsOpen] = React.useState(false)
    const [highlightedIndex, setHighlightedIndex] = React.useState(-1)
    const [loading, setLoading] = React.useState(false)
    const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    const containerRef = React.useRef<HTMLDivElement>(null)
    const inputRef = React.useRef<HTMLInputElement>(null)

    const getLastSegment = React.useCallback((val: string): string => {
        const parts = val.split(',')
        return parts[parts.length - 1].trim()
    }, [])

    const getPrefix = React.useCallback((val: string): string => {
        const parts = val.split(',')
        if (parts.length <= 1) return ''
        return parts.slice(0, -1).map(p => p.trim()).filter(p => p).join(', ') + ', '
    }, [])

    React.useEffect(() => {
        const query = getLastSegment(value)

        if (debounceRef.current) {
            clearTimeout(debounceRef.current)
        }

        if (query.length < 1) {
            setSuggestions([])
            setIsOpen(false)
            return
        }

        debounceRef.current = setTimeout(async () => {
            setLoading(true)
            try {
                const result = await mailApi.searchContacts(query)
                setSuggestions(result.contacts || [])
                setIsOpen((result.contacts || []).length > 0)
                setHighlightedIndex(-1)
            } catch {
                setSuggestions([])
                setIsOpen(false)
            } finally {
                setLoading(false)
            }
        }, 300)

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current)
            }
        }
    }, [value, getLastSegment])

    React.useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const selectContact = (contact: ContactItem) => {
        const prefix = getPrefix(value)
        const displayName = contact.firstName || contact.lastName
            ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim()
            : ''
        const emailStr = displayName ? `${displayName} <${contact.email}>` : contact.email
        onChange(prefix + emailStr + ', ')
        setIsOpen(false)
        setSuggestions([])
        inputRef.current?.focus()
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!isOpen || suggestions.length === 0) return

        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightedIndex(prev => (prev + 1) % suggestions.length)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightedIndex(prev => (prev <= 0 ? suggestions.length - 1 : prev - 1))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
                selectContact(suggestions[highlightedIndex])
            }
        } else if (e.key === 'Escape') {
            // Esc closes the suggestion list first; it must not also close the compose window.
            if (isOpen) e.preventDefault()
            setIsOpen(false)
        }
    }

    const getDisplayName = (contact: ContactItem): string => {
        const parts = [contact.firstName, contact.lastName].filter(Boolean)
        return parts.join(' ') || contact.email
    }

    return (
        <div ref={containerRef} className="relative flex-1">
            <input
                ref={inputRef}
                id={id}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                    if (suggestions.length > 0) setIsOpen(true)
                }}
                placeholder={placeholder}
                className={className || "flex-1 px-3 py-2 bg-transparent border-0 border-b border-border focus:border-primary focus:ring-0 text-foreground placeholder-muted-foreground text-sm sm:text-base"}
                autoComplete="off"
            />
            {isOpen && suggestions.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto">
                    {suggestions.map((contact, index) => (
                        <button
                            key={contact.id}
                            type="button"
                            onClick={() => selectContact(contact)}
                            className={`w-full px-4 py-2.5 text-left transition-colors ${
                                index === highlightedIndex
                                    ? 'bg-accent text-accent-foreground'
                                    : 'hover:bg-accent/50'
                            }`}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-foreground truncate">
                                        {getDisplayName(contact)}
                                    </div>
                                    {getDisplayName(contact) !== contact.email && (
                                        <div className="text-xs text-muted-foreground truncate">
                                            {contact.email}
                                        </div>
                                    )}
                                </div>
                                {contact.company && (
                                    <span className="text-xs text-muted-foreground shrink-0 bg-muted px-2 py-0.5 rounded">
                                        {contact.company}
                                    </span>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
            )}
            {loading && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <div className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
                        Searching...
                    </div>
                </div>
            )}
        </div>
    )
}
