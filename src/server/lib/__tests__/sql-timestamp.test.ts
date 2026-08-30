import { describe, expect, it } from 'vitest'
import { sqlTimestampValue } from '../sql-timestamp'

describe('sqlTimestampValue', () => {
    it('serializes Date values before they reach postgres-js', () => {
        expect(sqlTimestampValue(new Date('2026-08-10T12:34:56.789Z')))
            .toBe('2026-08-10T12:34:56.789Z')
    })

    it('preserves null for nullable timestamp columns', () => {
        expect(sqlTimestampValue(null)).toBeNull()
        expect(sqlTimestampValue(undefined)).toBeNull()
    })

    // A boundary that trusts its input is what broke here.
    // `outreach_provider_cursors.last_received_at` is a real `timestamp` column,
    // declared `Date` end to end, and production still returned a string. Every
    // native inbound tick then threw `value?.toISOString is not a function` —
    // ~770 times a day, on every account.
    describe('when the driver does not return a Date', () => {
        it("accepts Postgres's own text rendering, the exact value production returned", () => {
            // Note the space instead of 'T', and no zone. This is what broke it.
            expect(sqlTimestampValue('2026-08-29 04:16:43'))
                .toBe(new Date('2026-08-29 04:16:43').toISOString())
        })

        it('accepts an ISO string and an epoch number', () => {
            expect(sqlTimestampValue('2026-08-29T04:16:43.000Z')).toBe('2026-08-29T04:16:43.000Z')
            expect(sqlTimestampValue(1788063403000)).toBe(new Date(1788063403000).toISOString())
        })

        it('throws on a non-timestamp rather than writing Invalid Date into a cursor', () => {
            expect(() => sqlTimestampValue('not a date')).toThrow(TypeError)
            // The message must name the offending value; a silent bad write would
            // corrupt the cursor and be far harder to trace than this throw.
            expect(() => sqlTimestampValue('not a date')).toThrow(/not a date/)
        })
    })
})
