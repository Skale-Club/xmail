import { describe, expect, it } from 'vitest'
import {
    interpolateTemplate,
    validateTemplate,
    validateTemplateSections,
    type LeadForTemplate,
} from '../template-variables'

function lead(overrides: Partial<LeadForTemplate> = {}): LeadForTemplate {
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
        customFields: {},
        ...overrides,
    }
}

const withFlag = (value: unknown) => lead({ customFields: { vip: value } })

describe('conditional blocks: truthiness of custom-field flags', () => {
    const template = 'A{{#vip}} yes{{/vip}}{{^vip}} no{{/vip}}.'

    it.each([
        ['true', true],
        ['"true"', 'true'],
        ['non-empty string', 'maybe'],
        ['non-zero number', 3],
    ])('treats %s as truthy', (_label, value) => {
        expect(interpolateTemplate(template, withFlag(value))).toBe('A yes.')
    })

    it.each([
        ['false', false],
        ['"false"', 'false'],
        ['empty string', ''],
        ['zero', 0],
        ['null', null],
    ])('treats %s as falsy', (_label, value) => {
        expect(interpolateTemplate(template, withFlag(value))).toBe('A no.')
    })

    it('treats a missing field and missing customFields as falsy', () => {
        expect(interpolateTemplate(template, lead())).toBe('A no.')
        expect(interpolateTemplate(template, lead({ customFields: null }))).toBe('A no.')
    })

    it('lets a built-in computed flag win over a custom field of the same name', () => {
        // location is empty so `nearby` is false, whatever the custom field claims.
        expect(interpolateTemplate('{{#nearby}}near{{/nearby}}{{^nearby}}far{{/nearby}}', lead({ customFields: { nearby: true } })))
            .toBe('far')
    })
})

describe('conditional blocks: rendering', () => {
    it('substitutes {{variables}} inside a rendered block, and drops them with a hidden one', () => {
        const template = '{{#vip}}Hi {{firstName}} at {{companyName}}.{{/vip}}'
        expect(interpolateTemplate(template, withFlag(true))).toBe('Hi Sam at Hudson Barber.')
        expect(interpolateTemplate(template, withFlag(false))).toBe('')
    })

    it('handles several independent blocks in one template', () => {
        const template = '{{#a}}A{{/a}}-{{^a}}notA{{/a}}-{{#b}}B{{/b}}'
        expect(interpolateTemplate(template, lead({ customFields: { a: true, b: false } }))).toBe('A--')
        expect(interpolateTemplate(template, lead({ customFields: { a: false, b: true } }))).toBe('-notA-B')
    })

    it('multi-line block: leaves no blank line behind when hidden, and none extra when shown', () => {
        const template = 'Hi {{firstName}},\n\n{{#vip}}\nYou are on the list.\n{{/vip}}\n\nThanks'
        expect(interpolateTemplate(template, withFlag(false))).toBe('Hi Sam,\n\nThanks')
        expect(interpolateTemplate(template, withFlag(true))).toBe('Hi Sam,\n\nYou are on the list.\n\nThanks')
    })

    it('plain text: a one-line block alone in its paragraph disappears without stray blank lines', () => {
        const template = 'Para one.\n\n{{#vip}}Only for VIPs.{{/vip}}\n\nPara two.'
        const hidden = interpolateTemplate(template, withFlag(false))
        expect(hidden).toBe('Para one.\n\nPara two.')
        expect(hidden).not.toMatch(/\n{3,}/)
        expect(interpolateTemplate(template, withFlag(true))).toBe('Para one.\n\nOnly for VIPs.\n\nPara two.')
    })

    it('plain text: tags with leading indentation and CRLF endings are still standalone', () => {
        const template = 'One\r\n  {{#vip}}\r\nTwo\r\n  {{/vip}}\r\nThree'
        expect(interpolateTemplate(template, withFlag(false))).toBe('One\r\nThree')
        expect(interpolateTemplate(template, withFlag(true))).toBe('One\r\nTwo\r\nThree')
    })

    it('HTML: a block inside a <p> leaves no empty <p></p> when hidden', () => {
        const template = '<p>One</p>\n<p>{{#vip}}Only for VIPs.{{/vip}}</p>\n<p>Two</p>'
        const hidden = interpolateTemplate(template, withFlag(false), {}, { escapeHtml: true })
        expect(hidden).toBe('<p>One</p>\n<p>Two</p>')
        expect(hidden).not.toContain('<p></p>')
        expect(interpolateTemplate(template, withFlag(true), {}, { escapeHtml: true }))
            .toBe('<p>One</p>\n<p>Only for VIPs.</p>\n<p>Two</p>')
    })

    it('HTML: a block wrapping whole paragraphs across lines leaves no empty paragraph or blank line', () => {
        const template = '<p>One</p>\n{{#vip}}\n<p>Extra {{firstName}}</p>\n{{/vip}}\n<p>Two</p>'
        expect(interpolateTemplate(template, withFlag(false))).toBe('<p>One</p>\n<p>Two</p>')
        expect(interpolateTemplate(template, withFlag(true))).toBe('<p>One</p>\n<p>Extra Sam</p>\n<p>Two</p>')
    })

    it('HTML: an inverted block with only a <br> left inside a <p> is cleaned up too', () => {
        const template = '<p>One</p>\n<p>{{^vip}}Not a VIP.{{/vip}}<br></p>\n<p>Two</p>'
        expect(interpolateTemplate(template, withFlag(true))).toBe('<p>One</p>\n<p>Two</p>')
    })

    it('tolerates spaces inside the braces', () => {
        expect(interpolateTemplate('{{ #vip }}x{{ /vip }}', withFlag(true))).toBe('x')
    })
})

