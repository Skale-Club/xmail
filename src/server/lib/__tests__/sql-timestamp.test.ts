import { describe, expect, it } from 'vitest'
import { sqlTimestampValue } from '../sql-timestamp'

describe('sqlTimestampValue', () => {
    it('serializes Date values before they reach postgres-js', () => {
        expect(sqlTimestampValue(new Date('2026-08-10T12:34:56.789Z')))
            .toBe('2026-08-10T12:34:56.789Z')
    })

    it('preserves null for nullable timestamp columns', () => {
        expect(sqlTimestampValue(null)).toBeNull()
    })
})
