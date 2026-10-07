import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { interpolateTemplate, type LeadForTemplate } from '../template-variables'
import { extractLeadZip, haversineMiles, normalizeZip } from '../zip-distance'

function lead(overrides: Partial<LeadForTemplate> = {}): LeadForTemplate {
    return {
        email: 'owner@example.test',
        firstName: 'Sam',
        lastName: null,
        companyName: 'Hudson Barber',
        companySize: null,
        industry: null,
        title: null,
        website: null,
        linkedinUrl: null,
        phone: null,
        location: null,
        customFields: {},
        ...overrides,
    }
}

const isNearby = (l: LeadForTemplate) => interpolateTemplate('{{#nearby}}Y{{/nearby}}{{^nearby}}N{{/nearby}}', l) === 'Y'
const hook = (flag: string, customFields: Record<string, unknown> | null) =>
    interpolateTemplate(`{{#${flag}}}Y{{/${flag}}}{{^${flag}}}N{{/${flag}}}`, lead({ customFields })) === 'Y'

const envBackup = {
    zip: process.env.OUTREACH_HOME_BASE_ZIP,
    radius: process.env.OUTREACH_HOME_RADIUS_MILES,
}
beforeEach(() => {
    // Every test starts from the default config, whatever the developer shell exports.
    delete process.env.OUTREACH_HOME_BASE_ZIP
    delete process.env.OUTREACH_HOME_RADIUS_MILES
})
afterEach(() => {
    if (envBackup.zip === undefined) delete process.env.OUTREACH_HOME_BASE_ZIP
    else process.env.OUTREACH_HOME_BASE_ZIP = envBackup.zip
    if (envBackup.radius === undefined) delete process.env.OUTREACH_HOME_RADIUS_MILES
    else process.env.OUTREACH_HOME_RADIUS_MILES = envBackup.radius
})

describe('nearby flag (default base 01702, default radius 30 miles)', () => {
    it('Boston 02116 is nearby', () => {
        expect(isNearby(lead({ location: '8 Hyde Park Ave, Boston, MA 02116' }))).toBe(true)
    })

    it('Jamaica Plain 02130 (the documented sample address) is nearby', () => {
        expect(isNearby(lead({ location: '8 Hyde Park Ave, Jamaica Plain, MA 02130' }))).toBe(true)
    })

    it('Worcester 01604 is nearby', () => {
        expect(isNearby(lead({ location: '1 Main St, Worcester, MA 01604' }))).toBe(true)
    })

    it('South Dennis 02660 is not nearby', () => {
        expect(isNearby(lead({ location: '5 Route 134, South Dennis, MA 02660' }))).toBe(false)
    })

    it('Providence RI 02903 (~32 miles) is out at the default 30-mile radius', () => {
        const miles = haversineMiles([42.282, -71.437], [41.819, -71.41])
        expect(miles).toBeGreaterThan(30)
        expect(miles).toBeLessThan(40)
        expect(isNearby(lead({ location: '10 Weybosset St, Providence, RI 02903' }))).toBe(false)
    })

    it('unknown / unparseable / missing ZIPs are false', () => {
        expect(isNearby(lead({ location: null }))).toBe(false)
        expect(isNearby(lead({ location: 'Boston, MA' }))).toBe(false)
        expect(isNearby(lead({ location: '5 Main St, Nowhere, MA 00000' }))).toBe(false) // not in dataset
        expect(isNearby(lead({ customFields: null }))).toBe(false)
    })

    it('uses the LAST 5-digit group of location and accepts ZIP+4', () => {
        // A 5-digit street number must not be mistaken for the ZIP.
        expect(extractLeadZip('12345 Main St, Boston, MA 02116', null)).toBe('02116')
        expect(extractLeadZip('8 Hyde Park Ave, Boston, MA 02116-1234', null)).toBe('02116')
        expect(extractLeadZip('12345 Main St, Boston, MA', null)).toBe('12345') // last group is all there is
        expect(extractLeadZip('Suite 100, Boston', null)).toBeNull()
    })

    it('customFields.zip / postal_code wins over location', () => {
        const far = '5 Route 134, South Dennis, MA 02660'
        expect(isNearby(lead({ location: far, customFields: { zip: '02116' } }))).toBe(true)
        expect(isNearby(lead({ location: far, customFields: { postal_code: '01604' } }))).toBe(true)
        expect(isNearby(lead({ location: '1 Main St, Boston, MA 02116', customFields: { zip: '02660' } }))).toBe(false)
        // Numeric ZIPs lose their leading zero in JSON: 1604 means 01604.
        expect(isNearby(lead({ customFields: { zip: 1604 } }))).toBe(true)
        // A present-but-invalid custom ZIP is "unknown", not a reason to fall back to location.
        expect(isNearby(lead({ location: '1 Main St, Boston, MA 02116', customFields: { zip: 'abc' } }))).toBe(false)
        // An empty custom ZIP is treated as absent.
        expect(isNearby(lead({ location: '1 Main St, Boston, MA 02116', customFields: { zip: '  ' } }))).toBe(true)
    })

    it('normalizeZip accepts ZIP, ZIP+4 and padded numbers only', () => {
        expect(normalizeZip('02116')).toBe('02116')
        expect(normalizeZip(' 02116-0001 ')).toBe('02116')
        expect(normalizeZip(1702)).toBe('01702')
        expect(normalizeZip('2116')).toBeNull()
        expect(normalizeZip('021166')).toBeNull()
        expect(normalizeZip(null)).toBeNull()
    })
})

