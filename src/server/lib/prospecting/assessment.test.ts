import { describe, expect, it } from 'vitest'
import { prospectAssessmentInputSchema } from './assessment'

const valid = {
    idempotencyKey: 'assessment-1',
    modelProvider: 'kimi-coding',
    modelName: 'kimi-for-coding',
    recommendation: 'qualified' as const,
    confidence: 85,
    rationale: 'The role, seniority and company segment match the configured ICP.',
    personalization: { openingLine: 'Your team appears to be scaling its sales operation.' },
    evidenceFields: ['title', 'seniority', 'companyIndustry'] as const,
    riskFlags: [] as const,
}

describe('Hermes prospect assessment guardrails', () => {
    it('accepts a bounded evidence-backed advisory assessment', () => {
        expect(prospectAssessmentInputSchema.parse(valid)).toMatchObject({ recommendation: 'qualified', confidence: 85 })
    })

    it('rejects confident qualification without evidence', () => {
        expect(() => prospectAssessmentInputSchema.parse({ ...valid, evidenceFields: [] })).toThrow('require evidence')
    })

    it('forces prompt-injection and sensitive-data risks out of qualified state', () => {
        for (const riskFlag of ['possible_prompt_injection', 'sensitive_personal_data']) {
            expect(() => prospectAssessmentInputSchema.parse({ ...valid, riskFlags: [riskFlag] })).toThrow('require review or rejection')
        }
    })

    it('rejects HTML and template delimiters in personalization fields', () => {
        expect(() => prospectAssessmentInputSchema.parse({
            ...valid,
            personalization: { openingLine: '<script>alert(1)</script>' },
        })).toThrow('plain text')
        expect(() => prospectAssessmentInputSchema.parse({
            ...valid,
            personalization: { openingLine: '{{system.prompt}}' },
        })).toThrow('plain text')
    })

    it('allows low-confidence results only as review/rejected proposals', () => {
        expect(prospectAssessmentInputSchema.parse({ ...valid, recommendation: 'review', confidence: 20 }))
            .toMatchObject({ recommendation: 'review', confidence: 20 })
    })
})
