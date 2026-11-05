import { describe, expect, it } from 'vitest'
import { getCountries } from 'libphonenumber-js/min'
import { COUNTRY_FLAGS } from '../components/auth/country-flags'
import { applyPhoneText, caretAfterDigits, changePhoneCountry, PHONE_COUNTRIES, phoneCountry, phonePlaceholder, phoneToE164, scoreCountrySearch, type PhoneValue } from './phone-input'

const us: PhoneValue = { country: 'US', text: '' }
const type = (start: PhoneValue, keys: string) => [...keys].reduce((value, key) => applyPhoneText(value, value.text + key), start)

describe('country list', () => {
    it('offers every country the phone library knows, with US and Brazil first', () => {
        expect(PHONE_COUNTRIES).toHaveLength(getCountries().length)
        expect(PHONE_COUNTRIES.slice(0, 2).map(country => country.iso)).toEqual(['US', 'BR'])
        expect(phoneCountry('BR')).toEqual({ iso: 'BR', name: 'Brazil', dial: '55' })
    })

    it('only maps flags to real country codes, and covers the main ones', () => {
        for (const iso of Object.keys(COUNTRY_FLAGS)) expect(getCountries()).toContain(iso)
        for (const iso of ['US', 'BR', 'CA', 'GB', 'PT', 'MX', 'DE', 'FR', 'ES', 'IT', 'JP', 'IN'] as const) expect(COUNTRY_FLAGS[iso]).toBeDefined()
    })

    it('shows a number from the selected country as the placeholder', () => {
        expect(phonePlaceholder('US')).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/)
        expect(phonePlaceholder('BR')).toMatch(/^\(\d{2}\) \d{5}-\d{4}$/)
    })
})

describe('country search', () => {
    const matches = (search: string) => PHONE_COUNTRIES.filter(country => scoreCountrySearch(country, search) > 0).map(country => country.iso)

    it('finds a calling code without pulling in near misses', () => {
        expect(matches('55')).toEqual(['BR'])
        expect(matches('+55')).toEqual(['BR'])
        expect(matches('54')).not.toContain('BR')
    })

    it('finds a country by name or ISO code and ranks the exact code first', () => {
        expect(matches('brazil')).toEqual(['BR'])
        expect(matches('united')).toEqual(expect.arrayContaining(['US', 'GB', 'AE']))
        expect(scoreCountrySearch(phoneCountry('PT'), 'pt')).toBeGreaterThan(scoreCountrySearch(phoneCountry('SG'), 'pt'))
    })
})

describe('typing', () => {
    it('formats a national number as it is typed', () => {
        expect(type(us, '5085550100').text).toBe('(508) 555-0100')
    })

    it('lets Backspace go through the closing parenthesis the formatter adds', () => {
        const atAreaCode = type(us, '508')
        expect(atAreaCode.text).toBe('(508)')
        const next = applyPhoneText(atAreaCode, '(508')
        expect(next.text).toBe('50')
    })

    it('removes the digit before the cursor when only punctuation was deleted mid-number', () => {
        const full = type(us, '5085550100')
        expect(applyPhoneText(full, '(508 555-0100', 4).text).toBe('(505) 550-100')
    })

    it('stops accepting digits after the E.164 maximum', () => {
        expect(type(us, '12345678901234567890').text.replace(/\D/g, '')).toHaveLength(15)
    })

    it('can be cleared completely', () => {
        let value = type(us, '508')
        while (value.text) value = applyPhoneText(value, value.text.slice(0, -1))
        expect(value.text).toBe('')
    })

    it('takes the country from a typed or pasted international number', () => {
        expect(applyPhoneText(us, '+55 11 98765-4321')).toEqual({ country: 'BR', text: '(11) 98765-4321' })
        expect(type(us, '+5511987654321')).toEqual({ country: 'BR', text: '(11) 98765-4321' })
        expect(type(us, '+12025550123')).toEqual({ country: 'US', text: '(202) 555-0123' })
    })

    it('drops an unfinished international number when the country is switched by hand', () => {
        expect(changePhoneCountry({ country: 'BR', text: '+55 11' }, 'US').text).toBe('')
        expect(changePhoneCountry(type(us, '1198765'), 'BR').text).toBe('(11) 98765')
    })
})

describe('E.164 result', () => {
    it('combines the national number with the selected country', () => {
        expect(phoneToE164(type(us, '5085550100'))).toBe('+15085550100')
        expect(phoneToE164({ country: 'BR', text: '(11) 98765-4321' })).toBe('+5511987654321')
    })

    it('accepts an international number with no detected country yet', () => {
        expect(phoneToE164({ country: 'US', text: '+1 202 555 0123' })).toBe('+12025550123')
    })

    it('refuses numbers that are incomplete, too long or empty', () => {
        expect(phoneToE164(us)).toBeNull()
        expect(phoneToE164(type(us, '508555'))).toBeNull()
        expect(phoneToE164(type(us, '508555010012345'))).toBeNull()
        expect(phoneToE164({ country: 'US', text: '+' })).toBeNull()
    })
})

describe('cursor position', () => {
    it('lands right after the same number of digits', () => {
        expect(caretAfterDigits('(508) 555-0100', 3)).toBe(4)
        expect(caretAfterDigits('(508) 555-0100', 4)).toBe(7)
        expect(caretAfterDigits('(508) 555-0100', 0)).toBe(1)
        expect(caretAfterDigits('508', 0)).toBe(0)
        expect(caretAfterDigits('508', 99)).toBe(3)
    })
})
