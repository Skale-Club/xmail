import { describe, expect, it } from 'vitest'
import {
    isQuietHours,
    isReminderDue,
    localParts,
    morningAnchor,
    nextReminderAt,
    nextWindowOpening,
    REMINDER_INTERVAL_MS,
    zonedWallTimeToUtc,
} from '../schedule'

const at = (iso: string) => new Date(iso)

describe('localParts', () => {
    it('reads the New York wall clock, with and without DST', () => {
        // 2026-07-15 is EDT (UTC-4), 2026-01-15 is EST (UTC-5).
        expect(localParts(at('2026-07-15T12:00:00Z'))).toMatchObject({ hour: 8, minute: 0, day: 15 })
        expect(localParts(at('2026-01-15T13:00:00Z'))).toMatchObject({ hour: 8, minute: 0, day: 15 })
    })

    it('never reports hour 24 at local midnight', () => {
        expect(localParts(at('2026-07-15T04:00:00Z')).hour).toBe(0)
    })
})

describe('isQuietHours (08:00-20:00 America/New_York)', () => {
    it.each([
        ['2026-07-15T11:59:00Z', true], // 07:59 EDT
        ['2026-07-15T12:00:00Z', false], // 08:00 EDT
        ['2026-07-15T23:59:00Z', false], // 19:59 EDT
        ['2026-07-16T00:00:00Z', true], // 20:00 EDT
        ['2026-07-15T04:00:00Z', true], // 00:00 EDT
    ])('summer %s -> quiet=%s', (iso, quiet) => {
        expect(isQuietHours(at(iso))).toBe(quiet)
    })

    it.each([
        ['2026-01-15T12:59:00Z', true], // 07:59 EST
        ['2026-01-15T13:00:00Z', false], // 08:00 EST
        ['2026-01-16T00:59:00Z', false], // 19:59 EST
        ['2026-01-16T01:00:00Z', true], // 20:00 EST
    ])('winter %s -> quiet=%s', (iso, quiet) => {
        expect(isQuietHours(at(iso))).toBe(quiet)
    })

    it('follows the clock across the spring-forward day (2026-03-08)', () => {
        // The day before the change the wall clock is EST (UTC-5); from 02:00 on the 8th it is EDT.
        expect(isQuietHours(at('2026-03-07T12:00:00Z'))).toBe(true) // 07:00 EST
        expect(isQuietHours(at('2026-03-07T13:00:00Z'))).toBe(false) // 08:00 EST
        expect(isQuietHours(at('2026-03-08T11:59:00Z'))).toBe(true) // 07:59 EDT
        expect(isQuietHours(at('2026-03-08T12:00:00Z'))).toBe(false) // 08:00 EDT
    })

    it('follows the clock across the fall-back day (2026-11-01)', () => {
        expect(isQuietHours(at('2026-11-01T12:59:00Z'))).toBe(true) // 07:59 EST
        expect(isQuietHours(at('2026-11-01T13:00:00Z'))).toBe(false) // 08:00 EST
        expect(isQuietHours(at('2026-11-02T00:59:00Z'))).toBe(false) // 19:59 EST
        expect(isQuietHours(at('2026-11-02T01:00:00Z'))).toBe(true) // 20:00 EST
    })
})

describe('zonedWallTimeToUtc / morningAnchor', () => {
    it('maps 08:00 local to the right UTC instant on both sides of a DST change', () => {
        expect(morningAnchor(at('2026-03-07T20:00:00Z')).toISOString()).toBe('2026-03-07T13:00:00.000Z') // EST
        expect(morningAnchor(at('2026-03-08T20:00:00Z')).toISOString()).toBe('2026-03-08T12:00:00.000Z') // EDT
        expect(morningAnchor(at('2026-10-31T20:00:00Z')).toISOString()).toBe('2026-10-31T12:00:00.000Z') // EDT
        expect(morningAnchor(at('2026-11-01T20:00:00Z')).toISOString()).toBe('2026-11-01T13:00:00.000Z') // EST
    })

    it('round-trips an arbitrary wall time', () => {
        const utc = zonedWallTimeToUtc({ year: 2026, month: 7, day: 4, hour: 15, minute: 30 })
        expect(utc.toISOString()).toBe('2026-07-04T19:30:00.000Z')
    })
})

