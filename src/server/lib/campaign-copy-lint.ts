import { containsPhysicalPostalAddress } from './outreach-campaign-compliance'

/**
 * Copy lint for campaign steps edited through the Hermes gateway
 * (`PUT /api/agent/outreach/campaigns/:id/sequence/steps/:stepOrder`).
 *
 * Warnings only, never blocks: these are the owner's style rules (2026-10-07), not compliance
 * gates. The compliance gates (`{{unsubscribeUrl}}`, malformed template blocks) live in
 * `validateSequenceForActivation` and DO block. The agent is expected to surface every warning
 * to Vanildo together with the before/after text.
 *
 * Pure and DB-free so it can be tested directly.
 */

export const COPY_LINT_FIELDS = ['subject', 'plainBody', 'htmlBody'] as const
export type CopyLintField = typeof COPY_LINT_FIELDS[number]

export type CopyLintCode =
    | 'dash_character'
    | 'greeting_hi_there'
    | 'banned_word_tech'
    | 'postal_address'

export interface CopyLintWarning {
    code: CopyLintCode
    field: CopyLintField
    message: string
    /** Short excerpts of what matched (at most 3), for the report to the owner. */
    matches?: string[]
}

const MAX_MATCHES = 3
const EXCERPT_RADIUS = 20

// Em dash, en dash, and their HTML entity spellings (named, decimal and hex).
const DASH_RE = /[—–]|&mdash;|&ndash;|&#8212;|&#8211;|&#x2014;|&#x2013;/gi
const HI_THERE_RE = /\bhi\s+there\b/gi
// `tech` and `technology` as whole words; `technologies`, `fintech` and friends do not match.
const TECH_RE = /\b(?:tech|technology)\b/gi

function stripMarkup(text: string): string {
    return text.replace(/<[^>]+>/g, ' ')
}

function excerpts(text: string, pattern: RegExp): string[] {
    const found: string[] = []
    for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0
        const start = Math.max(0, index - EXCERPT_RADIUS)
        const end = Math.min(text.length, index + match[0].length + EXCERPT_RADIUS)
        found.push(text.slice(start, end).replace(/\s+/g, ' ').trim())
        if (found.length >= MAX_MATCHES) break
    }
    return found
}

function lintField(field: CopyLintField, raw: string): CopyLintWarning[] {
    const warnings: CopyLintWarning[] = []
    // Word and dash checks read visible text only: a dash inside an href or the word "tech" in a
    // class name is not copy. Entities are left in place so DASH_RE can still see `&mdash;`.
    const text = field === 'htmlBody' ? stripMarkup(raw) : raw

    const dashes = excerpts(text, DASH_RE)
    if (dashes.length > 0) {
        warnings.push({
            code: 'dash_character',
            field,
            message: `${field} contains an em dash or en dash. Rewrite the sentence without it.`,
            matches: dashes,
        })
    }

    const greetings = excerpts(text, HI_THERE_RE)
    if (greetings.length > 0) {
        warnings.push({
            code: 'greeting_hi_there',
            field,
            message: `${field} opens with the generic greeting "Hi there". Use the first name or no greeting.`,
            matches: greetings,
        })
    }

    const techWords = excerpts(text, TECH_RE)
    if (techWords.length > 0) {
        warnings.push({
            code: 'banned_word_tech',
            field,
            message: `${field} uses the word "tech" or "technology". Say what the product does instead.`,
            matches: techWords,
        })
    }

    if (containsPhysicalPostalAddress(raw)) {
        warnings.push({
            code: 'postal_address',
            field,
            message: `${field} appears to contain a postal street address. No physical address goes in emails.`,
        })
    }

    return warnings
}

/**
 * Lint the given copy fields. Fields that are null, undefined or empty are skipped, so callers can
 * pass just the fields an edit touched.
 */
export function lintCampaignCopy(
    fields: Partial<Record<CopyLintField, string | null | undefined>>,
): CopyLintWarning[] {
    return COPY_LINT_FIELDS.flatMap((field) => {
        const value = fields[field]
        return typeof value === 'string' && value.length > 0 ? lintField(field, value) : []
    })
}
