import { describe, expect, it } from 'vitest'
import { interpolateTemplate, type LeadForTemplate } from '../template-variables'

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
