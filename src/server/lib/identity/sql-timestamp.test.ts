import { describe, expect, it } from 'vitest'
import { nullableSqlTimestampDate, sqlTimestampDate, sqlTimestampParameter } from './sql-timestamp'

describe('raw identity timestamp boundary shared with Drizzle', () => {
    it.each([
        '2026-11-04T19:00:00.123Z',
        '2026-11-04 19:00:00.123+00',
        '2026-11-04 19:00:00.123000+00:00',
        '2026-11-04 16:00:00.123-03',
        '2026-11-04 19:00:00.123',
    ])('normalizes PostgreSQL/ISO timestamps without depending on process timezone: %s', value => {
        expect(sqlTimestampDate(value).toISOString()).toBe('2026-11-04T19:00:00.123Z')
    })
    it('preserves nullable revocation semantics and copies Dates into valid ISO parameters', () => {
        const date = new Date('2026-11-04T19:00:00.123Z')
        expect(sqlTimestampDate(date)).toEqual(date)
        expect(sqlTimestampDate(date)).not.toBe(date)
        expect(nullableSqlTimestampDate(null)).toBeNull()
        expect(nullableSqlTimestampDate(date)).toEqual(date)
        expect(sqlTimestampParameter(date)).toBe('2026-11-04T19:00:00.123Z')
    })
    it.each([undefined, 0, true, {}, 'invalid', '', '2026-11-04', '2026-13-04 19:00:00+00', new Date(NaN)])('refuses invalid/missing values instead of permitting a stale principal', value => {
        expect(() => sqlTimestampDate(value)).toThrow('Identity timestamp is unavailable.')
        expect(() => nullableSqlTimestampDate(value)).toThrow('Identity timestamp is unavailable.')
    })
})
