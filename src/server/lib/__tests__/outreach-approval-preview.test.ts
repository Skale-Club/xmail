import { describe, expect, it, vi } from 'vitest'

// This suite only exercises the PURE helpers (bucketRawEmailStatus, summarizeLeadVerification,
// renderCampaignPreviewSequence) — never the DB-touching buildCampaignActivationPreview. But the
// module itself imports `db` (and, transitively via getCanonicalSequence/generateUnsubscribeLink,
// a few more db-backed modules) at the top level, and `../../../db` throws at import time without
// a configured DATABASE_URL. Mock it out, mirroring mx-guard.connect-rate.test.ts. The unsubscribe
// route module also throws at import time without ENCRYPTION_KEY/JWT_SECRET (outreach-tokens.ts),
// so it needs the same treatment.
vi.mock('../../../db', () => ({ db: {} }))
vi.mock('../../routes/outreach/unsubscribe', () => ({ generateUnsubscribeLink: vi.fn() }))

import {
    bucketRawEmailStatus,
    renderCampaignPreviewSequence,
    summarizeLeadVerification,
} from '../outreach-approval-preview'
import { interpolateTemplate, type LeadForTemplate } from '../template-variables'

describe('bucketRawEmailStatus', () => {
    it('buckets email_status: ok as verified', () => {
        expect(bucketRawEmailStatus({ email_status: 'ok' })).toBe('verified')
    })

    it('buckets email_status: catch_all as catchAll (distinct from the mapped "likely" column)', () => {
        expect(bucketRawEmailStatus({ email_status: 'catch_all' })).toBe('catchAll')
    })

    it('buckets a literal "unknown" status, a missing field, and any other value as unknown', () => {
        expect(bucketRawEmailStatus({ email_status: 'unknown' })).toBe('unknown')
        expect(bucketRawEmailStatus({})).toBe('unknown')
        expect(bucketRawEmailStatus(null)).toBe('unknown')
        expect(bucketRawEmailStatus(undefined)).toBe('unknown')
        expect(bucketRawEmailStatus({ email_status: 'invalid' })).toBe('unknown')
        expect(bucketRawEmailStatus('not-an-object')).toBe('unknown')
    })
})

describe('summarizeLeadVerification', () => {
    it('aggregates a mixed set of leads into the three-way split plus total', () => {
        const result = summarizeLeadVerification([
            { email_status: 'ok' },
            { email_status: 'ok' },
            { email_status: 'catch_all' },
            { email_status: 'unknown' },
            {},
        ])

        expect(result).toEqual({ total: 5, verified: 2, catchAll: 1, unknown: 2 })
    })

    it('returns all zeros for an empty enrollment', () => {
        expect(summarizeLeadVerification([])).toEqual({ total: 0, verified: 0, catchAll: 0, unknown: 0 })
    })
})

function lead(overrides: Partial<LeadForTemplate> = {}): LeadForTemplate {
    return {
        email: 'jane@acme.com',
        firstName: 'Jane',
        lastName: 'Doe',
        companyName: 'Acme Corp',
        companySize: null,
        industry: null,
        title: null,
        website: null,
        linkedinUrl: null,
        phone: null,
        location: null,
        customFields: {},
        ...overrides,
    }
}

