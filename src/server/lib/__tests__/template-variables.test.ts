import { describe, expect, it } from 'vitest'
import { extractCity, interpolateTemplate, shortenCompanyName, type LeadForTemplate } from '../template-variables'

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

describe('extractCity — endereço com o país no fim (imports do Xphere desde 2026-10-07)', () => {
    it('ignora ", United States" e variações', () => {
        expect(extractCity('1267 Washington St, West Newton, MA 02465, United States')).toBe('West Newton')
        expect(extractCity('286 Centre St, Newton, MA 02458, USA')).toBe('Newton')
        expect(extractCity('150 California St Ste 108, Newton, MA 02458, US')).toBe('Newton')
        expect(extractCity('United States')).toBe('')
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

// Fase 45 — campanha "Barbershops - AI Receptionist - Pilot 01", passo 1 (sequence_steps em
// produção). {{websiteInsight}} fica sozinho em seu próprio parágrafo/<p>, e entre 50% e 80%
// dos leads da base não têm `websiteInsights` — sem o colapso em `collapseEmptyParagraphs`
// (template-variables.ts), a maioria dos e-mails saía com um buraco de linhas em branco no
// meio do corpo. Estes testes afirmam sobre a string final renderizada, exatamente como
// `outreach-sender.ts` (envio) e `outreach-approval-preview.ts` (preview de aprovação) a
// produzem — ambos chamam apenas `interpolateTemplate`.
describe('corpo renderizado — passo 1 da campanha piloto de barbearias (Fase 45)', () => {
    const PLAIN_BODY = `Hi,

I came across {{companyName}} while looking at independent barbershops around {{city}}.

{{websiteInsight}}

We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.

Would you be open to a quick 10-minute conversation to see if this could help {{companyName}}?

Vanildo de Souza Jr
Skale Club LLC
skale.club

This is a business outreach from Skale Club.
To stop receiving these emails: {{unsubscribeUrl}}`

    // HTML equivalente do mesmo corpo (um <p> por parágrafo) — o formato real do html_body da
    // campanha não foi lido em produção (fora de escopo: seria SELECT no banco de prod), mas o
    // comportamento exigido — <p> vazio some por completo — é o mesmo independente do markup
    // exato, e este é a estrutura padrão de um corpo de outreach convertido para HTML.
    const HTML_BODY = `<p>Hi,</p>
<p>I came across {{companyName}} while looking at independent barbershops around {{city}}.</p>
<p>{{websiteInsight}}</p>
<p>We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.</p>
<p>Would you be open to a quick 10-minute conversation to see if this could help {{companyName}}?</p>
<p>Vanildo de Souza Jr<br>Skale Club LLC<br>skale.club</p>
<p>This is a business outreach from Skale Club.<br>To stop receiving these emails: {{unsubscribeUrl}}</p>`

    function barbershopLead(customFields: Record<string, unknown>): LeadForTemplate {
        return {
            email: 'owner@hudsonbarbershop.test',
            firstName: null,
            lastName: null,
            companyName: 'Hudson Barbershop',
            companySize: null,
            industry: null,
            title: null,
            website: null,
            linkedinUrl: null,
            phone: null,
            location: 'Hudson, MA',
            customFields,
        }
    }

    const context = { unsubscribeUrl: 'https://mail.skale.club/o/u/tok123', contentLanguage: 'en' }

    it('texto puro — com insight, o parágrafo do insight aparece com espaçamento normal', () => {
        const rendered = interpolateTemplate(
            PLAIN_BODY,
            barbershopLead({ websiteInsights: { en: 'I noticed your booking page loads slowly on mobile.' } }),
            context,
        )

        expect(rendered).toBe(`Hi,

I came across Hudson Barbershop while looking at independent barbershops around Hudson.

I noticed your booking page loads slowly on mobile.

We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.

Would you be open to a quick 10-minute conversation to see if this could help Hudson Barbershop?

Vanildo de Souza Jr
Skale Club LLC
skale.club

This is a business outreach from Skale Club.
To stop receiving these emails: https://mail.skale.club/o/u/tok123`)
    })

    it('texto puro — sem insight, o parágrafo some e sobra só UMA linha em branco', () => {
        const rendered = interpolateTemplate(PLAIN_BODY, barbershopLead({}), context)

        // O ponto central do bug: "...around Hudson.\n\nWe help..." com uma única linha em
        // branco — nunca "\n\n\n\n" (o buraco) nem "\n" (parágrafos colados sem separador).
        expect(rendered).toContain('around Hudson.\n\nWe help barbershops')
        expect(rendered).not.toMatch(/\n{3,}/)

        expect(rendered).toBe(`Hi,

I came across Hudson Barbershop while looking at independent barbershops around Hudson.

We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.

Would you be open to a quick 10-minute conversation to see if this could help Hudson Barbershop?

Vanildo de Souza Jr
Skale Club LLC
skale.club

This is a business outreach from Skale Club.
To stop receiving these emails: https://mail.skale.club/o/u/tok123`)
    })

    it('HTML — com insight, o <p> do insight aparece normalmente', () => {
        const rendered = interpolateTemplate(
            HTML_BODY,
            barbershopLead({ websiteInsights: { en: 'I noticed your booking page loads slowly on mobile.' } }),
            context,
            { escapeHtml: true },
        )

        expect(rendered).toContain('<p>I noticed your booking page loads slowly on mobile.</p>')
    })

    it('HTML — sem insight, o <p> vazio some por completo (sem linha/parágrafo fantasma)', () => {
        const rendered = interpolateTemplate(HTML_BODY, barbershopLead({}), context, { escapeHtml: true })

        expect(rendered).not.toContain('<p></p>')
        expect(rendered).not.toMatch(/<p>\s*<\/p>/)
        expect(rendered).toBe(`<p>Hi,</p>
<p>I came across Hudson Barbershop while looking at independent barbershops around Hudson.</p>
<p>We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.</p>
<p>Would you be open to a quick 10-minute conversation to see if this could help Hudson Barbershop?</p>
<p>Vanildo de Souza Jr<br>Skale Club LLC<br>skale.club</p>
<p>This is a business outreach from Skale Club.<br>To stop receiving these emails: https://mail.skale.club/o/u/tok123</p>`)
    })

    it('não mexe em variável no meio de frase: {{city}} vazio (sem endereço decifrável) fica vazio, não colapsa a linha', () => {
        const rendered = interpolateTemplate(
            PLAIN_BODY,
            { ...barbershopLead({}), location: 'not-a-decipherable-address' },
            context,
        )

        // {{city}} está no meio da frase — vazio ali é vazio (a regra explícita da Fase 45),
        // a linha inteira não deve ser removida.
        expect(rendered).toContain('independent barbershops around .')
    })
})

describe('shortenCompanyName — nome curto da loja para a saudação', () => {
    it('tira o descritor do fim quando sobra um nome que se sustenta sozinho', () => {
        expect(shortenCompanyName('Boston Blendz Barbershop')).toBe('Boston Blendz')
        expect(shortenCompanyName("Danny's Barber Shop")).toBe("Danny's")
        expect(shortenCompanyName('Always Faded Barber Studio')).toBe('Always Faded')
        expect(shortenCompanyName('Los Magicos Barber Shop & Beauty Supply')).toBe('Los Magicos')
        expect(shortenCompanyName("Collotta's Barber Shop and Hair Styling")).toBe("Collotta's")
    })

    it('devolve o nome inteiro quando o descritor não está no fim ou o corte comeria o nome', () => {
        expect(shortenCompanyName('Barbershop Deluxe')).toBe('Barbershop Deluxe')
        expect(shortenCompanyName('The Barbery')).toBe('The Barbery')
        expect(shortenCompanyName('The Barbershop')).toBe('The Barbershop')
        expect(shortenCompanyName('Barbershop')).toBe('Barbershop')
    })

    it('nunca devolve vazio para nome preenchido e devolve vazio para nome ausente', () => {
        expect(shortenCompanyName(null)).toBe('')
        expect(shortenCompanyName('  ')).toBe('')
    })
})

describe('{{shortName}} — custom_fields.shortName manda; fallback é o nome encurtado', () => {
    it('usa o shortName editorial quando gravado no lead', () => {
        expect(interpolateTemplate('Hi {{shortName}},', lead({ shortName: 'Boston Blendz' }))).toBe('Hi Boston Blendz,')
    })

    it('encurta companyName quando o lead não tem shortName', () => {
        const l = { ...lead({}), companyName: 'Boston Blendz Barbershop' }
        expect(interpolateTemplate('Hi {{shortName}},', l)).toBe('Hi Boston Blendz,')
    })

    it('cai para "there" quando não há nome nenhum', () => {
        const l = { ...lead({ shortName: '' }), companyName: null }
        expect(interpolateTemplate('Hi {{shortName}},', l)).toBe('Hi there,')
    })
})
