import { describe, expect, it } from 'vitest'
import { extractCity, interpolateTemplate, type LeadForTemplate } from '../template-variables'

function lead(customFields: Record<string, unknown>): LeadForTemplate {
    return {
        email: 'owner@example.test',
        firstName: 'Sam',
        lastName: null,
        companyName: 'Hudson Barber',
        companySize: null,
        industry: null,
        title: null,
        website: null,
        linkedinUrl: null,
        phone: null,
        location: null,
        customFields,
    }
}

describe('websiteInsight template variable', () => {
    const websiteInsights = {
        en: 'I noticed the booking path is hard to find.',
        'pt-BR': 'Notei que o caminho para agendar está difícil de encontrar.',
        es: 'Noté que es difícil encontrar la opción para reservar.',
    }

    it('uses the campaign language while keeping the token name stable in English', () => {
        const value = interpolateTemplate(
            '{{websiteInsight}}',
            lead({ websiteInsights }),
            { contentLanguage: 'pt-BR' },
        )
        expect(value).toBe(websiteInsights['pt-BR'])
    })

    it('falls back from a regional language to its base language and then English', () => {
        expect(interpolateTemplate('{{websiteInsight}}', lead({ websiteInsights }), { contentLanguage: 'es-MX' }))
            .toBe(websiteInsights.es)
        expect(interpolateTemplate('{{websiteInsight}}', lead({ websiteInsights }), { contentLanguage: 'fr' }))
            .toBe(websiteInsights.en)
    })
})

describe('extractCity — cidade a partir do endereço do Xcraper', () => {
    it('pega a cidade no formato postal completo dos EUA', () => {
        expect(extractCity('75 Main St, Hudson, MA 01749')).toBe('Hudson')
        expect(extractCity('234 Washington St #6, Hudson, MA 01749')).toBe('Hudson')
    })

    it('aceita cidade + estado sem CEP', () => {
        expect(extractCity('Hudson, MA')).toBe('Hudson')
    })

    it('devolve vazio quando não dá para decidir, em vez de chutar', () => {
        // Chutar aqui escreveria a cidade ERRADA no corpo do e-mail, que é pior que a frase
        // ficar sem cidade. Por isso o default é vazio e não algo como 'your area'.
        expect(extractCity('Hudson')).toBe('')
        expect(extractCity('')).toBe('')
        expect(extractCity(null)).toBe('')
        expect(extractCity(undefined)).toBe('')
    })

    it('não devolve um segmento puramente numérico como cidade', () => {
        expect(extractCity('75 Main St, 01749')).toBe('')
    })

    it('usa o último segmento quando ele não parece estado/CEP', () => {
        expect(extractCity('Rua das Flores, Sao Paulo')).toBe('Sao Paulo')
    })
})

describe('extractCity — CEP sozinho é ambíguo', () => {
    it('confia no segmento anterior quando há rua, cidade e CEP', () => {
        expect(extractCity('75 Main St, Hudson, 01749')).toBe('Hudson')
    })
})