describe('conditional blocks: malformed tags never reach the recipient', () => {
    it.each([
        ['unclosed section', 'A {{#vip}}B', 'A B'],
        ['stray closing tag', 'A {{/vip}}B', 'A B'],
        ['mismatched closing tag', 'A {{#vip}}B{{/other}}C', 'A BC'],
        ['nested section', '{{#vip}}A{{#other}}B{{/other}}C{{/vip}}', 'ABC'],
        ['invalid tag name', 'A {{#}}B{{#a b}}C', 'A BC'],
        ['unterminated tag', 'A {{#vip B', 'A '],
    ])('%s is stripped from the output and reported', (_label, template, rendered) => {
        const out = interpolateTemplate(template, withFlag(true))
        expect(out).not.toMatch(/\{\{\s*[#^/]/)
        expect(out).toBe(rendered)
        expect(validateTemplateSections(template).length).toBeGreaterThan(0)
    })

    it('validateTemplate reports a malformed block and marks the template invalid', () => {
        const result = validateTemplate('Hi {{firstName}} {{#vip}}oops', lead())
        expect(result.isValid).toBe(false)
        expect(result.sectionErrors).toEqual([expect.stringContaining('{{#vip}}')])
    })

    it('validateTemplate stays valid for well-formed blocks and does not mistake tags for variables', () => {
        const result = validateTemplate('{{#vip}}Hi {{firstName}}{{/vip}}{{^vip}}x{{/vip}}', lead())
        expect(result).toMatchObject({ isValid: true, missingVariables: [], sectionErrors: [] })
    })

    it('an empty or missing template has no section errors', () => {
        expect(validateTemplateSections('')).toEqual([])
        expect(validateTemplateSections(null)).toEqual([])
        expect(validateTemplateSections('plain text with {{firstName}}')).toEqual([])
    })
})

describe('conditional blocks: no template injection from lead data', () => {
    it('a lead field containing block syntax is substituted as literal text, never interpreted', () => {
        const hostile = lead({
            firstName: '{{#vip}}INJECTED{{/vip}}',
            companyName: '{{/nearby}}',
            customFields: { vip: true },
        })
        const out = interpolateTemplate('{{firstName}} | {{companyName}} | {{#nearby}}near{{/nearby}}', hostile)
        expect(out).toBe('{{#vip}}INJECTED{{/vip}} | {{/nearby}} | ')
    })

    it('lead data cannot close or open a block that the template defines', () => {
        const hostile = lead({ firstName: '{{/vip}}', customFields: { vip: false } })
        expect(interpolateTemplate('{{#vip}}hidden {{firstName}}{{/vip}}shown', hostile)).toBe('shown')
    })
})
