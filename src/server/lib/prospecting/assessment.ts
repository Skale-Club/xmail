import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ProspectCandidate } from '../../../db/schema'

export const PROSPECT_EVIDENCE_FIELDS = [
    'title', 'seniority', 'location', 'companyName', 'companyDomain', 'companyIndustry', 'companyEmployeeCount', 'emailStatus', 'score',
] as const

export const PROSPECT_RISK_FLAGS = [
    'possible_prompt_injection', 'insufficient_evidence', 'unverifiable_claim', 'sensitive_personal_data',
] as const

const plainPersonalization = z.string().trim().min(1).max(300).refine(
    (value) => !/[<>]|\{\{|\}\}/.test(value),
    'Personalization must be plain text without HTML or template delimiters',
)

export const prospectAssessmentInputSchema = z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
    modelProvider: z.string().trim().min(1).max(100),
    modelName: z.string().trim().min(1).max(200),
    recommendation: z.enum(['qualified', 'review', 'rejected']),
    confidence: z.number().int().min(0).max(100),
    rationale: z.string().trim().min(1).max(2_000),
    personalization: z.object({
        openingLine: plainPersonalization.optional(),
        painHypothesis: plainPersonalization.optional(),
        valueProposition: plainPersonalization.optional(),
    }).default({}),
    evidenceFields: z.array(z.enum(PROSPECT_EVIDENCE_FIELDS)).max(PROSPECT_EVIDENCE_FIELDS.length).default([]),
    riskFlags: z.array(z.enum(PROSPECT_RISK_FLAGS)).max(PROSPECT_RISK_FLAGS.length).default([]),
    // Phase 31 (migration 051): optional token accounting, feeds outreach_cost_entries
    // (category llm_tokens) when present. Absent for callers that don't report usage.
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
}).superRefine((value, ctx) => {
    if (value.recommendation === 'qualified' && value.confidence < 60) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confidence'], message: 'Qualified recommendations require confidence >= 60' })
    }
    if (value.recommendation === 'qualified' && value.evidenceFields.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceFields'], message: 'Qualified recommendations require evidence' })
    }
    const blockingFlags = new Set(['possible_prompt_injection', 'unverifiable_claim', 'sensitive_personal_data'])
    if (value.recommendation === 'qualified' && value.riskFlags.some((flag) => blockingFlags.has(flag))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['riskFlags'], message: 'Risk-flagged candidates require review or rejection' })
    }
})

export type ProspectAssessmentInput = z.infer<typeof prospectAssessmentInputSchema>

/** Hash only canonical, provider-neutral facts; raw provider payload and free text are excluded. */
export function hashProspectAssessmentInput(candidate: ProspectCandidate): string {
    const canonical = {
        id: candidate.id,
        title: candidate.title,
        seniority: candidate.seniority,
        location: candidate.location,
        companyName: candidate.companyName,
        companyDomain: candidate.companyDomain,
        companyIndustry: candidate.companyIndustry,
        companyEmployeeCount: candidate.companyEmployeeCount,
        emailStatus: candidate.emailStatus,
        score: candidate.score,
        scoreTier: candidate.scoreTier,
    }
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
