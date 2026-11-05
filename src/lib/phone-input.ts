import { AsYouType, getCountries, getCountryCallingCode, getExampleNumber, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min'
import mobileExamples from 'libphonenumber-js/mobile/examples'

export interface PhoneValue {
    country: CountryCode
    text: string
}
export interface PhoneCountry {
    iso: CountryCode
    name: string
    dial: string
}

export const DEFAULT_PHONE_COUNTRY: CountryCode = 'US'
// Same shape the server accepts from the identity provider (google-provider.ts).
const E164 = /^\+[1-9]\d{7,14}$/
const MAX_DIGITS = 15
const PINNED: readonly CountryCode[] = ['US', 'BR']

function buildCountries(): PhoneCountry[] {
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    const all = getCountries().map(iso => ({ iso, name: names.of(iso) ?? iso, dial: getCountryCallingCode(iso) }))
    const pinned = PINNED.flatMap(iso => all.filter(country => country.iso === iso))
    const rest = all.filter(country => !PINNED.includes(country.iso)).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    return [...pinned, ...rest]
}

export const PHONE_COUNTRIES = buildCountries()

export function phoneCountry(iso: CountryCode): PhoneCountry {
    return PHONE_COUNTRIES.find(country => country.iso === iso) ?? PHONE_COUNTRIES[0]
}

export function phonePlaceholder(iso: CountryCode): string {
    return getExampleNumber(iso, mobileExamples)?.formatNational() ?? ''
}

/** Ranks a search in the country picker: exact code, then name start, then anything containing it. */
export function scoreCountrySearch(country: PhoneCountry, search: string): number {
    const query = search.trim().toLowerCase().replace(/^\+/, '')
    if (!query) return 1
    if (country.dial === query || country.iso.toLowerCase() === query) return 1
    const name = country.name.toLowerCase()
    if (name.startsWith(query)) return 0.8
    if (country.dial.startsWith(query)) return 0.6
    return name.includes(query) ? 0.4 : 0
}

const onlyDigits = (text: string) => text.replace(/\D/g, '')

/**
 * Turns what the input now holds into the next value. A number starting with + picks its own
 * country, so pasting or autofilling a full international number just works.
 *
 * `caret` is the cursor position inside `raw`. The formatter emits "(508)" for three digits, so
 * deleting the ")" alone would be undone by reformatting and Backspace would never get past it.
 * Deleting only punctuation therefore removes the digit before the cursor as well.
 */
export function applyPhoneText(current: PhoneValue, raw: string, caret: number = raw.length): PhoneValue {
    let digits = onlyDigits(raw).slice(0, MAX_DIGITS)
    if (raw.length < current.text.length && digits === onlyDigits(current.text)) {
        const before = onlyDigits(raw.slice(0, caret)).length
        if (before > 0) digits = digits.slice(0, before - 1) + digits.slice(before)
    }
    if (!raw.trimStart().startsWith('+')) {
        return { country: current.country, text: new AsYouType(current.country).input(digits) }
    }
    const international = `+${digits}`
    const parsed = parsePhoneNumberFromString(international)
    if (parsed?.country && parsed.isPossible()) {
        return { country: parsed.country, text: new AsYouType(parsed.country).input(parsed.nationalNumber) }
    }
    const typer = new AsYouType()
    const text = typer.input(international)
    return { country: typer.getCountry() ?? current.country, text }
}

/** Switching country keeps a national number; an international one belonged to the old country. */
export function changePhoneCountry(current: PhoneValue, country: CountryCode): PhoneValue {
    const text = current.text.startsWith('+') ? '' : new AsYouType(country).input(onlyDigits(current.text))
    return { country, text }
}

/** The E.164 number to send to the provider, or null when it cannot be a real number. */
export function phoneToE164(value: PhoneValue): string | null {
    const parsed = value.text.startsWith('+')
        ? parsePhoneNumberFromString(`+${onlyDigits(value.text)}`)
        : parsePhoneNumberFromString(value.text, value.country)
    return parsed?.isPossible() && E164.test(parsed.number) ? parsed.number : null
}

/** Where the cursor belongs after reformatting: right after the same count of digits. */
export function caretAfterDigits(text: string, digitCount: number): number {
    if (digitCount <= 0) return text.startsWith('(') ? 1 : 0
    let seen = 0
    for (let index = 0; index < text.length; index += 1) {
        if (/\d/.test(text[index]) && ++seen === digitCount) return index + 1
    }
    return text.length
}
