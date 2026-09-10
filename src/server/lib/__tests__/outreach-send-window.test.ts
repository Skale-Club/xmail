import { describe, expect, it } from 'vitest'
import { getZonedDateParts, isWithinWindow, nextWindowStart, type SendWindow } from '../outreach-send-window'

const utcWindow: SendWindow = {
    timezone: 'UTC',
    sendStartTime: '09:00',
    sendEndTime: '17:00',
    sendOnWeekends: false,
}

describe('getZonedDateParts', () => {
    it('reads weekday/hour/minute on the wall clock of the given zone', () => {
        // 2026-07-16T10:30:00Z is a Thursday.
        expect(getZonedDateParts(new Date('2026-07-16T10:30:00.000Z'), 'UTC')).toEqual({
            weekday: 4,
            hour: 10,
            minute: 30,
        })
    })

    it('falls back to UTC instead of throwing on an unknown zone', () => {
        expect(() => getZonedDateParts(new Date('2026-07-16T10:30:00.000Z'), 'Not/AZone')).not.toThrow()
    })
})

describe('isWithinWindow', () => {
    it('is true inside business hours on a weekday', () => {
        expect(isWithinWindow(new Date('2026-07-16T10:00:00.000Z'), utcWindow)).toBe(true)
    })

    it('is false before the start time', () => {
        expect(isWithinWindow(new Date('2026-07-16T08:59:00.000Z'), utcWindow)).toBe(false)
    })

    it('is false after the end time', () => {
        expect(isWithinWindow(new Date('2026-07-16T17:01:00.000Z'), utcWindow)).toBe(false)
    })

    it('is false on a weekend when weekends are disabled', () => {
        // 2026-07-18 is a Saturday.
        expect(isWithinWindow(new Date('2026-07-18T10:00:00.000Z'), utcWindow)).toBe(false)
    })

    it('is true on a weekend when weekends are enabled', () => {
        expect(isWithinWindow(new Date('2026-07-18T10:00:00.000Z'), { ...utcWindow, sendOnWeekends: true })).toBe(true)
    })
})

describe('nextWindowStart', () => {
    it('returns the same instant when it is already inside the window', () => {
        const from = new Date('2026-07-16T10:00:00.000Z')
        expect(nextWindowStart(from, utcWindow)).toEqual(from)
    })

    it('rounds down to the minute but keeps the same instant when already inside the window', () => {
        const from = new Date('2026-07-16T10:00:30.500Z')
        expect(nextWindowStart(from, utcWindow)).toEqual(new Date('2026-07-16T10:00:00.000Z'))
    })

    it('rolls forward to the same day start time when called before opening', () => {
        expect(nextWindowStart(new Date('2026-07-16T06:00:00.000Z'), utcWindow))
            .toEqual(new Date('2026-07-16T09:00:00.000Z'))
    })

    it('rolls a closed evening across the weekend to Monday morning', () => {
        // Friday 18:00 UTC -> next opening is Monday 09:00 UTC (Sat/Sun skipped).
        expect(nextWindowStart(new Date('2026-07-17T18:00:00.000Z'), utcWindow))
            .toEqual(new Date('2026-07-20T09:00:00.000Z'))
    })

    it('skips a weekend-enabled window straight through to the same evening close', () => {
        const weekendWindow = { ...utcWindow, sendOnWeekends: true }
        // Saturday 06:00 UTC -> opens the same day at 09:00.
        expect(nextWindowStart(new Date('2026-07-18T06:00:00.000Z'), weekendWindow))
            .toEqual(new Date('2026-07-18T09:00:00.000Z'))
    })

    it('returns null for an impossible window (start >= end)', () => {
        expect(nextWindowStart(new Date('2026-07-16T10:00:00.000Z'), {
            ...utcWindow,
            sendStartTime: '17:00',
            sendEndTime: '09:00',
        })).toBeNull()
    })

    it('returns null when start === end (zero-width window)', () => {
        expect(nextWindowStart(new Date('2026-07-16T10:00:00.000Z'), {
            ...utcWindow,
            sendStartTime: '09:00',
            sendEndTime: '09:00',
        })).toBeNull()
    })

    it('crosses a US spring-forward DST transition to the correct local start time', () => {
        // America/New_York: DST begins 2026-03-08 at 02:00 local (EST/UTC-5 -> EDT/UTC-4).
        // Friday 2026-03-06 20:00 ET (01:00Z Sat) is closed for the weekend; the window must
        // reopen Monday 2026-03-09 09:00 ET, which by then is EDT (UTC-4) — 13:00Z, not 14:00Z.
        const nyWindow: SendWindow = {
            timezone: 'America/New_York',
            sendStartTime: '09:00',
            sendEndTime: '17:00',
            sendOnWeekends: false,
        }
        const fridayEvening = new Date('2026-03-07T01:00:00.000Z') // Fri 20:00 EST
        expect(nextWindowStart(fridayEvening, nyWindow)).toEqual(new Date('2026-03-09T13:00:00.000Z'))
    })

    it('crosses a US fall-back DST transition to the correct local start time', () => {
        // America/New_York: DST ends 2026-11-01 at 02:00 local (EDT/UTC-4 -> EST/UTC-5).
        // Friday 2026-10-30 20:00 ET (00:00Z Sat, still EDT) is closed for the weekend; reopens
        // Monday 2026-11-02 09:00 ET, by then EST (UTC-5) -> 14:00Z, not 13:00Z.
        const nyWindow: SendWindow = {
            timezone: 'America/New_York',
            sendStartTime: '09:00',
            sendEndTime: '17:00',
            sendOnWeekends: false,
        }
        const fridayEvening = new Date('2026-10-31T00:00:00.000Z') // Fri 20:00 EDT
        expect(nextWindowStart(fridayEvening, nyWindow)).toEqual(new Date('2026-11-02T14:00:00.000Z'))
    })

    it('never returns an instant before `from`', () => {
        const from = new Date('2026-07-16T20:00:00.000Z')
        const result = nextWindowStart(from, utcWindow)
        expect(result).not.toBeNull()
        expect((result as Date).getTime()).toBeGreaterThanOrEqual(from.getTime())
    })
})
