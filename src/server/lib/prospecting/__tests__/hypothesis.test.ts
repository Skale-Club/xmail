import { describe, expect, it } from 'vitest'
import { hypothesisSchema, MAX_HYPOTHESIS_BYTES } from '../hypothesis'

describe('hypothesisSchema', () => {
    it('accepts a valid, fully-populated hypothesis object', () => {
        const parsed = hypothesisSchema.parse({
            premise: 'VPs of Sales at 50-200 person SaaS companies reply better to ROI framing',
            expected: { replyRate: '8%', sampleSize: 150 },
            basis: 'Similar ICP performed at 7-9% in the last two campaigns',
        })

        expect(parsed).toEqual({
            premise: 'VPs of Sales at 50-200 person SaaS companies reply better to ROI framing',
            expected: { replyRate: '8%', sampleSize: 150 },
            basis: 'Similar ICP performed at 7-9% in the last two campaigns',
        })
    })

    it('accepts an empty object (every field optional)', () => {
        expect(hypothesisSchema.parse({})).toEqual({})
    })

    it('accepts a partial object with only one field set', () => {
        expect(hypothesisSchema.parse({ premise: 'test premise' })).toEqual({ premise: 'test premise' })
    })

    it('rejects a payload whose serialized size exceeds the 4KB cap', () => {
        const oversized = { premise: 'x'.repeat(MAX_HYPOTHESIS_BYTES) }

        expect(() => hypothesisSchema.parse(oversized)).toThrow()
    })

    it('accepts a payload comfortably under the cap and rejects one that crosses it', () => {
        const under = { expected: { note: 'y'.repeat(100) } }
        expect(JSON.stringify(under).length).toBeLessThan(MAX_HYPOTHESIS_BYTES)
        expect(() => hypothesisSchema.parse(under)).not.toThrow()

        // `expected` has no cap on key count (only a per-value max(500)), so piling on
        // enough distinct keys is a reliable way to cross the total-size cap without
        // relying on any single field's own max().
        const over: Record<string, string> = {}
        for (let i = 0; i < 15; i += 1) over[`key${i}`] = 'z'.repeat(400)
        expect(JSON.stringify({ expected: over }).length).toBeGreaterThan(MAX_HYPOTHESIS_BYTES)
        expect(() => hypothesisSchema.parse({ expected: over })).toThrow()
    })

    it('rejects an unknown-shaped expected value (not string|number)', () => {
        expect(() => hypothesisSchema.parse({ expected: { nested: { a: 1 } } })).toThrow()
    })
})

describe('hypothesis default via .default({})', () => {
    it('defaults an undefined field to {} when embedded in a wrapping schema', () => {
        // Mirrors how agent-prospecting.ts uses `hypothesis: hypothesisSchema.default({})`.
        const wrapper = hypothesisSchema.default({})
        expect(wrapper.parse(undefined)).toEqual({})
    })
})
