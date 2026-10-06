import { describe, expect, it } from 'vitest'
import { formatRelativeShort } from './inbox-relative-time'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000)

describe('formatRelativeShort', () => {
    it('uses "now" under a minute', () => {
        expect(formatRelativeShort(ago(10), NOW)).toBe('now')
    })

    it('formats minutes, hours and days compactly', () => {
        expect(formatRelativeShort(ago(5 * 60), NOW)).toBe('5m ago')
        expect(formatRelativeShort(ago(2 * 3600), NOW)).toBe('2h ago')
        expect(formatRelativeShort(ago(3 * 86400), NOW)).toBe('3d ago')
    })

    it('formats months and years', () => {
        expect(formatRelativeShort(ago(95 * 86400), NOW)).toBe('3mo ago')
        expect(formatRelativeShort(ago(400 * 86400), NOW)).toBe('1y ago')
    })

    it('never rounds up to the next unit at the boundaries', () => {
        expect(formatRelativeShort(ago(3599), NOW)).toBe('59m ago')
        expect(formatRelativeShort(ago(86399), NOW)).toBe('23h ago')
        expect(formatRelativeShort(ago(30 * 86400 - 1), NOW)).toBe('29d ago')
        expect(formatRelativeShort(ago(2 * 3600), NOW, true)).toBe('2h')
    })

    it('accepts ISO strings and returns empty for invalid dates', () => {
        expect(formatRelativeShort(ago(3600).toISOString(), NOW)).toBe('1h ago')
        expect(formatRelativeShort('garbage', NOW)).toBe('')
    })
})