describe('nextWindowOpening', () => {
    it('is the same day when called before 08:00', () => {
        expect(nextWindowOpening(at('2026-07-15T07:00:00Z')).toISOString()).toBe('2026-07-15T12:00:00.000Z') // 03:00 EDT
    })

    it('is the next day when called after 08:00', () => {
        // 21:00 EDT on the 15th -> 08:00 EDT on the 16th
        expect(nextWindowOpening(at('2026-07-16T01:00:00Z')).toISOString()).toBe('2026-07-16T12:00:00.000Z')
    })

    it('crosses the spring-forward change', () => {
        // 2026-03-07 20:30 EST -> 2026-03-08 08:00 EDT
        expect(nextWindowOpening(at('2026-03-08T01:30:00Z')).toISOString()).toBe('2026-03-08T12:00:00.000Z')
    })

    it('crosses the fall-back change', () => {
        // 2026-10-31 20:30 EDT -> 2026-11-01 08:00 EST
        expect(nextWindowOpening(at('2026-11-01T00:30:00Z')).toISOString()).toBe('2026-11-01T13:00:00.000Z')
    })

    it('rolls over month and year ends', () => {
        // 2026-12-31 22:00 EST -> 2027-01-01 08:00 EST
        expect(nextWindowOpening(at('2027-01-01T03:00:00Z')).toISOString()).toBe('2027-01-01T13:00:00.000Z')
        // 2026-01-31 21:00 EST -> 2026-02-01 08:00 EST
        expect(nextWindowOpening(at('2026-02-01T02:00:00Z')).toISOString()).toBe('2026-02-01T13:00:00.000Z')
    })
})

describe('nextReminderAt', () => {
    it('is two hours later during the day', () => {
        const last = at('2026-07-15T14:00:00Z') // 10:00 EDT
        expect(nextReminderAt(last).toISOString()).toBe('2026-07-15T16:00:00.000Z')
        expect(nextReminderAt(last).getTime() - last.getTime()).toBe(REMINDER_INTERVAL_MS)
    })

    it('stays in the window when +2h lands at 19:59', () => {
        expect(nextReminderAt(at('2026-07-15T21:59:00Z')).toISOString()).toBe('2026-07-15T23:59:00.000Z')
    })

    it('waits for 08:00 when +2h lands at or after 20:00', () => {
        // 18:00 EDT + 2h = 20:00 EDT (quiet) -> 08:00 EDT next day
        expect(nextReminderAt(at('2026-07-15T22:00:00Z')).toISOString()).toBe('2026-07-16T12:00:00.000Z')
        // 19:00 EDT + 2h = 21:00 EDT
        expect(nextReminderAt(at('2026-07-15T23:00:00Z')).toISOString()).toBe('2026-07-16T12:00:00.000Z')
    })

    it('waits for 08:00 of the SAME day when the last alert was in the small hours', () => {
        // 01:00 EDT + 2h = 03:00 EDT (quiet) -> 08:00 EDT same day
        expect(nextReminderAt(at('2026-07-15T05:00:00Z')).toISOString()).toBe('2026-07-15T12:00:00.000Z')
    })

    it('handles the DST changes', () => {
        // 2026-03-07 19:30 EST + 2h = 21:30 EST -> 2026-03-08 08:00 EDT
        expect(nextReminderAt(at('2026-03-08T00:30:00Z')).toISOString()).toBe('2026-03-08T12:00:00.000Z')
        // 2026-10-31 19:30 EDT + 2h = 21:30 EDT -> 2026-11-01 08:00 EST
        expect(nextReminderAt(at('2026-10-31T23:30:00Z')).toISOString()).toBe('2026-11-01T13:00:00.000Z')
    })
})

describe('isReminderDue', () => {
    const last = at('2026-07-15T14:00:00Z') // 10:00 EDT

    it('is not due before two hours', () => {
        expect(isReminderDue(last, at('2026-07-15T15:59:00Z'))).toBe(false)
    })

    it('is due from two hours on, inside the window', () => {
        expect(isReminderDue(last, at('2026-07-15T16:00:00Z'))).toBe(true)
        expect(isReminderDue(last, at('2026-07-15T19:00:00Z'))).toBe(true)
    })

    it('is never due in the quiet window, even long overdue', () => {
        expect(isReminderDue(last, at('2026-07-16T00:30:00Z'))).toBe(false) // 20:30 EDT
        expect(isReminderDue(last, at('2026-07-16T10:00:00Z'))).toBe(false) // 06:00 EDT
    })

    it('becomes due again at 08:00 after a night of silence', () => {
        expect(isReminderDue(last, at('2026-07-16T12:00:00Z'))).toBe(true)
    })
})
