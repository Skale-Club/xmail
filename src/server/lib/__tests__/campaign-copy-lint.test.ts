import { describe, expect, it } from 'vitest'
import { lintCampaignCopy } from '../campaign-copy-lint'

const codes = (fields: Parameters<typeof lintCampaignCopy>[0]) =>
    lintCampaignCopy(fields).map((warning) => `${warning.field}:${warning.code}`)

describe('lintCampaignCopy', () => {
    it('returns nothing for clean copy', () => {
        expect(lintCampaignCopy({
            subject: 'Quick question about {{companyName}}',
            plainBody: 'Hi {{firstName}},\n\nWe answer the phone for barbershops.\n\n{{unsubscribeUrl}}',
            htmlBody: '<p>Hi {{firstName}},</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>',
        })).toEqual([])
    })

    it('skips fields that are missing, null or empty', () => {
        expect(lintCampaignCopy({ subject: null, plainBody: undefined, htmlBody: '' })).toEqual([])
        expect(lintCampaignCopy({})).toEqual([])
    })

    it('flags an em dash and an en dash', () => {
        expect(codes({ subject: 'Barbershops — a quick idea' })).toEqual(['subject:dash_character'])
        expect(codes({ plainBody: 'Open 9–5 every day' })).toEqual(['plainBody:dash_character'])
    })

    it('flags dash entities in HTML but not a hyphen', () => {
        expect(codes({ htmlBody: '<p>Fast &mdash; reliable</p>' })).toEqual(['htmlBody:dash_character'])
        expect(codes({ htmlBody: '<p>Fast &#8211; reliable</p>' })).toEqual(['htmlBody:dash_character'])
        expect(codes({ plainBody: 'Follow-up on our last email - short one' })).toEqual([])
    })

    it('ignores a dash that only exists inside an HTML attribute', () => {
        expect(codes({ htmlBody: '<a href="https://example.com/a–b">link</a>' })).toEqual([])
    })

    it('flags the "Hi there" greeting, case-insensitively', () => {
        expect(codes({ plainBody: 'Hi there,\n\nA quick note.' })).toEqual(['plainBody:greeting_hi_there'])
        expect(codes({ plainBody: 'hi   THERE, a quick note' })).toEqual(['plainBody:greeting_hi_there'])
        expect(codes({ plainBody: 'Hi {{firstName}}, there is a quick note.' })).toEqual([])
    })

    it('flags tech and technology as whole words only', () => {
        expect(codes({ plainBody: 'Our tech does the work' })).toEqual(['plainBody:banned_word_tech'])
        expect(codes({ subject: 'Technology for barbershops' })).toEqual(['subject:banned_word_tech'])
        expect(codes({ plainBody: 'We build a fintech and a technician portal' })).toEqual([])
    })

    it('does not read HTML class names as copy', () => {
        expect(codes({ htmlBody: '<p class="tech">Plain copy</p>' })).toEqual([])
    })

    it('flags a postal street address but not a bare street mention', () => {
        expect(codes({ plainBody: 'Skale Club, 123 Main Street, Smyrna, DE 19977' })).toEqual(['plainBody:postal_address'])
        expect(codes({ htmlBody: '<p>100 Market St<br>Wilmington, DE 19801</p>' })).toEqual(['htmlBody:postal_address'])
        expect(codes({ plainBody: 'We just opened an office on Main Street' })).toEqual([])
    })

    it('reports every rule that fires, per field, with short excerpts', () => {
        const warnings = lintCampaignCopy({
            subject: 'Tech for you',
            plainBody: 'Hi there — we run technology for shops.',
        })
        expect(warnings.map((warning) => `${warning.field}:${warning.code}`).sort()).toEqual([
            'plainBody:banned_word_tech',
            'plainBody:dash_character',
            'plainBody:greeting_hi_there',
            'subject:banned_word_tech',
        ])
        const dash = warnings.find((warning) => warning.code === 'dash_character')
        expect(dash?.matches?.[0]).toContain('—')
        expect(dash?.matches?.[0].length).toBeLessThanOrEqual(60)
    })

    it('caps the number of excerpts per rule', () => {
        const warnings = lintCampaignCopy({ plainBody: 'a — b — c — d — e — f' })
        expect(warnings).toHaveLength(1)
        expect(warnings[0].matches).toHaveLength(3)
    })
})
