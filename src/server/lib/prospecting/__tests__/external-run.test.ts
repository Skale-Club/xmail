import { describe, expect, it } from 'vitest'
import { externalRunSchema } from '../external-run'

function validInput(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        provider: 'xcraper',
        externalRunId: 'xcraper-run-123',
        label: 'Bakeries in Denver',
        query: 'bakery',
        location: 'Denver, CO',
        resultCount: 40,
        importedCount: 12,
        costUsd: 0.2153,
        actorId: 'compass~google-maps-scraper',
        template: 'restaurants-v2',
        ...overrides,
    }
}

describe('externalRunSchema', () => {
    it('accepts a fully-populated valid payload', () => {
        const parsed = externalRunSchema.parse(validInput())
        expect(parsed.provider).toBe('xcraper')
        expect(parsed.externalRunId).toBe('xcraper-run-123')
        expect(parsed.costUsd).toBe(0.2153)
    })

    it('accepts the minimal payload (only provider + externalRunId)', () => {
        const parsed = externalRunSchema.parse({ provider: 'xcraper', externalRunId: 'run-1' })
        expect(parsed).toMatchObject({ provider: 'xcraper', externalRunId: 'run-1' })
    })

    it('rejects a provider other than xcraper', () => {
        expect(() => externalRunSchema.parse(validInput({ provider: 'apollo' }))).toThrow()
        expect(() => externalRunSchema.parse(validInput({ provider: 'apify' }))).toThrow()
    })

    it('rejects a missing externalRunId', () => {
        const { externalRunId: _externalRunId, ...rest } = validInput()
        expect(() => externalRunSchema.parse(rest)).toThrow()
    })

    it('rejects an empty externalRunId', () => {
        expect(() => externalRunSchema.parse(validInput({ externalRunId: '' }))).toThrow()
    })

    it('rejects an externalRunId over the 200-char cap', () => {
        expect(() => externalRunSchema.parse(validInput({ externalRunId: 'x'.repeat(201) }))).toThrow()
    })

    it('accepts an externalRunId at exactly the 200-char cap', () => {
        expect(() => externalRunSchema.parse(validInput({ externalRunId: 'x'.repeat(200) }))).not.toThrow()
    })

    it('rejects a negative costUsd', () => {
        expect(() => externalRunSchema.parse(validInput({ costUsd: -0.01 }))).toThrow()
    })

    it('accepts a zero costUsd', () => {
        expect(() => externalRunSchema.parse(validInput({ costUsd: 0 }))).not.toThrow()
    })

    it('rejects a negative resultCount / importedCount', () => {
        expect(() => externalRunSchema.parse(validInput({ resultCount: -1 }))).toThrow()
        expect(() => externalRunSchema.parse(validInput({ importedCount: -1 }))).toThrow()
    })

    it('rejects a non-integer resultCount', () => {
        expect(() => externalRunSchema.parse(validInput({ resultCount: 1.5 }))).toThrow()
    })

    it('accepts an optional hypothesis payload', () => {
        const parsed = externalRunSchema.parse(validInput({ hypothesis: { premise: 'Local businesses reply better to a personal tone' } }))
        expect(parsed.hypothesis).toEqual({ premise: 'Local businesses reply better to a personal tone' })
    })
})
