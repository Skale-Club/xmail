import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import { Check, ChevronDown, Globe, Phone } from 'lucide-react'
import { IconUnitedStates } from 'nucleo-flags'
import type { CountryCode } from 'libphonenumber-js/min'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { applyPhoneText, caretAfterDigits, changePhoneCountry, PHONE_COUNTRIES, phoneCountry, phonePlaceholder, scoreCountrySearch, type PhoneValue } from '../../lib/phone-input'
import type { COUNTRY_FLAGS } from './country-flags'

function CountryFlag({ iso, flags }: { iso: CountryCode; flags: typeof COUNTRY_FLAGS | null }) {
    // The default country is bundled so the field never paints without a flag on first load.
    const Flag = iso === 'US' ? IconUnitedStates : flags?.[iso]
    if (Flag) return <Flag size={22} aria-hidden="true" className="shrink-0" />
    if (flags) return <Globe aria-hidden="true" className="h-[22px] w-[22px] shrink-0 p-0.5 text-muted-foreground" />
    return <span aria-hidden="true" className="h-[22px] w-[22px] shrink-0" />
}

interface CountryPhoneFieldProps {
    id: string
    value: PhoneValue
    onChange: (value: PhoneValue) => void
    disabled?: boolean
}

export function CountryPhoneField({ id, value, onChange, disabled }: CountryPhoneFieldProps) {
    const [open, setOpen] = useState(false)
    const [flags, setFlags] = useState<typeof COUNTRY_FLAGS | null>(null)
    const input = useRef<HTMLInputElement>(null)
    const caretDigits = useRef<number | null>(null)
    const pickedCountry = useRef(false)
    const selected = phoneCountry(value.country)

    useEffect(() => {
        let mounted = true
        void import('./country-flags').then(module => { if (mounted) setFlags(module.COUNTRY_FLAGS) })
        return () => { mounted = false }
    }, [])

    // Reformatting replaces the whole value, which would throw a mid-number cursor to the end.
    useLayoutEffect(() => {
        if (caretDigits.current === null || !input.current) return
        const position = caretAfterDigits(value.text, caretDigits.current)
        input.current.setSelectionRange(position, position)
        caretDigits.current = null
    }, [value.text])

    function handleText(event: ChangeEvent<HTMLInputElement>) {
        const raw = event.target.value
        const caret = event.target.selectionStart ?? raw.length
        const next = applyPhoneText(value, raw, caret)
        const digitsBefore = raw.slice(0, caret).replace(/\D/g, '').length
        const removedOnlyPunctuation = raw.length < value.text.length && raw.replace(/\D/g, '') === value.text.replace(/\D/g, '')
        caretDigits.current = caret < raw.length ? Math.max(0, digitsBefore - (removedOnlyPunctuation ? 1 : 0)) : null
        onChange(next)
    }

    return (
        <div className="flex gap-2">
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button type="button" variant="outline" disabled={disabled} aria-label={`Country: ${selected.name}, +${selected.dial}`} className="h-11 shrink-0 gap-1.5 px-2.5 font-normal">
                        <CountryFlag iso={value.country} flags={flags} />
                        <span className="text-sm tabular-nums">+{selected.dial}</span>
                        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
                    </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-0" onCloseAutoFocus={event => {
                    if (!pickedCountry.current) return
                    pickedCountry.current = false
                    event.preventDefault()
                    input.current?.focus()
                }}>
                    <Command label="Country" defaultValue={value.country} filter={(iso, search) => scoreCountrySearch(phoneCountry(iso as CountryCode), search)}>
                        <CommandInput placeholder="Search country or code" />
                        <CommandList className="max-h-64">
                            <CommandEmpty>No country found.</CommandEmpty>
                            <CommandGroup>
                                {PHONE_COUNTRIES.map(country => (
                                    <CommandItem key={country.iso} value={country.iso} onSelect={() => {
                                        pickedCountry.current = true
                                        onChange(changePhoneCountry(value, country.iso))
                                        setOpen(false)
                                    }}>
                                        <CountryFlag iso={country.iso} flags={flags} />
                                        <span className="min-w-0 flex-1 truncate">{country.name}</span>
                                        <span className="text-xs tabular-nums text-muted-foreground">+{country.dial}</span>
                                        <Check aria-hidden="true" className={`h-4 w-4 shrink-0 ${country.iso === value.country ? 'opacity-100' : 'opacity-0'}`} />
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
            <div className="relative min-w-0 flex-1">
                <Phone aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input ref={input} id={id} type="tel" autoComplete="tel" placeholder={phonePlaceholder(value.country)} value={value.text}
                    onChange={handleText} disabled={disabled} required className="h-11 pl-9" />
            </div>
        </div>
    )
}