describe('renderCampaignPreviewSequence', () => {
    it('substitutes a real lead\'s values and the real unsubscribe URL', () => {
        const steps = [{
            stepOrder: 1,
            type: 'email',
            delayHours: 0,
            subject: 'Hi {{firstName}} from {{companyName}}',
            plainBody: 'Hello {{firstName}}, unsubscribe here: {{unsubscribeUrl}}',
            htmlBody: null,
            subjectB: null,
            plainBodyB: null,
            htmlBodyB: null,
            abTestEnabled: false,
        }]

        const [rendered] = renderCampaignPreviewSequence(steps, lead(), {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered.variantA.subject).toBe('Hi Jane from Acme Corp')
        expect(rendered.variantA.bodyPlain).toBe('Hello Jane, unsubscribe here: https://mail.skale.club/o/u/tok123')
        expect(rendered.variantB).toBeNull()
    })

    it('renders both A/B variants and labels them, when A/B testing is on', () => {
        const steps = [{
            stepOrder: 1,
            type: 'email',
            delayHours: 24,
            subject: 'Subject A for {{firstName}}',
            plainBody: 'Body A',
            htmlBody: null,
            subjectB: 'Subject B for {{firstName}}',
            plainBodyB: 'Body B',
            htmlBodyB: null,
            abTestEnabled: true,
        }]

        const [rendered] = renderCampaignPreviewSequence(steps, lead(), {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered.variantA.subject).toBe('Subject A for Jane')
        expect(rendered.variantB).not.toBeNull()
        expect(rendered.variantB?.subject).toBe('Subject B for Jane')
    })

    it('skips non-email steps (delay/condition)', () => {
        const steps = [
            {
                stepOrder: 1,
                type: 'delay',
                delayHours: 48,
                subject: null,
                plainBody: null,
                htmlBody: null,
                subjectB: null,
                plainBodyB: null,
                htmlBodyB: null,
                abTestEnabled: false,
            },
            {
                stepOrder: 2,
                type: 'email',
                delayHours: 0,
                subject: 'Follow-up',
                plainBody: 'Body',
                htmlBody: null,
                subjectB: null,
                plainBodyB: null,
                htmlBodyB: null,
                abTestEnabled: false,
            },
        ]

        const rendered = renderCampaignPreviewSequence(steps, lead(), {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered).toHaveLength(1)
        expect(rendered[0].stepOrder).toBe(2)
    })

    // Fase 45 — o card de aprovação (buildCampaignActivationPreview → renderCampaignPreviewSequence)
    // e o envio real (outreach-sender.ts::sendOutreachEmail) chamam a mesma `interpolateTemplate`,
    // então o corpo sem `{{websiteInsight}}` (maioria dos leads da campanha piloto de barbearias,
    // sem website) precisa aparecer aqui EXATAMENTE como sairia no e-mail: sem o buraco de linhas
    // em branco que existia antes do colapso em template-variables.ts.
    it('mostra o corpo do passo 1 da campanha piloto de barbearias sem o buraco de linhas em branco quando falta o insight', () => {
        const plainBody = `Hi,

I came across {{companyName}} while looking at independent barbershops around {{city}}.

{{websiteInsight}}

We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.

Would you be open to a quick 10-minute conversation to see if this could help {{companyName}}?

Vanildo de Souza Jr
Skale Club LLC
skale.club

This is a business outreach from Skale Club.
To stop receiving these emails: {{unsubscribeUrl}}`

        const steps = [{
            stepOrder: 1,
            type: 'email',
            delayHours: 0,
            subject: 'Quick question about {{companyName}}',
            plainBody,
            htmlBody: null,
            subjectB: null,
            plainBodyB: null,
            htmlBodyB: null,
            abTestEnabled: false,
        }]

        const noWebsiteLead = lead({
            companyName: 'Hudson Barbershop',
            location: 'Hudson, MA',
            customFields: {}, // sem websiteInsights — o caso comum (50–80% da base)
        })

        const [rendered] = renderCampaignPreviewSequence(steps, noWebsiteLead, {
            unsubscribeUrl: 'https://mail.skale.club/o/u/tok123',
            contentLanguage: 'en',
        })

        expect(rendered.variantA.bodyPlain).not.toMatch(/\n{3,}/)
        expect(rendered.variantA.bodyPlain).toBe(`Hi,

I came across Hudson Barbershop while looking at independent barbershops around Hudson.

We help barbershops avoid missed calls with an AI receptionist that answers 24/7, handles common questions, and books or reschedules appointments using the calendar they already have.

Would you be open to a quick 10-minute conversation to see if this could help Hudson Barbershop?

Vanildo de Souza Jr
Skale Club LLC
skale.club

This is a business outreach from Skale Club.
To stop receiving these emails: https://mail.skale.club/o/u/tok123`)
    })
})
describe('renderCampaignPreviewSequence: conditional blocks match what the send path renders', () => {
    const subject = 'Hi {{firstName}}{{#nearby}} (neighbor){{/nearby}}'
    const plain = 'Hello {{firstName}},\n\n{{#nearby}}\nI am just down the road.\n{{/nearby}}\n\nUnsubscribe: {{unsubscribeUrl}}'
    const html = '<p>Hello {{firstName}}</p>\n<p>{{#hookNoOnlineBooking}}Your site has no online booking.{{/hookNoOnlineBooking}}</p>\n<p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>'
    const context = { unsubscribeUrl: 'https://mail.skale.club/o/u/tok123', contentLanguage: 'en' }
    const steps = [{
        stepOrder: 1,
        type: 'email',
        delayHours: 0,
        subject,
        plainBody: plain,
        htmlBody: html,
        subjectB: null,
        plainBodyB: null,
        htmlBodyB: null,
        abTestEnabled: false,
    }]

    it.each([
        ['a nearby lead with its own site and no booking', lead({ location: '8 Hyde Park Ave, Boston, MA 02116', customFields: { has_owned_website: true } })],
        ['a far lead that has a booking platform', lead({ location: '5 Route 134, South Dennis, MA 02660', customFields: { has_owned_website: true, booking_platform: 'Booksy' } })],
    ])('preview output equals interpolateTemplate output for %s', (_label, subjectLead) => {
        const [rendered] = renderCampaignPreviewSequence(steps, subjectLead, context)

        // The exact calls outreach-sender.ts makes: plain/subject unescaped, HTML escaped.
        expect(rendered.variantA.subject).toBe(interpolateTemplate(subject, subjectLead, context))
        expect(rendered.variantA.bodyPlain).toBe(interpolateTemplate(plain, subjectLead, context))
        expect(rendered.variantA.bodyHtml).toBe(interpolateTemplate(html, subjectLead, context, { escapeHtml: true }))
    })

    it('actually renders the blocks (not just equal garbage)', () => {
        const near = lead({ location: '8 Hyde Park Ave, Boston, MA 02116', customFields: { has_owned_website: true } })
        const [rendered] = renderCampaignPreviewSequence(steps, near, context)
        expect(rendered.variantA.subject).toBe('Hi Jane (neighbor)')
        expect(rendered.variantA.bodyPlain).toBe('Hello Jane,\n\nI am just down the road.\n\nUnsubscribe: https://mail.skale.club/o/u/tok123')
        expect(rendered.variantA.bodyHtml).toContain('Your site has no online booking.')

        const far = lead({ location: '5 Route 134, South Dennis, MA 02660', customFields: { has_owned_website: true, booking_platform: 'Booksy' } })
        const [hidden] = renderCampaignPreviewSequence(steps, far, context)
        expect(hidden.variantA.subject).toBe('Hi Jane')
        expect(hidden.variantA.bodyPlain).toBe('Hello Jane,\n\nUnsubscribe: https://mail.skale.club/o/u/tok123')
        expect(hidden.variantA.bodyHtml).not.toContain('<p></p>')
    })
})
