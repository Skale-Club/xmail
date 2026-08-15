/**
 * O join de atribuição do caminho (b) é `custom_fields->>'source_run_id' = runs.idempotency_key`.
 * Se essa chave não existir, o run fica com outcome zerado para sempre — e foi exatamente o que
 * aconteceu em produção, porque o Xphere carimba `xcraper_run_id` e o Xmail procura `source_run_id`.
 */
import { describe, expect, it } from 'vitest'
import { resolveSourceRunId, withSourceRunId } from '../source-run-id'

const RUN = 'd3925cef-5561-4a6a-b50a-e21725c3f61b'

describe('resolveSourceRunId', () => {
    it('prefere source_run_id quando já existe', () => {
        expect(resolveSourceRunId({ source_run_id: RUN, xcraper_run_id: 'outro' })).toBe(RUN)
    })

    it('aceita o xcraper_run_id que o Xphere realmente manda', () => {
        expect(resolveSourceRunId({ xcraper_run_id: RUN })).toBe(RUN)
    })

    it('aceita os demais apelidos conhecidos', () => {
        expect(resolveSourceRunId({ external_run_id: RUN })).toBe(RUN)
        expect(resolveSourceRunId({ prospecting_run_id: RUN })).toBe(RUN)
    })

    it('extrai do source quando nenhum apelido está presente', () => {
        expect(resolveSourceRunId({}, `xcraper:${RUN}`)).toBe(RUN)
        expect(resolveSourceRunId(null, `apollo:${RUN}`)).toBe(RUN)
    })

    it('devolve null quando não há sinal — melhor não atribuir do que atribuir errado', () => {
        expect(resolveSourceRunId({}, null)).toBeNull()
        expect(resolveSourceRunId(null, undefined)).toBeNull()
        expect(resolveSourceRunId({}, 'hermes')).toBeNull()   // sem `:`, não é `<provider>:<id>`
        expect(resolveSourceRunId({ xcraper_run_id: '   ' })).toBeNull()
    })

    it('ignora custom fields que não são objeto', () => {
        // Uma coluna jsonb duplo-codificada chega como STRING pelo SQL cru. Não pode virar um
        // source_run_id acidental. Ver a §13 do mapa do sistema.
        expect(resolveSourceRunId('{"xcraper_run_id":"x"}')).toBeNull()
        expect(resolveSourceRunId(['x'])).toBeNull()
    })
})

describe('withSourceRunId', () => {
    it('carimba a chave canônica preservando o apelido original', () => {
        const out = withSourceRunId({ xcraper_run_id: RUN, xphere_id: 'abc' })
        expect(out).toEqual({ xcraper_run_id: RUN, xphere_id: 'abc', source_run_id: RUN })
    })

    it('não reescreve um source_run_id existente — primeiro toque vence', () => {
        // Deixar um re-import posterior sobrescrever faria dois runs reivindicarem o mesmo humano.
        const original = { source_run_id: 'primeiro', xcraper_run_id: 'segundo' }
        const out = withSourceRunId(original)
        expect(out).toBe(original)
        expect(out?.source_run_id).toBe('primeiro')
    })

    it('carimba a partir do source quando os custom fields vêm vazios', () => {
        expect(withSourceRunId(undefined, `xcraper:${RUN}`)).toEqual({ source_run_id: RUN })
    })

    it('devolve os campos intactos quando não há como resolver', () => {
        expect(withSourceRunId({ a: 1 }, null)).toEqual({ a: 1 })
        expect(withSourceRunId(undefined, null)).toBeUndefined()
    })
})