describe('nearby flag: moving cities is an env change only', () => {
    it('OUTREACH_HOME_RADIUS_MILES widens the radius (Providence is out at 30, in at 40)', () => {
        const providence = lead({ location: '10 Weybosset St, Providence, RI 02903' })
        delete process.env.OUTREACH_HOME_BASE_ZIP
        delete process.env.OUTREACH_HOME_RADIUS_MILES
        expect(isNearby(providence)).toBe(false)
        process.env.OUTREACH_HOME_RADIUS_MILES = '40'
        expect(isNearby(providence)).toBe(true)
    })

    it('OUTREACH_HOME_RADIUS_MILES can also shrink it (Worcester ~17 miles)', () => {
        delete process.env.OUTREACH_HOME_BASE_ZIP
        process.env.OUTREACH_HOME_RADIUS_MILES = '10'
        expect(isNearby(lead({ location: '1 Main St, Worcester, MA 01604' }))).toBe(false)
        expect(isNearby(lead({ location: '1 Main St, Framingham, MA 01702' }))).toBe(true)
    })

    it('OUTREACH_HOME_BASE_ZIP moves the centre (base South Dennis: Cape Cod in, Boston out)', () => {
        delete process.env.OUTREACH_HOME_RADIUS_MILES
        process.env.OUTREACH_HOME_BASE_ZIP = '02660'
        expect(isNearby(lead({ location: '5 Route 134, South Dennis, MA 02660' }))).toBe(true)
        expect(isNearby(lead({ location: '8 Hyde Park Ave, Boston, MA 02116' }))).toBe(false)
    })

    it('a garbage radius falls back to the default, and an unknown base ZIP yields false', () => {
        delete process.env.OUTREACH_HOME_BASE_ZIP
        process.env.OUTREACH_HOME_RADIUS_MILES = 'abc'
        expect(isNearby(lead({ location: '8 Hyde Park Ave, Boston, MA 02116' }))).toBe(true)
        process.env.OUTREACH_HOME_RADIUS_MILES = '0'
        expect(isNearby(lead({ location: '8 Hyde Park Ave, Boston, MA 02116' }))).toBe(true)
        delete process.env.OUTREACH_HOME_RADIUS_MILES
        process.env.OUTREACH_HOME_BASE_ZIP = '00000'
        expect(isNearby(lead({ location: '8 Hyde Park Ave, Boston, MA 02116' }))).toBe(false)
    })
})

describe('hookNoOnlineBooking', () => {
    it('is true for an owned website with no booking platform and no booking URL', () => {
        expect(hook('hookNoOnlineBooking', { has_owned_website: true })).toBe(true)
        expect(hook('hookNoOnlineBooking', { has_owned_website: 'true' })).toBe(true)
        expect(hook('hookNoOnlineBooking', { has_owned_website: true, booking_platform: null, booking_url: '' })).toBe(true)
        expect(hook('hookNoOnlineBooking', { has_owned_website: true, booking_platform: '  ' })).toBe(true)
    })

    it('is false when either booking signal is present', () => {
        expect(hook('hookNoOnlineBooking', { has_owned_website: true, booking_platform: 'Booksy' })).toBe(false)
        expect(hook('hookNoOnlineBooking', { has_owned_website: true, booking_url: 'https://x.test/book' })).toBe(false)
    })

    it('is false without an owned website, or with missing data', () => {
        expect(hook('hookNoOnlineBooking', { has_owned_website: false })).toBe(false)
        expect(hook('hookNoOnlineBooking', { has_owned_website: 'false' })).toBe(false)
        expect(hook('hookNoOnlineBooking', {})).toBe(false)
        expect(hook('hookNoOnlineBooking', null)).toBe(false)
    })
})

describe('hookNoWebsite', () => {
    it('is true only when has_owned_website is false and the presence type says it is not an owned site', () => {
        expect(hook('hookNoWebsite', { has_owned_website: false, web_presence_type: 'social_only' })).toBe(true)
        expect(hook('hookNoWebsite', { has_owned_website: 'false', web_presence_type: 'directory_listing' })).toBe(true)
    })

    it('is false on missing data: a failed site analysis is not "no website"', () => {
        expect(hook('hookNoWebsite', {})).toBe(false)
        expect(hook('hookNoWebsite', null)).toBe(false)
        expect(hook('hookNoWebsite', { has_owned_website: false })).toBe(false)
        expect(hook('hookNoWebsite', { has_owned_website: false, web_presence_type: null })).toBe(false)
        expect(hook('hookNoWebsite', { has_owned_website: false, web_presence_type: '' })).toBe(false)
        expect(hook('hookNoWebsite', { web_presence_type: 'social_only' })).toBe(false)
    })

    it('is false when the presence type is owned_website, or the site exists', () => {
        expect(hook('hookNoWebsite', { has_owned_website: false, web_presence_type: 'owned_website' })).toBe(false)
        expect(hook('hookNoWebsite', { has_owned_website: true, web_presence_type: 'social_only' })).toBe(false)
    })
})

describe('the two hook flags are mutually exclusive', () => {
    const values = [true, false, 'true', 'false', null, undefined, '']
    const presence = ['owned_website', 'social_only', null, undefined]
    const booking = [null, '', 'Booksy']

    it('never both true, over the whole input grid', () => {
        for (const has of values) {
            for (const web of presence) {
                for (const platform of booking) {
                    const cf = { has_owned_website: has, web_presence_type: web, booking_platform: platform }
                    expect(hook('hookNoOnlineBooking', cf) && hook('hookNoWebsite', cf)).toBe(false)
                }
            }
        }
    })
})
