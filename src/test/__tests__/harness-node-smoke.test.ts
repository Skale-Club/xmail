import { describe, expect, it } from 'vitest'

describe('server test harness', () => {
    it('runs TypeScript tests in the Node environment', () => {
        expect(typeof process.version).toBe('string')
        expect(typeof globalThis.document).toBe('undefined')
    })
})
