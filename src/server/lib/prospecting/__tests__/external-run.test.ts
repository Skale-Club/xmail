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

describe('ingestedCount / importedCount (contrato Xphere→Xmail, 2026-08-20)', () => {
    // ingestedCount counts prospects created/updated at the SOURCE system (xcraper/Apify),
    // NOT leads that reached xmail — see the doc comment on the schema and on the route.
    // importedCount is kept only as a deprecated alias so the currently-deployed Xphere
    // (which still sends this field name) keeps working.

    it('accepts ingestedCount and resolves it onto the output', () => {
        const parsed = externalRunSchema.parse(validInput({ ingestedCount: 30, importedCount: undefined }))
        expect(parsed.ingestedCount).toBe(30)
    })

    it('still accepts importedCount as a deprecated alias', () => {
        const parsed = externalRunSchema.parse(validInput({ importedCount: 12, ingestedCount: undefined }))
        expect(parsed.ingestedCount).toBe(12)
    })

    it('prefers ingestedCount when both are sent', () => {
        const parsed = externalRunSchema.parse(validInput({ ingestedCount: 30, importedCount: 12 }))
        expect(parsed.ingestedCount).toBe(30)
    })

    it('leaves ingestedCount undefined when neither field is sent', () => {
        const parsed = externalRunSchema.parse({ provider: 'xcraper', externalRunId: 'run-neither' })
        expect(parsed.ingestedCount).toBeUndefined()
    })

    it('rejects a negative ingestedCount', () => {
        expect(() => externalRunSchema.parse(validInput({ ingestedCount: -1, importedCount: undefined }))).toThrow()
    })

    it('rejects a non-integer ingestedCount', () => {
        expect(() => externalRunSchema.parse(validInput({ ingestedCount: 1.5, importedCount: undefined }))).toThrow()
    })
})

describe('cobertura do run (contrato Xphere→Xmail, 2026-08-15)', () => {
    it('aceita enrichedCount e coverage completos', () => {
        const parsed = externalRunSchema.parse({
            provider: 'xcraper',
            externalRunId: 'run-1',
            enrichedCount: 18,
            coverage: {
                emailFound: 18,
                emailVerified: 11,
                byWebPresence: { owned_website: 9, booking_platform: 7 },
                byBookingPlatform: { booksy: 4 },
                unclassified: 4,
            },
        })
        expect(parsed.enrichedCount).toBe(18)
        expect(parsed.coverage?.emailVerified).toBe(11)
        expect(parsed.coverage?.byWebPresence?.owned_website).toBe(9)
        // unclassified fica SEPARADO de propósito: somá-lo a "sem site" inventaria cobertura.
        expect(parsed.coverage?.unclassified).toBe(4)
    })

    it('aceita o payload atual do Xphere, que não manda nada disso', () => {
        // O contrato não pode quebrar o produtor enquanto ele não se atualiza. Ausente permanece
        // ausente e VISÍVEL — o alerta enriched_count_never_populated é quem cobra.
        const parsed = externalRunSchema.parse({ provider: 'xcraper', externalRunId: 'run-2', resultCount: 25 })
        expect(parsed.enrichedCount).toBeUndefined()
        expect(parsed.coverage).toBeUndefined()
    })

    it('rejeita contagem negativa', () => {
        expect(() => externalRunSchema.parse({
            provider: 'xcraper', externalRunId: 'run-3', enrichedCount: -1,
        })).toThrow()
        expect(() => externalRunSchema.parse({
            provider: 'xcraper', externalRunId: 'run-4', coverage: { emailFound: -2 },
        })).toThrow()
    })

    it('aceita chaves livres em byWebPresence — o vocabulário é do Xphere', () => {
        const parsed = externalRunSchema.parse({
            provider: 'xcraper', externalRunId: 'run-5',
            coverage: { byWebPresence: { link_hub: 2, directory_only: 3, qualquer_coisa_nova: 1 } },
        })
        expect(parsed.coverage?.byWebPresence?.qualquer_coisa_nova).toBe(1)
    })
})
